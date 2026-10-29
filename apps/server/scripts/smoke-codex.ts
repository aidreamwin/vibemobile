/**
 * P0 go/no-go smoke test for the Codex app-server protocol.
 *
 * Spawns `codex app-server --listen ws://127.0.0.1:8788`, connects as a WS
 * client, and drives one full turn. Success criteria:
 *   1. `initialize` returns a userAgent
 *   2. `thread/start` returns a threadId
 *   3. `turn/start` yields many `item/agentMessage/delta` notifications
 *      spread over time (proving token-by-token streaming, not one blob)
 *   4. `turn/completed` arrives with status "completed"
 *
 * Usage: npm run smoke --workspace=@vibemobile/server
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = 8788
const WS_URL = `ws://127.0.0.1:${PORT}`
const CWD = path.resolve(__dirname, '../../..')
const PROMPT = process.argv[2] ?? 'Count from 1 to 20, one number per line. Nothing else.'

// ---------------------------------------------------------------- app-server

function resolveCodexBin(): string {
  // @openai/codex ships a node shim; on Windows npm also writes a .cmd.
  const pkg = require.resolve('@openai/codex/package.json')
  const shim = path.join(path.dirname(pkg), 'bin', 'codex.js')
  return shim
}

let child: ChildProcess | undefined

function spawnAppServer(): ChildProcess {
  const bin = resolveCodexBin()
  console.log(`[smoke] spawning: ${process.execPath} ${bin} app-server --listen ws://127.0.0.1:${PORT}`)
  const proc = spawn(process.execPath, [bin, 'app-server', '--listen', `ws://127.0.0.1:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: CWD,
  })
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[app-server] ${d}`))
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[app-server:err] ${d}`))
  proc.on('exit', (code) => console.log(`[smoke] app-server exited: ${code}`))
  return proc
}

async function waitForReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/readyz`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`app-server not ready within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------- json-rpc

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string }

class Smoke {
  #ws!: WebSocket
  #nextId = 1
  #pending = new Map<number, Pending>()

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // NOTE: do NOT set an Origin header — app-server rejects upgrades that
      // carry one. The `ws` package omits it by default.
      this.#ws = new WebSocket(WS_URL)
      this.#ws.on('open', () => resolve())
      this.#ws.on('error', reject)
      this.#ws.on('message', (raw: Buffer) => this.#onMessage(raw.toString()))
    })
  }

  #onMessage(text: string) {
    let msg: any
    try {
      msg = JSON.parse(text)
    } catch {
      console.error('[smoke] non-JSON frame:', text.slice(0, 200))
      return
    }

    // Response to one of our requests?
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.#pending.get(msg.id)
      if (!p) {
        console.warn('[smoke] response for unknown id', msg.id)
        return
      }
      this.#pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
      return
    }

    // Server -> client REQUEST (approvals). Must be answered or the turn hangs.
    if (msg.id !== undefined && msg.method) {
      this.#onServerRequest(msg)
      return
    }

    // Notification
    if (msg.method) this.#onNotification(msg)
  }

  #onServerRequest(msg: any) {
    console.log(`\n[smoke] <<< SERVER REQUEST ${msg.method} (id=${msg.id})`)
    console.log(`[smoke]     params: ${JSON.stringify(msg.params).slice(0, 400)}`)
    // Smoke run is configured with approvalPolicy "never", so this shouldn't
    // fire. If it does, decline so the turn still terminates.
    const decision = msg.method === 'item/fileChange/requestApproval' ? 'decline' : 'decline'
    this.#send({ id: msg.id, result: { decision } })
    console.log(`[smoke] >>> replied decision=${decision}`)
  }

  #onNotification(msg: any) {
    const { method, params } = msg
    this.#stats[method] = (this.#stats[method] ?? 0) + 1

    switch (method) {
      case 'item/agentMessage/delta': {
        const now = Date.now()
        if (this.#firstDeltaAt === 0) {
          this.#firstDeltaAt = now
          console.log(`\n[smoke] <<< FIRST agentMessage delta after ${now - this.#turnStartedAt}ms`)
        }
        this.#deltas.push({ at: now, delta: params.delta })
        process.stdout.write(params.delta)
        break
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        break // don't spam stdout
      case 'item/commandExecution/outputDelta':
        process.stdout.write(params.delta)
        break
      case 'item/started':
        console.log(`\n[smoke] <<< item/started  ${params.item?.type} ${params.item?.id ?? ''}`)
        break
      case 'item/completed': {
        const it = params.item ?? {}
        const preview = it.command ?? it.text ?? (it.changes ? `${it.changes.length} file(s)` : '')
        console.log(`\n[smoke] <<< item/completed ${it.type} ${String(preview).slice(0, 80)}`)
        break
      }
      case 'turn/started':
        this.#turnId = params.turn?.id
        console.log(`[smoke] <<< turn/started turnId=${this.#turnId}`)
        break
      case 'turn/completed':
        this.#turnStatus = params.turn?.status
        console.log(`\n[smoke] <<< turn/completed status=${this.#turnStatus}`)
        break
      case 'thread/status/changed':
        console.log(`[smoke] <<< thread/status/changed ${JSON.stringify(params.status)}`)
        break
      case 'thread/tokenUsage/updated':
        break
      case 'error':
      case 'warning':
        console.log(`\n[smoke] <<< ${method}: ${JSON.stringify(params).slice(0, 300)}`)
        break
      default:
        break
    }
  }

  #stats: Record<string, number> = {}
  #deltas: { at: number; delta: string }[] = []
  #turnStartedAt = 0
  #firstDeltaAt = 0
  #turnId = ''
  #turnStatus = ''

  #send(obj: unknown) {
    this.#ws.send(JSON.stringify(obj))
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#send({ id, method, params })
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method}: timeout after 30s`))
      }, 30_000)
    })
  }

  notify(method: string, params?: unknown) {
    this.#send({ method, params })
  }

  get deltas() {
    return this.#deltas
  }
  get stats() {
    return this.#stats
  }
  get turnId() {
    return this.#turnId
  }
  get turnStatus() {
    return this.#turnStatus
  }
  close() {
    this.#ws.close()
  }
}

// ---------------------------------------------------------------- main

async function main() {
  child = spawnAppServer()
  await waitForReady()

  const c = new Smoke()
  await c.connect()

  // 1. handshake
  const init = await c.request('initialize', {
    clientInfo: { name: 'vibemobile-smoke', title: 'VibeMobile Smoke', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
  console.log(`[smoke] initialize OK -> userAgent=${init.userAgent} platformOs=${init.platformOs}`)
  c.notify('initialized')

  // 2. thread
  const thread = await c.request('thread/start', {
    cwd: CWD,
    sandbox: 'read-only',
    approvalPolicy: 'never',
  })
  const threadId: string = thread.thread.id
  console.log(`[smoke] thread/start OK -> threadId=${threadId} model=${thread.model}`)

  // 3. turn
  console.log(`\n[smoke] turn/start: "${PROMPT}"\n${'-'.repeat(60)}`)

  const t0 = Date.now()
  const started = await c.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: PROMPT }],
  })
  console.log(`[smoke] turn/start OK -> turnId=${started.turn.id}`)

  // wait for completion
  const deadline = Date.now() + 120_000
  while (!c.turnStatus && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }

  const deltas = c.deltas
  console.log(`\n${'-'.repeat(60)}`)
  console.log('[smoke] notification counts:')
  for (const [k, v] of Object.entries(c.stats).sort((a, b) => b[1] - a[1])) {
    console.log(`         ${String(v).padStart(5)}  ${k}`)
  }

  // ---- assertions ----
  const failures: string[] = []
  if (!c.turnStatus) failures.push('turn never completed within 120s')
  else if (c.turnStatus !== 'completed') failures.push(`turn status was "${c.turnStatus}", expected "completed"`)
  if (deltas.length < 5) failures.push(`only ${deltas.length} agentMessage deltas — streaming looks broken`)
  if (!init.userAgent) failures.push('initialize returned no userAgent')

  const span = deltas.length > 1 ? deltas[deltas.length - 1].at - deltas[0].at : 0
  console.log(`\n[smoke] streaming: ${deltas.length} deltas over ${span}ms (turn took ${Date.now() - t0}ms)`)
  if (deltas.length > 1 && span < 20) {
    console.log('[smoke] NOTE: all deltas arrived within <20ms — may be buffered rather than truly incremental')
  }

  c.close()
  child?.kill()

  if (failures.length) {
    console.error(`\n[smoke] FAILED:\n  - ${failures.join('\n  - ')}`)
    process.exit(1)
  }
  console.log('\n[smoke] PASSED — app-server protocol is working end to end.')
  process.exit(0)
}

main().catch((err) => {
  console.error('\n[smoke] FATAL:', err)
  child?.kill()
  process.exit(1)
})
