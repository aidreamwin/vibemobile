/**
 * WebSocket hub: fans normalized AgentEvents out to browser clients and routes
 * client commands back into the provider.
 *
 * The browser only ever speaks the ClientMessage/ServerMessage protocol from
 * @vibemobile/protocol — it has no idea Codex or Claude exist.
 */
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { AgentEvent, ApprovalRequest, ClientRequest, ServerMessage } from '@vibemobile/protocol'
import { verifySession, COOKIE_NAME } from '../auth/jwt.js'
import type { Config } from '../config.js'
import { registry } from '../providers/registry.js'
import { UnknownApprovalError, type AgentProvider } from '../providers/types.js'

interface Client {
  socket: WebSocket
  /** Threads this client wants events for. */
  subscribed: Set<string>
  alive: boolean
}

/**
 * Events worth pushing to every client regardless of subscription.
 *
 * `approval.resolved` belongs here for a reason that is easy to miss: the
 * REQUEST is global, so a client subscribed to nothing still sees the sheet —
 * but if only the resolution were filtered by subscription, that client would
 * be stuck with a sheet it can never dismiss, and its only escape would be a
 * reload. The two halves of an approval have to travel together.
 */
function isGlobal(event: AgentEvent): boolean {
  return event.kind === 'session.status' || event.kind === 'approval.requested' || event.kind === 'approval.resolved'
}

export function registerHub(app: FastifyInstance, config: Config): void {
  const clients = new Set<Client>()

  /**
   * Approvals awaiting an answer, and who to ask for each.
   *
   * Kept here rather than read back from the providers so the hub can answer
   * the two questions it actually has: "what should a client that just
   * connected be told about?" and "which provider do I forward this decision
   * to?" — the latter matters because `answerApproval` carries no thread id,
   * only the approval's own id.
   */
  const approvals = {
    pending: new Map<string, ApprovalRequest>(),
    owner: new Map<string, string>(),
  }

  const send = (client: Client, message: ServerMessage) => {
    if (client.socket.readyState !== 1) return
    try {
      client.socket.send(JSON.stringify(message))
    } catch {
      /* socket died mid-send; the close handler will clean up */
    }
  }

  const broadcast = (event: AgentEvent) => {
    if (event.kind === 'approval.requested') {
      approvals.pending.set(event.approval.requestId, event.approval)
    } else if (event.kind === 'approval.resolved') {
      approvals.pending.delete(event.requestId)
      approvals.owner.delete(event.requestId)
    }
    for (const client of clients) {
      if (isGlobal(event) || client.subscribed.has(threadIdOf(event))) {
        send(client, { type: 'event', event })
      }
    }
  }

  /**
   * Abandon an approval that can no longer be answered, and tell everyone.
   *
   * Deleting the entry alone is not enough, and that is the whole point of this
   * function. The sheet on screen only closes on `approval.resolved`, and every
   * new connection is served `approvals.pending` — so an entry that is merely
   * deleted leaves the phone holding a sheet it can never dismiss, and hands
   * the same sheet to the next client that connects. Delete and broadcast have
   * to happen together, which is why they are not spelled out at the call
   * sites.
   *
   * The thread id comes off the stored request rather than from the caller: the
   * `answerApproval` message carries only the approval's own id.
   */
  const discardApproval = (requestId: string): void => {
    const approval = approvals.pending.get(requestId)
    if (!approval) return
    // `broadcast` does the deleting, for both `pending` and `owner`.
    broadcast({ kind: 'approval.resolved', threadId: approval.threadId, requestId })
  }

  // One provider subscription per provider, fanned out to all clients.
  const unsubscribeByProvider = new Map<string, () => void>()
  const wireProvider = (provider: AgentProvider) => {
    if (unsubscribeByProvider.has(provider.id)) return
    unsubscribeByProvider.set(
      provider.id,
      provider.subscribe((event) => {
        // Every event names its thread, so this is where the routing index
        // learns about sessions nobody has listed — a turn started from
        // another device, say.
        registry.bind(provider.id, threadIdOf(event))
        if (event.kind === 'approval.requested') {
          approvals.owner.set(event.approval.requestId, provider.id)
        }
        broadcast(event)
      }),
    )
    app.log.info({ provider: provider.id }, 'hub attached to provider')
  }

  for (const provider of registry.list()) wireProvider(provider)

  // ---- liveness ----
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate()
        clients.delete(client)
        continue
      }
      client.alive = false
      try {
        client.socket.ping()
      } catch {
        /* ignored */
      }
    }
  }, 30_000)
  heartbeat.unref?.()

  app.addHook('onClose', async () => {
    clearInterval(heartbeat)
    for (const unsub of unsubscribeByProvider.values()) unsub()
    for (const client of clients) client.socket.close()
    clients.clear()
  })

  // ------------------------------------------------------------- endpoint

  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!config.authDisabled) {
      const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE_NAME]
      if (!verifySession(config, token)) {
        socket.close(4401, 'unauthorized')
        return
      }
    }

    const client: Client = { socket, subscribed: new Set(), alive: true }
    clients.add(client)

    socket.on('pong', () => {
      client.alive = true
    })

    socket.on('close', () => clients.delete(client))
    socket.on('error', () => clients.delete(client))

    send(client, { type: 'hello', subscribed: [] })

    // Replay anything still blocked on a human. Without this, reloading the
    // page mid-approval loses the sheet: the turn is still suspended inside
    // `canUseTool` waiting for an answer nobody can now give, and the session
    // sits in "waiting for approval" forever. Replayed as ordinary events so
    // the client's existing reducer handles them; it dedupes by requestId, so
    // a client that already had the sheet is unaffected.
    for (const approval of approvals.pending.values()) {
      send(client, { type: 'event', event: { kind: 'approval.requested', approval } })
    }

    socket.on('message', (raw: Buffer) => {
      let msg: ClientRequest
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        send(client, { type: 'nack', requestId: '', ok: false, error: 'malformed JSON' })
        return
      }
      handleClientMessage(app, client, msg, send, approvals, discardApproval).catch((err) => {
        send(client, {
          type: 'nack',
          requestId: msg.clientRequestId ?? '',
          ok: false,
          error: (err as Error).message,
        })
      })
    })
  })
}

