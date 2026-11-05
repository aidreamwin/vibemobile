/**
 * Owns the opencode server this provider talks to.
 *
 * Two modes, and the order is the point:
 *
 *  1. attach — the user's own opencode background service is the source of
 *     truth. The TUI and the phone then share live execution state, and there
 *     is no second process writing the same SQLite file.
 *  2. managed — spawn a private `opencode serve` only when no service was found
 *     (a container, a fresh machine, or an explicit OPENCODE_NO_ATTACH).
 *
 * Never both. opencode has no session lock (verified: two servers on one DB can
 * drive the same session), so attaching to the running service whenever it is
 * there is what keeps the phone and the desktop from racing each other.
 *
 * The service password is generated for a managed child and read from
 * `service.json` for an attached one. It must never reach a log line, an error
 * message, or an AgentEvent.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveOpencodeBin } from '../agents/runtime.js'
import { opencodeProfileEnv, type AgentConnection } from '../agents/profileRuntime.js'
import type { OpencodeInfo } from './types.js'

/** The major/minor line this build was written against. */
export const SUPPORTED_OPENCODE_MAJOR_MINOR = '2.2'

export interface ServiceRecord {
  id?: string
  version?: string
  url: string
  pid?: number
  password?: string
}

export interface OpencodeServiceStatus {
  available: boolean
  version?: string
  detail: string
  mode: 'attach' | 'managed' | 'none'
}

export interface OpencodeServiceOptions {
  connection?: AgentConnection
  /** Explicit attach URL. When set, this mode never spawns. */
  attachUrl?: string
  port: number
  bin?: string
  /** Password for an explicit/attached service. */
  password?: string
  /** Override the service.json path (tests, non-standard installs). */
  serviceFile?: string
  /** Never discover/attach; always spawn a private child. */
  noAttach?: boolean
  agentsDir?: string
  cwd?: string
  onLog?: (line: string) => void
  fetchImpl?: typeof fetch
  spawnImpl?: typeof spawn
}

const READY_TIMEOUT_MS = 30_000
const HEALTH_TIMEOUT_MS = 2_000
const RESTART_BASE_MS = 500
const RESTART_MAX_MS = 15_000

export function parseServiceRecord(value: unknown): ServiceRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.url !== 'string') return null
  const pid = typeof record.pid === 'number' && Number.isFinite(record.pid) ? record.pid : undefined
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    url: record.url,
    ...(pid === undefined ? {} : { pid }),
    ...(typeof record.password === 'string' ? { password: record.password } : {}),
  }
}

/** Every place an opencode service record may live, most specific first. */
export function serviceFileCandidates(explicit?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (explicit) return [path.resolve(explicit)]
  const files: string[] = []
  const xdg = env.XDG_STATE_HOME
  if (xdg) files.push(path.join(xdg, 'opencode', 'service.json'))
  const home = os.homedir()
  files.push(path.join(home, '.local', 'state', 'opencode', 'service.json'))
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (local) files.push(path.join(local, 'opencode', 'service.json'))
  }
  return files
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

/** `2.2.5` -> true when the major/minor line is the one this build supports. */
export function isSupportedVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:[.-]|$)/.exec(version)
  return match ? `${match[1]}.${match[2]}` === SUPPORTED_OPENCODE_MAJOR_MINOR : false
}

/** Strip the password from a child's output before it reaches the service log. */
function redactLines(text: string, password: string): string {
  return text.split(password).join('<redacted>')
}

export class OpencodeService extends EventEmitter {
  #opts: OpencodeServiceOptions
  #mode: 'attach' | 'managed' | 'none' = 'none'
  #baseUrl: string | null = null
  #password: string | null = null
  #version: string | null = null
  #child?: ChildProcess
  #owned = false
  #stopping = false
  #ensuring?: Promise<string>
  #restarts = 0
  #restartTimer?: NodeJS.Timeout
  #lastError: string | null = null

  constructor(opts: OpencodeServiceOptions) {
    super()
    this.#opts = opts
  }

  get mode(): 'attach' | 'managed' | 'none' {
    return this.#mode
  }

  get baseUrl(): string | null {
    return this.#baseUrl
  }

  get password(): string | null {
    return this.#password
  }

  get version(): string | null {
    return this.#version
  }

  get isOwned(): boolean {
    return this.#owned
  }

  get lastError(): string | null {
    return this.#lastError
  }

