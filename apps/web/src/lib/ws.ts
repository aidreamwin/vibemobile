import type {
  AgentEvent,
  AgentInput,
  ApprovalDecision,
  ApprovalPolicy,
  ClientMessage,
  SandboxMode,
  ServerMessage,
} from '@vibemobile/protocol'
import { runnerPath } from './runner'

export type ConnectionState = 'connecting' | 'open' | 'closed'

type EventListener = (event: AgentEvent) => void
type StateListener = (state: ConnectionState) => void

const MAX_BACKOFF = 15_000

/**
 * WebSocket client for the agent hub.
 *
 * Reconnects on its own and replays subscriptions, because a phone loses the
 * socket constantly: screen lock, app switch, WiFi handoff. On reconnect the
 * server re-resumes each thread, which is what re-establishes streaming after
 * an app-server restart.
 */
class AgentSocket {
  #socket?: WebSocket
  #state: ConnectionState = 'closed'
  #attempt = 0
  #timer?: number
  #subscribed = new Set<string>()
  #eventListeners = new Set<EventListener>()
  #stateListeners = new Set<StateListener>()
  /** Resolvers for in-flight commands, keyed by our own correlation id. */
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  #seq = 0
  #started = false

  get state(): ConnectionState {
    return this.#state
  }

  /**
   * Whether `connect()` has ever been called.
   *
   * `state` alone cannot tell "not connected yet" from "the connection
   * dropped": both are `closed`. Only the second one is worth putting on the
   * user's screen, and a page mounts one frame before `App` calls `connect()`,
   * so the banner needs the difference. It never goes back to false — a socket
   * that has connected once and later drops is genuinely disconnected, which is
   * the entire case the banner exists for.
   */
  get started(): boolean {
    return this.#started
  }

  onEvent(listener: EventListener): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  onState(listener: StateListener): () => void {
    this.#stateListeners.add(listener)
    listener(this.#state)
    return () => this.#stateListeners.delete(listener)
  }

  connect(): void {
    if (
      this.#socket &&
      (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }

    this.#started = true
    this.#setState('connecting')
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${proto}//${location.host}${runnerPath('/ws')}`)
    this.#socket = socket

    socket.onopen = () => {
      this.#attempt = 0
      this.#setState('open')
      // Replay subscriptions; they are not durable across sockets.
      for (const threadId of this.#subscribed) {
        this.#raw({ type: 'subscribe', threadId })
      }
    }

    socket.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }

      switch (msg.type) {
        case 'event':
          for (const listener of this.#eventListeners) listener(msg.event)
          break
        case 'ack': {
          const waiter = msg.requestId ? this.#pending.get(msg.requestId) : undefined
          if (waiter && msg.requestId) {
            this.#pending.delete(msg.requestId)
            waiter.resolve(msg.data)
          }
          break
        }
        case 'nack': {
          const waiter = msg.requestId ? this.#pending.get(msg.requestId) : undefined
          if (waiter && msg.requestId) {
            this.#pending.delete(msg.requestId)
            waiter.reject(new Error(msg.error))
          }
          break
        }
        default:
          break
      }
    }

    socket.onclose = () => {
      this.#setState('closed')
      this.#failPending('connection closed')
      this.#scheduleReconnect()
    }

    socket.onerror = () => {
      // onclose always follows; nothing to do but let it handle reconnection.
    }
  }

  #setState(state: ConnectionState) {
    if (this.#state === state) return
    this.#state = state
    for (const listener of this.#stateListeners) listener(state)
  }

  #scheduleReconnect() {
    if (this.#timer) return
    const delay = Math.min(500 * 2 ** this.#attempt, MAX_BACKOFF)
    this.#attempt++
    this.#timer = window.setTimeout(() => {
      this.#timer = undefined
      this.connect()
    }, delay)
  }

  #failPending(reason: string) {
    for (const [, waiter] of this.#pending) waiter.reject(new Error(reason))
    this.#pending.clear()
  }

  /** Reconnect immediately — used when the page becomes visible again. */
  wake(): void {
    if (this.#state === 'open') return
    this.#attempt = 0
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.connect()
  }

  #raw(message: ClientMessage) {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message))
    }
  }

  /** Fire-and-forget, but awaits the server's ack so callers see errors. */
  #command(message: ClientMessage): Promise<unknown> {
    const clientRequestId = String(++this.#seq)
    return new Promise((resolve, reject) => {
      if (this.#socket?.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'))
        return
      }
      this.#pending.set(clientRequestId, { resolve, reject })
      // `clientRequestId`, not `requestId` — spreading a message that already
      // has a `requestId` of its own would overwrite it. See ClientRequest.
      this.#socket.send(JSON.stringify({ ...message, clientRequestId }))
      window.setTimeout(() => {
        if (this.#pending.delete(clientRequestId)) {
          reject(new Error('request timed out — the server did not respond'))
        }
      }, 120_000)
    })
  }

  subscribe(threadId: string): void {
    this.#subscribed.add(threadId)
    this.#raw({ type: 'subscribe', threadId })
  }

  unsubscribe(threadId: string): void {
    this.#subscribed.delete(threadId)
    this.#raw({ type: 'unsubscribe', threadId })
  }

  startTurn(
    threadId: string,
    input: AgentInput[],
    opts?: { model?: string; effort?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode },
  ) {
    return this.#command({ type: 'startTurn', threadId, input, ...opts })
  }

  steer(threadId: string, turnId: string, input: AgentInput[]) {
    return this.#command({ type: 'steer', threadId, turnId, input })
  }

  interrupt(threadId: string, turnId: string) {
    return this.#command({ type: 'interrupt', threadId, turnId })
  }

  /** `answers` is the user's choices, one entry per question, only for a sheet that asked any. */
  answerApproval(requestId: string, decision: ApprovalDecision, answers?: string[][]) {
    return this.#command({ type: 'answerApproval', requestId, decision, ...(answers ? { answers } : {}) })
  }
}

export const socket = new AgentSocket()

// A phone that was backgrounded comes back with a dead socket. Reconnect as
// soon as the page is visible again rather than waiting out the backoff.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') socket.wake()
  })
  window.addEventListener('online', () => socket.wake())
}
