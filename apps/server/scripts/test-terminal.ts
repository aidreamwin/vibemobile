/**
 * Terminal persistence test.
 *
 * The claim being tested is not "the socket reconnects" — it is that the shell
 * belongs to the server, not to the connection. So this drives the same socket
 * the browser does and checks the two things that can be faked independently:
 * the *screen* (a snapshot that carries what was printed before the drop) and
 * the *process* (the same pid and the same cwd afterwards). A prompt that merely
 * looks right would pass the first and fail the second.
 *
 * Usage: tsx scripts/test-terminal.ts <PIN>   (or set VIBEMOBILE_PIN)
 * Needs the server running; VIBEMOBILE_URL picks which one.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

const BASE = process.env.VIBEMOBILE_URL ?? 'http://127.0.0.1:3000'
const PIN = process.env.VIBEMOBILE_PIN ?? process.argv[2]
if (!PIN) {
  console.error('usage: tsx scripts/test-terminal.ts <PIN>   (or set VIBEMOBILE_PIN)')
  process.exit(2)
}

const COLS = 100
const ROWS = 40
/** Two shells is enough for the isolation check; the cap is 4. */
const MARKER = `VM_T_${Date.now()}`
const TMP = mkdtempSync(path.join(tmpdir(), 'vibemobile-term-'))
/** Forward slashes: PowerShell and bash both take them inside quotes. */
const TMP_POSIX = TMP.replace(/\\/g, '/')
/**
 * `os.tmpdir()` hands back the 8.3 short name (`C:/Users/ADMINI~1/...`) while
 * the shell reports the long one, so the expected value has to be expanded
 * before the two can be compared.
 */
const TMP_REAL = realpathSync.native(TMP)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the purpose
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
const normalise = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The last match — the shell echoes the command line before printing the value. */
function lastMatch(re: RegExp, text: string): string | undefined {
  const all = [...text.matchAll(re)]
  const hit = all.at(-1)
  return hit ? strip(hit[1]) : undefined
}