function threadIdOf(event: AgentEvent): string {
  if (event.kind === 'approval.requested') return event.approval.threadId
  if (event.kind === 'error') return event.threadId ?? ''
  return (event as { threadId: string }).threadId ?? ''
}

async function handleClientMessage(
  app: FastifyInstance,
  client: Client,
  msg: ClientRequest,
  send: (client: Client, message: ServerMessage) => void,
  approvals: { pending: Map<string, ApprovalRequest>; owner: Map<string, string> },
  discardApproval: (requestId: string) => void,
): Promise<void> {
  // The id must be the one the client sent — echoing a literal command name
  // here would leave the client waiting on a reply it can never match. It is
  // read from `clientRequestId`, not `requestId`: the latter belongs to the
  // `answerApproval` payload and holds the id of the approval being answered.
  const reply = (data?: unknown) => send(client, { type: 'ack', requestId: msg.clientRequestId ?? '', ok: true, data })

  switch (msg.type) {
    case 'ping':
      send(client, { type: 'pong' })
      return

    case 'subscribe': {
      client.subscribed.add(msg.threadId)
      // Ensure the backend is actually streaming for this thread; for Codex
      // that re-establishes a server-side subscription after an app-server
      // restart, and for both providers it replays a turn that is still
      // running — which is how a reloaded page gets the live turn back.
      const provider = await registry.forSession(msg.threadId)
      if (provider) {
        await provider.resumeSession(msg.threadId).catch((err) => {
          app.log.warn({ err, threadId: msg.threadId }, 'resume on subscribe failed')
        })
      }
      reply()
      return
    }

    case 'unsubscribe':
      client.subscribed.delete(msg.threadId)
      reply()
      return

    case 'startTurn': {
      const provider = await registry.forSession(msg.threadId)
      if (!provider) throw new Error('no provider available')
      const { turnId } = await provider.startTurn(msg.threadId, msg.input, {
        model: msg.model,
        effort: msg.effort,
        approvalPolicy: msg.approvalPolicy,
        sandbox: msg.sandbox,
      })
      client.subscribed.add(msg.threadId)
      reply({ turnId })
      return
    }

    case 'steer': {
      const provider = await registry.forSession(msg.threadId)
      if (!provider) throw new Error('no provider available')
      await provider.steer(msg.threadId, msg.turnId, msg.input)
      reply()
      return
    }

    case 'interrupt': {
      const provider = await registry.forSession(msg.threadId)
      if (!provider) throw new Error('no provider available')
      await provider.interrupt(msg.threadId, msg.turnId)
      reply()
      return
    }

    case 'answerApproval': {
      // Routed by owner rather than by thread: the message carries only the
      // approval's id, and it may answer a request for a session this client
      // never subscribed to — approvals are broadcast globally on purpose.
      const ownerId = approvals.owner.get(msg.requestId)
      const provider = ownerId ? registry.get(ownerId) : undefined
      if (!provider) {
        // The hub recorded no owner: this request is already gone (a `reload`
        // that raced the resolution, a server restart that cleared the maps),
        // or the provider that owned it no longer exists. Either way no answer
        // can ever be delivered — so close the sheet everywhere instead of
        // leaving the phone holding one it cannot dismiss.
        discardApproval(msg.requestId)
        throw new UnknownApprovalError(msg.requestId)
      }
      try {
        // `answers` only means something to a provider that asked a question; a
        // provider whose sheet is a verdict ignores it, so it is passed
        // straight through rather than branched on here.
        await provider.answerApproval(msg.requestId, msg.decision, msg.answers)
      } catch (err) {
        // A provider that does not hold the request can never accept an answer
        // for it — the turn ended while the sheet was up, or the CLI child for
        // that turn exited. Same cleanup as above.
        //
        // Every OTHER failure deliberately leaves the entry alone: the approval
        // is still live, only the answer failed to land, and dropping the sheet
        // would leave the turn blocked with nothing on screen to unblock it.
        if (err instanceof UnknownApprovalError) discardApproval(msg.requestId)
        throw err
      }
      reply()
      return
    }

    default: {
      const exhaustive: never = msg
      throw new Error(`unknown message type: ${JSON.stringify(exhaustive)}`)
    }
  }
}