  /** Idempotent; concurrent callers share the same startup. */
  ensure(): Promise<string> {
    if (this.#baseUrl && this.#mode !== 'none') return Promise.resolve(this.#baseUrl)
    if (this.#ensuring) return this.#ensuring
    const pending = this.#start().finally(() => {
      if (this.#ensuring === pending) this.#ensuring = undefined
    })
    this.#ensuring = pending
    return pending
  }

  async status(): Promise<OpencodeServiceStatus> {
    try {
      const base = await this.ensure()
      return {
        available: true,
        version: this.#version ?? undefined,
        detail: this.#mode === 'attach' ? `attached to ${base}` : `managed on ${base}`,
        mode: this.#mode,
      }
    } catch (err) {
      return {
        available: false,
        version: this.#version ?? undefined,
        detail: this.#lastError ?? (err as Error).message,
        mode: this.#mode,
      }
    }
  }

  async restart(): Promise<void> {
    if (this.#mode === 'attach') {
      this.#log('attached to an external service; restart it in opencode itself')
      return
    }
    const child = this.#child
    if (!child) {
      this.#baseUrl = null
      this.#mode = 'none'
      await this.ensure()
      return
    }
    this.#stopping = true
    await this.#kill(child)
    this.#stopping = false
    this.#restarts = 0
    this.#child = undefined
    this.#baseUrl = null
    this.#mode = 'none'
    await this.ensure()
  }

  async stop(): Promise<void> {
    this.#stopping = true
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = undefined
    }
    const child = this.#child
    this.#child = undefined
    if (child && this.#owned) await this.#kill(child)
    this.#baseUrl = null
    this.#mode = 'none'
    this.#owned = false
  }

  // ---------------------------------------------------------------- startup

  async #start(): Promise<string> {
    this.#lastError = null
    if (this.#opts.attachUrl) {
      const record: ServiceRecord = {
        url: this.#opts.attachUrl,
        ...(this.#opts.password ? { password: this.#opts.password } : {}),
      }
      const attached = await this.#attach(record, false)
      if (!attached) throw new Error(this.#lastError ?? 'could not attach to opencode')
      return attached
    }

    if (!this.#opts.noAttach) {
      const found = this.#discover()
      if (found) {
        const attached = await this.#attach(found, true)
        if (attached) return attached
        // A service record that answers with an unsupported version is a hard
        // stop: spawning a second server would share its DB and split the live
        // execution state between two processes.
        const failure = this.lastError
        if (failure?.includes('unsupported')) throw new Error(failure)
      }
    }

    return this.#spawn()
  }

  #discover(): ServiceRecord | null {
    for (const file of serviceFileCandidates(this.#opts.serviceFile)) {
      let raw: string
      try {
        raw = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        this.#log(`ignoring unreadable service record ${file}`)
        continue
      }
      const record = parseServiceRecord(parsed)
      if (!record) continue
      if (!isLoopbackUrl(record.url)) {
        this.#log(`ignoring non-loopback service record ${file}`)
        continue
      }
      this.#log(`found service record ${file}`)
      return record
    }
    return null
  }

  async #attach(record: ServiceRecord, expectPid: boolean): Promise<string | null> {
    const password = this.#opts.password ?? record.password
    const info = await this.#probe(record.url, password, HEALTH_TIMEOUT_MS)
    if (!info) {
      // A stale pid or a service that is still starting must not become a hard
      // failure when a private server can take over.
      if (expectPid) return null
      this.#lastError = `opencode at ${record.url} did not answer /api/info`
      return null
    }
    if (expectPid && record.pid !== undefined && info.pid !== record.pid) {
      // The password already proved this is our service; a pid mismatch usually
      // means the record is stale after a service restart. Spawning a second
      // server here would share the DB and split live state, so attach anyway.
      this.#log(`service record pid ${record.pid} != /api/info pid ${info.pid}; attaching to the live service`)
    }
    if (!isSupportedVersion(info.version)) {
      this.#lastError = `unsupported opencode version ${info.version} (need ${SUPPORTED_OPENCODE_MAJOR_MINOR}.x)`
      return null
    }
    this.#mode = 'attach'
    this.#baseUrl = record.url.replace(/\/+$/, '')
    this.#password = password ?? null
    this.#version = info.version
    this.#owned = false
    this.#restarts = 0
    this.#log(`attached to opencode ${info.version} at ${this.#baseUrl}`)
    return this.#baseUrl
  }

  async #spawn(): Promise<string> {
    const port = this.#opts.port
    const password = this.#opts.password ?? crypto.randomBytes(24).toString('base64url')
    const { cmd, args } = resolveOpencodeBin({ bin: this.#opts.bin, agentsDir: this.#opts.agentsDir })
    const fullArgs = [...args, 'serve', '--hostname', '127.0.0.1', '--port', String(port)]
    this.#log(`spawning: ${cmd} ${fullArgs.join(' ')}`)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opencodeProfileEnv(this.#opts.connection?.(), process.env.OPENCODE_CONFIG_CONTENT),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_LOG_LEVEL: 'warn',
    }
    const child = (this.#opts.spawnImpl ?? spawn)(cmd, fullArgs, {
      cwd: this.#opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child
    this.#owned = true

    const pipe = (stream: NodeJS.ReadableStream | null, tag: string) => {
      stream?.on('data', (buf: Buffer) => {
        for (const line of redactLines(buf.toString(), password).split(/\r?\n/)) {
          if (line.trim()) this.#log(`[${tag}] ${line}`)
        }
      })
    }
    pipe(child.stdout, 'opencode')
    pipe(child.stderr, 'opencode:err')

    child.on('error', (err) => {
      // spawn() reports ENOENT asynchronously; without this the readiness loop
      // would spin for its full 30 s on a machine with no binary.
      this.#log(`opencode spawn failed: ${err.message}`)
      this.#lastError = err.message
      if (this.#child === child) this.#child = undefined
      this.emit('error', err)
      this.emit('exit', null, null)
    })

    child.on('exit', (code, signal) => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#log(`opencode exited (code=${code} signal=${signal})`)
      this.emit('exit', code, signal)
      // Only a child that finished starting is restarted. A failed startup is
      // surfaced by the readiness loop that awaited it; restarting from the
      // exit handler as well would race that loop and spawn twice.
      if (this.#stopping || !this.#owned || this.#mode !== 'managed') return
      const delay = Math.min(RESTART_BASE_MS * 2 ** this.#restarts, RESTART_MAX_MS)
      this.#restarts++
      this.#log(`restarting opencode in ${delay}ms`)
      this.#baseUrl = null
      this.#mode = 'none'
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = undefined
        // An `ensure()` may have already spawned while this timer waited.
        if (this.#stopping || this.#child) return
        this.#spawn()
          .then(() => this.emit('restarted'))
          .catch((err) => this.#log(`restart failed: ${(err as Error).message}`))
      }, delay)
    })

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!this.#child) throw new Error('opencode exited before becoming ready')
      const info = await this.#probe(`http://127.0.0.1:${port}`, password, HEALTH_TIMEOUT_MS)
      if (info) {
        // A Windows PATH install is a `.cmd` shim, so the direct child is
        // cmd.exe and `/api/info.pid` is the grandchild. The random password
        // already proves this is our server; pid equality is only a hint.
        if (info.pid !== child.pid) {
          this.#log(`port ${port} answered with pid ${info.pid} (shim pid ${child.pid ?? 'none'})`)
        }
        if (!isSupportedVersion(info.version)) {
          throw new Error(`spawned opencode ${info.version} is outside ${SUPPORTED_OPENCODE_MAJOR_MINOR}.x`)
        }
        this.#mode = 'managed'
        this.#baseUrl = `http://127.0.0.1:${port}`
        this.#password = password
        this.#version = info.version
        this.#restarts = 0
        this.#log(`opencode ${info.version} ready on ${this.#baseUrl}`)
        return this.#baseUrl
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`opencode not ready within ${READY_TIMEOUT_MS}ms on port ${port}`)
  }

  async #probe(url: string, password: string | undefined, timeoutMs: number): Promise<OpencodeInfo | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (password) headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
      const response = await (this.#opts.fetchImpl ?? fetch)(`${url.replace(/\/+$/, '')}/api/info`, {
        headers,
        signal: controller.signal,
      })
      if (!response.ok) return null
      const info = (await response.json()) as Partial<OpencodeInfo>
      if (typeof info?.version !== 'string' || typeof info?.pid !== 'number') return null
      return { version: info.version, pid: info.pid, urls: info.urls, capabilities: info.capabilities }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  #kill(child: ChildProcess): Promise<void> {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve()
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      child.once('exit', finish)
      if (process.platform === 'win32' && child.pid !== undefined) {
        // A PATH install is a `.cmd` shim: killing cmd.exe leaves the real
        // opencode process holding the port and the SQLite file. taskkill /T
        // is the only way to take the tree down.
        spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
        setTimeout(finish, 2_000)
      } else {
        child.kill()
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          finish()
        }, 5_000)
      }
    })
  }

  #log(line: string) {
    if (this.#opts.onLog) this.#opts.onLog(line)
    else this.emit('log', line)
  }
}
