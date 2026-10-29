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
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)

export interface SupervisorOptions {
  /** When set, we attach to this URL instead of spawning. */
  attachUrl?: string
  host?: string
  port?: number
  /** Extra args passed through to `codex app-server`. */
  extraArgs?: string[]
  /** Working directory for the app-server process itself. */
  cwd?: string
  onLog?: (line: string) => void
}

/**
 * The native executable inside `@openai/codex`'s optional platform packages.
 * Mirrors `bin/codex.js` (pinned with the CLI version) so we can spawn the
 * binary directly.
 *
 * Why not the launcher: `codex.js` spawns the native binary without
 * `windowsHide`, and the grandchild then gets its own console window when the
 * parent has none (PM2, a Windows service). Spawning the binary ourselves with
 * `windowsHide: true` is the only way to keep that window from appearing.
 */
const PLATFORM_BINARIES: Record<string, { package: string; triple: string; file: string }> = {
  'linux-x64': { package: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', file: 'codex' },
  'linux-arm64': { package: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', file: 'codex' },
  'darwin-x64': { package: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', file: 'codex' },
  'darwin-arm64': { package: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', file: 'codex' },
  'win32-x64': { package: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', file: 'codex.exe' },
  'win32-arm64': { package: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', file: 'codex.exe' },
}

/**
 * Locate the codex entry point without relying on PATH or shell shims.
 * Prefers the native binary; falls back to `bin/codex.js` (for installs where
 * the optional platform package was skipped) and finally to PATH.
 */
function resolveCodexBin(): { cmd: string; args: string[] } {
  const target = PLATFORM_BINARIES[`${process.platform}-${process.arch}`]
  if (target) {
    try {
      const pkg = require.resolve(`${target.package}/package.json`)
      const binary = path.join(path.dirname(pkg), 'vendor', target.triple, 'bin', target.file)
      if (existsSync(binary)) return { cmd: binary, args: [] }
    } catch {
      // Optional dependency absent — fall through to the JS launcher.
    }
  }
  try {
    const pkg = require.resolve('@openai/codex/package.json')
    const shim = path.join(path.dirname(pkg), 'bin', 'codex.js')
    return { cmd: process.execPath, args: [shim] }
  } catch {
    // Fall back to PATH.
    return { cmd: 'codex', args: [] }
  }
}

export class AppServerSupervisor extends EventEmitter {
  #opts: Required<Omit<SupervisorOptions, 'attachUrl' | 'onLog'>> & {
    attachUrl?: string
    onLog?: (line: string) => void
  }
  #child?: ChildProcess
  #stopping = false
  #restarts = 0

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
    const { cmd, args } = resolveCodexBin()
    const fullArgs = [
      ...args,
      'app-server',
      '--listen',
      `ws://${this.#opts.host}:${this.#opts.port}`,
      ...this.#opts.extraArgs,
    ]
    this.#log(`spawning: ${cmd} ${fullArgs.join(' ')}`)
    const child = spawn(cmd, fullArgs, {
      cwd: this.#opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
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
      setTimeout(() => {
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

  async stop(): Promise<void> {
    this.#stopping = true
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
