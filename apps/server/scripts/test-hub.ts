/**
 * End-to-end test of the browser-facing WebSocket hub.
 *
 * The other scripts drive AgentProvider directly; this one speaks the exact
 * ClientMessage/ServerMessage protocol the phone uses over /ws, so it covers
 * the cookie auth, the subscribe/resume path, event fan-out and the ack/nack
 * correlation that the React client depends on.
 */
import { WebSocket } from 'ws'
import type { AgentEvent, ClientMessage, ServerMessage } from '@vibemobile/protocol'

const BASE = process.env.VIBEMOBILE_URL ?? 'http://127.0.0.1:3000'
const PIN = process.env.VIBEMOBILE_PIN ?? process.argv[2]
if (!PIN) {
  console.error('usage: tsx scripts/test-hub.ts <PIN>   (or set VIBEMOBILE_PIN)')
  process.exit(2)
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pin: PIN }),
})
if (!login.ok) {
  console.error('login failed:', login.status, await login.text())
  process.exit(1)
}
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

// ---- create a session to drive ----
const created = await fetch(`${BASE}/api/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ provider: 'codex', cwd: process.cwd() }),
})
if (!created.ok) {
  console.error('createSession failed:', created.status, await created.text())
  process.exit(1)
}
const session = (await created.json()) as { id: string }
console.log(`session: ${session.id}`)

// ---- connect ----
const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`, { headers: { Cookie: cookie } })

let seq = 0
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()

function command(message: ClientMessage & { type: string }): Promise<any> {
  const clientRequestId = String(++seq)
  return new Promise((resolve, reject) => {
    pending.set(clientRequestId, { resolve, reject })
    // `clientRequestId`, not `requestId` — an `answerApproval` payload carries
    // its own `requestId`, and spreading would overwrite it with our counter.
    socket.send(JSON.stringify({ ...message, clientRequestId }))
    setTimeout(() => {
      if (pending.delete(clientRequestId)) reject(new Error(`${message.type} timed out`))
    }, 90_000)
  })
}

const deltas: string[] = []
let finalMessage = ''
let turnStatus: string | null = null
let approvalSeen = false

const finish = (code: number, message: string) => {
  console.log(message)
  try {
    socket.close()
  } catch {
    /* already closed */
  }
  setTimeout(() => process.exit(code), 100)
}

const timer = setTimeout(() => {
  finish(1, `FAIL: timed out. deltas=${deltas.length} turnStatus=${turnStatus}`)
}, 150_000)

socket.on('open', async () => {
  try {
    console.log('socket open')
    await command({ type: 'subscribe', threadId: session.id } as any)
    console.log('subscribed')

    const { turnId } = await command({
      type: 'startTurn',
      threadId: session.id,
      input: [{ type: 'text', text: 'Reply with exactly: HUB_TEST_OK. Do not use any tools.' }],
    } as any)
    console.log(`turn started: ${turnId}`)

    // A second turn started while the first is running exercises the
    // mid-turn steer path the Composer uses.
    setTimeout(() => {
      command({
        type: 'steer',
        threadId: session.id,
        turnId,
        input: [{ type: 'text', text: 'Also mention the word STEERED.' }],
      } as any)
        .then(() => console.log('steer accepted'))
        .catch((err) => console.log('steer rejected:', err.message))
    }, 1500)
  } catch (err) {
    clearTimeout(timer)
    finish(1, `FAIL: ${(err as Error).message}`)
  }
})

socket.on('message', (raw) => {
  const msg = JSON.parse(raw.toString()) as ServerMessage & { requestId?: string }

  if (msg.type === 'ack') {
    const waiter = msg.requestId ? pending.get(msg.requestId) : undefined
    if (waiter && msg.requestId) {
      pending.delete(msg.requestId)
      waiter.resolve(msg.data ?? {})
    }
    return
  }
  if (msg.type === 'nack') {
    const waiter = msg.requestId ? pending.get(msg.requestId) : undefined
    if (waiter && msg.requestId) {
      pending.delete(msg.requestId)
      waiter.reject(new Error(msg.error))
    }
    return
  }
  if (msg.type !== 'event') return

  const event: AgentEvent = msg.event
  switch (event.kind) {
    case 'delta':
      if (event.channel === 'text') deltas.push(event.text)
      break
    case 'item.completed':
      if (event.item.kind === 'message' && event.item.role === 'assistant') {
        finalMessage = event.item.text
      }
      break
    case 'approval.requested':
      approvalSeen = true
      console.log(`approval requested: ${event.approval.type} — ${event.approval.title}`)
      // Answer it so the turn cannot hang; the point of this test is the
      // round-trip, not the decision.
      command({ type: 'answerApproval', requestId: event.approval.requestId, decision: 'decline' } as any)
        .then(() => console.log('approval answered'))
        .catch(() => undefined)
      break
    case 'turn.completed':
      turnStatus = event.status
      clearTimeout(timer)
      report()
      return
    default:
      break
  }
})

socket.on('error', (err) => {
  clearTimeout(timer)
  finish(1, `FAIL: socket error ${err.message}`)
})

function report() {
  const streamed = deltas.join('')
  console.log('')
  console.log(`  deltas received : ${deltas.length}`)
  console.log(`  streamed text   : ${JSON.stringify(streamed.slice(0, 120))}`)
  console.log(`  final item text : ${JSON.stringify(finalMessage.slice(0, 120))}`)
  console.log(`  turn status     : ${turnStatus}`)
  console.log(`  approval seen   : ${approvalSeen}`)
  console.log('')

  const problems: string[] = []
  if (deltas.length === 0) problems.push('no text deltas streamed')
  if (!finalMessage) problems.push('no completed assistant message')
  if (turnStatus !== 'completed') problems.push(`turn did not complete (${turnStatus})`)
  if (!streamed.includes('HUB_TEST_OK')) problems.push('streamed text missing the marker')

  finish(problems.length ? 1 : 0, problems.length ? `FAIL: ${problems.join('; ')}` : 'PASS: hub end-to-end ok')
}