let passed = 0
function check(ok: boolean, label: string, detail?: unknown): void {
  if (!ok) {
    console.error(`FAIL: ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
    process.exit(1)
  }
  passed++
  console.log(`  ok  ${label}`)
}

// --------------------------------------------------------------- shell verbs

const isPowerShell = (shell: string) => /powershell|pwsh/i.test(shell)

/**
 * Every one of these splits the literal it prints (`'VM' + 'PID='`, `"VM""PID="`).
 * The terminal echoes back the command line, so a command that contained the
 * whole literal would make the assertion below pass on the echo alone — which
 * is exactly the kind of test that proves nothing.
 */
function sayMarker(shell: string, value: string): string {
  const head = value.slice(0, 3)
  const tail = value.slice(3)
  return isPowerShell(shell) ? `Write-Output ('${head}' + '${tail}')\r` : `echo "${head}""${tail}"\r`
}

function sayPid(shell: string): string {
  return isPowerShell(shell) ? `Write-Output ('VM' + 'PID=' + $PID)\r` : `echo "VM""PID=$$"\r`
}

function sayCwd(shell: string): string {
  return isPowerShell(shell) ? `Write-Output ('VM' + 'CWD=' + (Get-Location).Path)\r` : `echo "VM""CWD=$(pwd)"\r`
}

const cdTo = (shell: string, dir: string) =>
  isPowerShell(shell) ? `Set-Location -LiteralPath '${dir}'\r` : `cd '${dir}'\r`

const PID_RE = /VMPID=(\d+)/g
const CWD_RE = /VMCWD=([^\r\n]+)/g

// -------------------------------------------------------------------- socket

type Ready = { type: 'ready'; id: string; shell: string; cwd: string; attached: boolean }

class Term {
  readonly socket: WebSocket
  /** Everything the server painted, in arrival order: snapshots and output alike. */
  screen = ''
  readies: Ready[] = []
  exitCodes: number[] = []
  errors: string[] = []
  closeCode: number | null = null

  constructor(cookie: string, query: Record<string, string>) {
    const proto = BASE.replace(/^http/, 'ws')
    this.socket = new WebSocket(`${proto}/ws/terminal?${new URLSearchParams(query)}`, {
      headers: { Cookie: cookie },
    })
    this.socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      switch (msg.type) {
        case 'ready':
          this.readies.push(msg)
          break
        case 'snapshot':
        case 'output':
          this.screen += msg.data
          break
        case 'exit':
          this.exitCodes.push(msg.exitCode)
          break
        case 'error':
          this.errors.push(msg.message)
          break
        default:
          break
      }
    })
    this.socket.on('close', (code) => {
      this.closeCode = code
    })
  }

  send(message: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  type(text: string): void {
    this.send({ type: 'input', data: text })
  }

  /** Polls `check` until it returns something truthy, or gives up. */
  async until<T>(check: () => T | undefined | false, what: string, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = check()
      if (hit) return hit as T
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; screen tail: ${JSON.stringify(this.screen.slice(-400))}`)
      }
      await sleep(50)
    }
  }

  readyAt(index: number): Promise<Ready> {
    return this.until(() => this.readies[index], `ready #${index + 1}`)
  }

  waitScreen(needle: string, what: string, timeoutMs = 30_000): Promise<true> {
    return this.until(() => this.screen.includes(needle) || undefined, what, timeoutMs).then(() => true)
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------- run

const opened: Term[] = []

try {
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
  console.log(`logged in to ${BASE}\n`)

  // ------------------------------------------------ 1. a shell, with an id
  const a = new Term(cookie, { cols: String(COLS), rows: String(ROWS) })
  opened.push(a)
  const first = await a.readyAt(0)
  check(first.attached === false, 'a fresh connection starts a new shell (attached=false)')
  check(a.errors.length === 0, 'no server errors', a.errors)

  const shell = first.shell
  const id = first.id
  const cwd0 = normalise(realpathSync.native(first.cwd))
  console.log(`  shell: ${shell}\n  id:    ${id}\n  cwd:   ${first.cwd}\n`)

  // Mark the screen and the process: cwd, pid, then a string only this run can
  // have printed.
  a.type(sayPid(shell))
  a.type(cdTo(shell, TMP_POSIX))
  a.type(sayCwd(shell))
  a.type(sayMarker(shell, MARKER))
  await a.waitScreen(MARKER, 'the marker in the first shell')
  const pid0 = await a.until(() => lastMatch(PID_RE, a.screen), 'the shell pid')
  const cwd1 = await a.until(() => lastMatch(CWD_RE, a.screen), 'the shell cwd')
  check(normalise(cwd1) === normalise(TMP_REAL), 'the shell really changed directory', { cwd1, TMP_REAL })

  // ------------------------------------------------- 2. drop the socket
  a.close()
  await sleep(1200)
  check(a.exitCodes.length === 0, 'closing the socket does not end the shell')

  // ------------------------------------------- 3. same id, same everything
  const b = new Term(cookie, { id, cols: String(COLS), rows: String(ROWS) })
  opened.push(b)
  const second = await b.readyAt(0)
  check(second.attached === true, 'reconnecting with the same id attaches (attached=true)')
  check(second.id === id, 'and hands back the same id', second.id)
  check(
    b.screen.includes(MARKER),
    'the snapshot carries what was printed before the drop',
    JSON.stringify(b.screen.slice(0, 200)),
  )

  // Everything after the snapshot is this connection's own doing. The snapshot
  // is a re-rendering, not a copy, so it cannot be skipped by counting bytes.
  const tailStart = b.screen.length
  const tail = () => b.screen.slice(tailStart)

  // The part a repainted prompt cannot fake: same process, same directory.
  b.type(sayPid(shell))
  b.type(sayCwd(shell))
  const pid1 = await b.until(() => lastMatch(PID_RE, tail()), 'the pid after reattaching')
  check(pid1 === pid0, 'it is the same process, not a new one', { pid0, pid1 })
  const cwd2 = await b.until(() => lastMatch(CWD_RE, tail()), 'the cwd after reattaching')
  check(normalise(cwd2) === normalise(TMP_REAL), 'and the same working directory', cwd2)

  // ---------------------------------------------------- 4. other id = other shell
  const c = new Term(cookie, { id: randomUUID(), cols: String(COLS), rows: String(ROWS) })
  opened.push(c)
  const third = await c.readyAt(0)
  check(third.attached === false, 'an unknown id starts a new shell instead of failing', third.id)
  check(third.id !== id, 'with an id of its own', third.id)
  await sleep(800)
  check(!c.screen.includes(MARKER), 'and cannot see the first shell — shells are per device')

  // ----------------------------------------------------------- 5. restart
  const offset = b.screen.length
  b.send({ type: 'restart' })
  const fourth = await b.readyAt(1)
  check(fourth.attached === false, 'restart reports a new shell (attached=false)')
  check(fourth.id === id, 'under the same id, so the browser keeps its terminal', fourth.id)

  b.type(sayPid(shell))
  b.type(sayCwd(shell))
  const rest = () => b.screen.slice(offset)
  const pid2 = await b.until(() => lastMatch(PID_RE, rest()), 'the new shell pid')
  const cwd3 = await b.until(() => lastMatch(CWD_RE, rest()), 'the new shell cwd')
  check(pid2 !== pid0, 'restart really is a new process', { pid0, pid2 })
  check(normalise(cwd3) === cwd0, 'and starts at the workspace root again', { cwd0, cwd3 })

  // ------------------------------------------------------------ 6. clean up
  // `a` and `b` are two views of one shell — the record followed the id when b
  // reattached — so exiting on b is exiting that shell. `a`'s socket is already
  // closed and can no longer be told anything, which is the point of step 2.
  b.type('exit\r')
  c.type('exit\r')
  await sleep(2000)
  check(b.exitCodes.length > 0 && c.exitCodes.length > 0, '`exit` ends the shell and the record with it', {
    b: b.exitCodes,
    c: c.exitCodes,
  })

  console.log(`\nPASS: terminal persistence (${passed} checks)`)
  for (const term of opened) term.close()
  process.exit(0)
} catch (err) {
  console.error(`FAIL: ${(err as Error).message}`)
  for (const term of opened) term.close()
  process.exit(1)
} finally {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* windows file locks */
  }
}
