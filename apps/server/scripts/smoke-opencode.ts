/**
 * Live smoke for the opencode provider.
 *
 * Starts a private `opencode serve` under an isolated HOME/database, points the
 * provider at it, and drives one real turn plus a deterministic permission
 * round trip. Needs the opencode binary (path, runtime pack, or PATH) and
 * network access to a free model; it is not part of CI.
 *
 * Run: npx tsx apps/server/scripts/smoke-opencode.ts
 * Keep the temp dir: OPENCODE_SMOKE_KEEP=1
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AgentEvent } from '@vibemobile/protocol'
import { resolveOpencodeBin } from '../src/agents/runtime.js'
import { OpencodeProvider } from '../src/opencode/OpencodeProvider.js'

const MODEL = process.env.OPENCODE_SMOKE_MODEL ?? 'opencode/big-pickle'
const PASSWORD = crypto.randomBytes(24).toString('base64url')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemobile-opencode-'))
const HOME = path.join(TMP, 'home')
const WORK = path.join(TMP, 'work')
const STATE = path.join(TMP, 'state')
for (const dir of [HOME, WORK, STATE]) fs.mkdirSync(dir, { recursive: true })
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.OPENCODE_DB = path.join(HOME, 'smoke.db')

const log = (line: string) => console.log(`[smoke:opencode] ${line}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

async function api(base: string, method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(base + url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== undefined) return value
    await sleep(200)
  }
  throw new Error(`timeout waiting for ${label}`)
}

let child: ChildProcess | undefined
let provider: OpencodeProvider | undefined
let base = ''

try {
  const { cmd, args } = resolveOpencodeBin()
  log(`binary: ${cmd}`)
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  log(`temp: ${TMP} · port ${port}`)

  child = spawn(cmd, [...args, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: WORK,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  child.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString().split(PASSWORD).join('<redacted>').trim()
    if (line) log(`[server] ${line}`)
  })
  let spawnError: Error | undefined
  child.on('error', (err) => {
    spawnError = err
  })

  const info = await waitFor(
    () => {
      if (spawnError) throw spawnError
      return fetch(`${base}/api/info`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}` },
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined)
    },
    30_000,
    'server ready',
  )
  log(`server ${(info as { version: string }).version}`)

  provider = new OpencodeProvider({
    workspaceRoots: [WORK],
    stateDir: STATE,
    agentsDir: path.join(STATE, 'agents'),
    attachUrl: base,
    port,
    password: PASSWORD,
    onLog: (line) => log(`[provider] ${line}`),
  })

  const events: AgentEvent[] = []
  provider.subscribe((event) => events.push(event))
  await provider.start()
  const probe = await provider.probe()
  if (!probe.available) throw new Error(`probe unavailable: ${probe.detail}`)
  log(`probe ${probe.version} (${probe.detail})`)

  const models = await provider.listModels()
  if (!models.some((model) => model.id === MODEL)) {
    throw new Error(`${MODEL} is not in the model list (set OPENCODE_SMOKE_MODEL)`)
  }
  log(`models: ${models.length}`)

  const session = await provider.createSession({
    cwd: WORK,
    model: MODEL,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
  })
  log(`session ${session.id}`)

  const turn = await provider.startTurn(
    session.id,
    [{ type: 'text', text: 'Reply with the single word: pong' }],
    { model: MODEL, effort: 'default', sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  )
  await waitFor(
    () => events.find((event) => event.kind === 'turn.completed' && event.turnId === turn.turnId),
    120_000,
    'first turn',
  )
  log('first turn completed')

  const transcript = await provider.getTranscript(session.id)
  const text = transcript?.turns
    .flatMap((item) => item.items)
    .filter((item) => item.kind === 'message' && item.role === 'assistant')
    .map((item) => (item.kind === 'message' ? item.text : ''))
    .join(' ')
  if (!text) throw new Error('transcript has no assistant text')
  log(`transcript: ${JSON.stringify(text.slice(0, 80))}`)

  // Deterministic permission round trip: create a request from the session's
  // own API (the same path a tool uses), then answer it through the provider.
  events.length = 0
  const pending = api(base, 'POST', `/api/session/${session.id}/permission`, {
    action: 'shell',
    resources: ['echo smoke'],
    source: { type: 'tool', messageID: 'msg_smoke', id: 'call_smoke' },
    message: 'smoke permission',
  })
  pending.catch(() => undefined)
  const approval = await waitFor(
    () =>
      events.find(
        (event): event is Extract<AgentEvent, { kind: 'approval.requested' }> =>
          event.kind === 'approval.requested',
      ),
    15_000,
    'approval.requested',
  )
  await provider.answerApproval(approval.approval.requestId, 'accept')
  await waitFor(
    () => events.find((event) => event.kind === 'approval.resolved'),
    15_000,
    'approval.resolved',
  )
  log('approval round trip')

  await provider.renameSession(session.id, 'smoke renamed')
  await provider.pinSession(session.id, true)
  await provider.archiveSession(session.id, true)
  const archived = await provider.getSession(session.id)
  if (!archived?.archived) throw new Error('archive did not stick')
  await provider.deleteSession(session.id)
  if (await provider.getSession(session.id)) throw new Error('delete did not stick')
  log('rename / pin / archive / delete')

  log('PASS')
} catch (err) {
  console.error('[smoke:opencode] FAILED', err)
  process.exitCode = 1
} finally {
  await provider?.stop().catch(() => undefined)
  // On Windows the PATH shim is a `.cmd`, so the direct child is cmd.exe and
  // the actual opencode process is a grandchild; killing only the shim leaves
  // the SQLite file open and the temp directory unremovable.
  if (child?.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  }
  await sleep(800)
  if (!process.env.OPENCODE_SMOKE_KEEP) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } catch (err) {
      log(`cleanup skipped: ${(err as Error).message}`)
    }
  } else {
    log(`kept ${TMP}`)
  }
}
