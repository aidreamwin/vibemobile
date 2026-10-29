/**
 * What do the two providers actually mean by "usage"?
 *
 *   npx tsx apps/server/scripts/probe-usage.ts
 *
 * The phone is about to show a token counter, and the two backends fill that
 * word with different things: Codex sends `thread/tokenUsage/updated` (with a
 * `total` AND a `last` breakdown in the same payload — see
 * `generated/v2/ThreadTokenUsage.ts`), Claude sends the SDK result frame's
 * `usage`, which the SDK documents as "MAIN AGENT LOOP ONLY … per-turn in
 * streaming-input sessions". A label written from either assumption alone is
 * how a counter ends up showing a number that never moves, or one that looks
 * like a per-turn figure and is really the whole thread.
 *
 * So: run TWO turns in ONE session on each backend and print the raw payloads.
 * Whatever differs between turn 1 and turn 2 is the cumulative field; whatever
 * is comparable across the two is per-turn.
 *
 * Real backends, real tokens (a few hundred), nothing written to the phone's
 * state: Codex gets its own app-server on 6880 (the deployed service holds
 * 6800 for the life of its process), Claude gets a fresh session id.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CWD = path.resolve(__dirname, '../../..')

// Not 6800: the dev/deployed service keeps that port for its own app-server,
// and two of them cannot share one port (see the port segmentation note in
// CLAUDE.md).
const PORT = 6880
const WS_URL = `ws://127.0.0.1:${PORT}`

const TURNS = ['Reply with exactly the word: one', 'Reply with exactly the word: two']

const j = (v: unknown) => JSON.stringify(v, null, 2)

// -------------------------------------------------------------------- Codex

function resolveCodexBin(): string {
  const pkg = require.resolve('@openai/codex/package.json')
  return path.join(path.dirname(pkg), 'bin', 'codex.js')
}

let child: ChildProcess | undefined

async function waitForReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/readyz`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`app-server not ready within ${timeoutMs}ms`)
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string }

class Codex {
  #ws!: WebSocket
  #nextId = 1
  #pending = new Map<number, Pending>()
  #usage: any[] = []
  #status = ''

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // No Origin header: app-server rejects upgrades that carry one.
      this.#ws = new WebSocket(WS_URL)
      this.#ws.on('open', () => resolve())
      this.#ws.on('error', reject)
      this.#ws.on('message', (raw: Buffer) => this.#onMessage(JSON.parse(raw.toString())))
    })
  }

  #onMessage(msg: any) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.#pending.get(msg.id)
      if (!p) return
      this.#pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
      return
    }
    // Server -> client request (approval). Never expected here (policy "never"),
    // but an unanswered one hangs the turn.
    if (msg.id !== undefined && msg.method) {
      this.#ws.send(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }))
      return
    }
    if (msg.method === 'thread/tokenUsage/updated') this.#usage.push(msg.params)
    if (msg.method === 'turn/completed') {
      this.#status = msg.params?.turn?.status ?? '?'
      if (this.#status !== 'completed') console.log(`  turn/completed: ${j(msg.params)}`)
    }
    if (msg.method === 'error' || msg.method === 'warning') console.log(`  ${msg.method}: ${j(msg.params)}`)
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method}: timeout`))
      }, 120_000)
    })
  }

  notify(method: string, params?: unknown) {
    this.#ws.send(JSON.stringify({ method, params }))
  }

  takeUsage(): any[] {
    const u = this.#usage
    this.#usage = []
    return u
  }
  get status() {
    return this.#status
  }
  resetTurn() {
    this.#status = ''
  }
  close() {
    this.#ws.close()
  }
}

async function probeCodex() {
  console.log('\n================ Codex ================\n')
  child = spawn(process.execPath, [resolveCodexBin(), 'app-server', '--listen', `ws://127.0.0.1:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: CWD,
  })
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[app-server] ${d}`))
  await waitForReady()

  const c = new Codex()
  await c.connect()
  await c.request('initialize', {
    clientInfo: { name: 'vibemobile-probe', title: 'usage probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
  c.notify('initialized')

  const thread = await c.request('thread/start', { cwd: CWD, sandbox: 'read-only', approvalPolicy: 'never' })
  const threadId: string = thread.thread.id
  console.log(`thread=${threadId}\n`)

  for (const [i, text] of TURNS.entries()) {
    c.resetTurn()
    c.takeUsage()
    await c.request('turn/start', { threadId, input: [{ type: 'text', text }] })
    const deadline = Date.now() + 120_000
    while (!c.status && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))

    const frames = c.takeUsage()
    console.log(`--- turn ${i + 1} (status=${c.status}) — ${frames.length} tokenUsage frame(s) ---`)
    // The LAST frame of a turn is the settled one; earlier ones are intermediate
    // (they arrive during the turn, and an early read is exactly the trap).
    const last = frames[frames.length - 1]
    if (!last) console.log('  (no thread/tokenUsage/updated at all)')
    else if (frames.length === 1) console.log(j(last))
    else console.log(`  last of ${frames.length}:\n${j(last).replace(/^/gm, '  ')}`)
  }

  c.close()
  child.kill()
}

// ------------------------------------------------------------------- Claude

/**
 * One `query()` per turn, `resume` on the second — the shape production uses
 * (one subprocess per turn), so the numbers printed here are the numbers the
 * provider would have received.
 */
async function probeClaude() {
  console.log('\n================ Claude ================\n')
  const sessionId = randomUUID()
  let resume: string | undefined

  for (const [i, text] of TURNS.entries()) {
    const options: Options = {
      cwd: CWD,
      includePartialMessages: false,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'default',
      // Nothing here should reach a tool; allowing keeps a stray one from
      // hanging the probe on a callback nobody answers.
      canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
      ...(resume ? { resume } : { sessionId }),
    }
    console.log(`--- turn ${i + 1} (${resume ? `resume=${resume}` : `sessionId=${sessionId}`}) ---`)

    let init: any = null
    let result: any = null
    for await (const msg of query({ prompt: text, options }) as AsyncGenerator<SDKMessage>) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') init = msg
      if (msg.type === 'result') result = msg
    }
    if (init && i === 0) {
      resume = init.session_id
      console.log(`  init.session_id=${init.session_id}`)
    }
    if (!result) {
      console.log('  (no result frame)')
      continue
    }
    console.log(`  subtype=${result.subtype} num_turns=${result.num_turns} total_cost_usd=${result.total_cost_usd}`)
    console.log(`  usage      = ${j(result.usage)}`)
    // `modelUsage` is documented as cumulative across turns of one query() call
    // — which, at one query() per turn, is "this call"; print it anyway so the
    // difference against `usage` is on the record.
    console.log(`  modelUsage = ${j(result.modelUsage)}`)
  }
}

async function main() {
  const only = process.argv[2]
  if (only !== 'claude') await probeCodex()
  if (only !== 'codex') await probeClaude()
  process.exit(0)
}

main().catch((err) => {
  console.error('\n[probe] FATAL:', err)
  child?.kill()
  process.exit(1)
})
