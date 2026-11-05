/**
 * Owns the lifecycle of the `codex app-server` child process.
 *
 * Two modes:
 *  - managed (default): spawn and babysit our own app-server on a loopback port.
 *  - attach: connect to an app-server someone else is running (CODEX_WS_URL).
 *
 * The server must bind loopback: app-server refuses to start a non-loopback
 * WS listener without auth, and we never want this port reachable anyway.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolveCodexBin } from '../agents/runtime.js'
import { codexProfileLaunch, type AgentConnection } from '../agents/profileRuntime.js'

export interface SupervisorOptions {
  /** When set, we attach to this URL instead of spawning. */
  attachUrl?: string
  host?: string
  port?: number
  /** Extra args passed through to `codex app-server`. */
  extraArgs?: string[]
  /** Working directory for the app-server process itself. */
  cwd?: string
  /** Explicit Codex entry point (CODEX_BIN). Wins over runtime packs. */
  bin?: string
  /** Runtime packs directory; `current` is re-read on every spawn. */
  agentsDir?: string
  onLog?: (line: string) => void
  connection?: AgentConnection
}

export class AppServerSupervisor extends EventEmitter {
  #opts: Required<Omit<SupervisorOptions, 'attachUrl' | 'bin' | 'agentsDir' | 'onLog' | 'connection'>> & {
    bin?: string
    agentsDir?: string
    attachUrl?: string
    onLog?: (line: string) => void
    connection?: AgentConnection
  }
  #child?: ChildProcess
  #stopping = false
  #restarts = 0
  /** Pending crash-backoff spawn, so restart() can cancel it. */
  #restartTimer?: NodeJS.Timeout

  constructor(opts: SupervisorOptions = {}) {
    super()
    this.#opts = {
      host: '127.0.0.1',
      port: 8788,
      extraArgs: [],
      cwd: process.cwd(),
      ...opts,
    }
  }

  get url(): string {
    if (this.#opts.attachUrl) return this.#opts.attachUrl
    return `ws://${this.#opts.host}:${this.#opts.port}`
  }

  get isManaged(): boolean {
    return !this.#opts.attachUrl
  }

  async start(): Promise<void> {
    if (this.#opts.attachUrl) {
      this.#log(`attaching to external app-server at ${this.#opts.attachUrl}`)
      return
    }
    if (this.#child) return
    this.#spawn()
    await this.#waitForReady()
  }

  #spawn() {
    // A backoff timer may already be waiting to do this; two children would
    // fight over the listen port and restart-loop each other.
    if (this.#child) return
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = undefined
    }
    // Resolved on every spawn, never cached: switching a runtime pack's
    // `current` must take effect on the respawn that follows the update.
    const { cmd, args } = resolveCodexBin({ bin: this.#opts.bin, agentsDir: this.#opts.agentsDir })
    const profile = codexProfileLaunch(this.#opts.connection?.())
    const fullArgs = [
      ...args,
      ...profile.args,
      'app-server',
      '--listen',
      `ws://${this.#opts.host}:${this.#opts.port}`,
      ...this.#opts.extraArgs,
    ]
    this.#log(`spawning: ${cmd} ${fullArgs.join(' ')}`)
    const child = spawn(cmd, fullArgs, {
      cwd: this.#opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...profile.env },
      // Behind PM2 / a service there is no console to inherit, so the Codex
      // launcher (node.exe) otherwise gets a new visible console window.
      windowsHide: true,
    })
    this.#child = child

    const pipe = (stream: NodeJS.ReadableStream | null, tag: string) => {
      stream?.on('data', (buf: Buffer) => {
        for (const line of buf.toString().split(/\r?\n/)) {
          if (line.trim()) this.#log(`[${tag}] ${line}`)
        }
      })
    }
    pipe(child.stdout, 'app-server')
    pipe(child.stderr, 'app-server:err')

    child.on('exit', (code, signal) => {
      this.#child = undefined
      this.#log(`app-server exited (code=${code} signal=${signal})`)
      this.emit('exit', code, signal)
      if (this.#stopping) return
      // Restart with a bounded backoff. The clients above us handle
      // reconnection and will re-resume their threads.
      const delay = Math.min(500 * 2 ** this.#restarts, 15_000)
      this.#restarts++
      this.#log(`restarting app-server in ${delay}ms`)
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = undefined
        if (this.#stopping) return
        this.#spawn()
      }, delay)
    })
  }

  async #waitForReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const readyUrl = `http://${this.#opts.host}:${this.#opts.port}/readyz`
    while (Date.now() < deadline) {
      if (!this.#child) {
        // Process died during startup; the exit handler will retry.
        throw new Error('app-server exited before becoming ready')
      }
      try {
        const res = await fetch(readyUrl)
        if (res.ok) {
          this.#restarts = 0
          this.#log('app-server is ready')
          return
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`app-server not ready within ${timeoutMs}ms (${readyUrl})`)
  }

  #log(line: string) {
    if (this.#opts.onLog) this.#opts.onLog(line)
    else this.emit('log', line)
  }

  /**
   * Replace the running app-server with a fresh spawn, picking up whatever the
   * runtime pack's `current` points at now.
   *
   * Deliberately not `stop()` + `start()`: `stop()` leaves `#stopping` set, so
   * the exit handler would swallow the respawn. In-flight turns are lost — the
   * caller warns the user before asking for this.
   */
  async restart(): Promise<void> {
    if (this.#opts.attachUrl) return
    const child = this.#child
    if (child) {
      this.#stopping = true
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        child.once('exit', done)
        child.kill()
        setTimeout(() => {
          if (this.#child) this.#child.kill('SIGKILL')
          resolve()
        }, 5_000)
      })
      this.#stopping = false
    }
    this.#restarts = 0
    this.#spawn()
    await this.#waitForReady()
  }

  async stop(): Promise<void> {
    this.#stopping = true
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = undefined
    }
    const child = this.#child
    if (!child) return
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      child.once('exit', done)
      child.kill()
      // Windows can be slow to reap; don't hang shutdown forever.
      setTimeout(() => {
        if (this.#child) this.#child.kill('SIGKILL')
        resolve()
      }, 5_000)
    })
  }
}
