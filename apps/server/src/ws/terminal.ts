/**
 * Direct PTY bridge: a real shell on the host, streamed to the browser.
 *
 * This is a strictly larger capability than the agent itself — the agent at
 * least has a sandbox policy, whereas this is an unrestricted shell — so it
 * sits behind the same session cookie as everything else, is capped in
 * concurrency, and can be switched off entirely with VIBEMOBILE_TERMINAL=off.
 *
 * The shell belongs to the *terminal*, not to the socket. A socket closing —
 * the phone navigated to another tab, the browser reloaded, the network
 * dropped — only detaches: the PTY keeps running and a reconnecting client
 * attaches to it and gets the screen back as a snapshot. That is the same
 * principle the chat side runs on (`Query` lives in this process, not in the
 * browser's connection), and a terminal is where a user notices its absence
 * most: a `cd`'d directory and a running build are the state.
 *
 * node-pty is loaded lazily: it is a native module, and a machine where the
 * build failed should still get a working app with the terminal tab hidden
 * rather than a server that refuses to boot. (`@xterm/headless` and the
 * serialize addon, which mirror the screen for that snapshot, are pure JS and
 * are imported normally.)
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { IPty } from 'node-pty'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { verifySession, COOKIE_NAME } from '../auth/jwt.js'
import type { Config } from '../config.js'
import { resolveDirectory } from '../files/workspace.js'

type PtyModule = typeof import('node-pty')

/** Hard cap so a stuck client cannot fork-bomb the host with shells. */
const MAX_SESSIONS = 4
/** Output is chunked at the pty layer already; this caps a single WS frame. */
const MAX_FRAME_CHARS = 256 * 1024
/**
 * Rows of scrollback kept in the server-side mirror, and therefore the most a
 * snapshot can carry. Deliberately NOT the browser's 5000: this string goes
 * over a phone's WiFi, and nobody scrolls back a thousand lines on a phone.
 */
const SNAPSHOT_SCROLLBACK = 1000
/** The reaper's tick. The timeout it applies is `config.terminal.idleTimeoutMs`. */
const SWEEP_MS = 60_000
/** How long an attaching client can be held before its snapshot, in bytes. */
const MAX_PENDING_CHARS = 256 * 1024

type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'restart' }
  | { type: 'ping' }

type ServerMessage =
  | { type: 'ready'; id: string; shell: string; cwd: string; attached: boolean }
  | { type: 'snapshot'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }

/**
 * One attached browser socket.
 *
 * `ready` is the gate between "the snapshot is coming" and "output flows":
 * output that reaches this client in between has to be held in `pending`,
 * because it is not in the snapshot and sending it early would put it *before*
 * the screen it belongs after.
 */
type Conn = { socket: WebSocket; ready: boolean; pending: string[] }

/** One shell, with everything a browser needs to pick it back up. */
type TerminalRecord = {
  id: string
  pty: IPty
  /** A headless xterm fed the exact same bytes, so a screen can be re-created. */
  mirror: HeadlessTerminal
  serialize: SerializeAddon
  /** Subscriptions to the *current* pty; replaced wholesale on restart. */
  subs: { dispose(): void }[]
  conns: Set<Conn>
  cols: number
  rows: number
  shell: string
  cwd: string
  /** Last client message, or the moment the last client left — the reaper's clock. */
  lastActivity: number
}

type MirrorCtor = new (options: ConstructorParameters<typeof HeadlessTerminal>[0]) => HeadlessTerminal

let ptyModule: PtyModule | null = null
let ptyLoadError: string | null = null
let mirrorCtor: MirrorCtor | null = null

async function loadPty(): Promise<PtyModule> {
  if (ptyModule) return ptyModule
  if (ptyLoadError) throw new Error(ptyLoadError)
  try {
    ptyModule = await import('node-pty')
    return ptyModule
  } catch (err) {
    ptyLoadError =
      `终端不可用：node-pty 加载失败（${(err as Error).message}）。` +
      '本机可能需要安装 C++ 构建工具后重新 npm install。'
    throw new Error(ptyLoadError)
  }
}

/**
 * The headless terminal class.
 *
 * Dynamic on purpose, and not for lazy-loading: `@xterm/headless` is CommonJS
 * with no `exports` map, and Node does not detect the named export in it, so a
 * static `import { Terminal }` type-checks and then throws at load time in the
 * built ESM. (`@xterm/addon-serialize` next to it is a plain import — its named
 * export *is* detected.)
 *
 * Both shapes are handled because the two runtimes in this repo disagree: Node
 * gives `{ default: { Terminal } }`, while tsx — which the scripts run under —
 * gives `{ Terminal }` and no `default` at all.
 */
async function loadMirror(): Promise<MirrorCtor> {
  if (mirrorCtor) return mirrorCtor
  const mod = (await import('@xterm/headless')) as unknown as {
    default?: { Terminal: MirrorCtor }
    Terminal?: MirrorCtor
  }
  const ctor = mod.default?.Terminal ?? mod.Terminal
  if (!ctor) {
    throw new Error('终端不可用：@xterm/headless 没有导出 Terminal。')
  }
  mirrorCtor = ctor
  return mirrorCtor
}

/** Whether the terminal feature can work at all — surfaced to the UI. */
export async function terminalAvailability(config: Config): Promise<{
  enabled: boolean
  reason?: string
}> {
  if (!config.terminal.enabled) return { enabled: false, reason: '终端已在服务端关闭（VIBEMOBILE_TERMINAL=off）' }
  try {
    // Both halves: without the mirror there is no snapshot, and a terminal that
    // silently loses its screen on every reattach is worse than a hidden tab.
    await Promise.all([loadPty(), loadMirror()])
    return { enabled: true }
  } catch (err) {
    return { enabled: false, reason: (err as Error).message }
  }
}

/** A geometry from the query string, or the classic 80x24 if it is nonsense. */
function dimension(raw: unknown, max: number, fallback: number): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 2) return fallback
  return Math.min(n, max)
}

export function registerTerminal(app: FastifyInstance, config: Config): void {
  const terminals = new Map<string, TerminalRecord>()

  // ------------------------------------------------------------- lifecycle

  /** Stop the shell and forget its screen. Sockets attached to it are closed. */
  function kill(record: TerminalRecord, reason: string): void {
    terminals.delete(record.id)
    for (const sub of record.subs) sub.dispose()
    record.subs = []
    try {
      record.pty.kill()
    } catch {
      /* already gone */
    }
    try {
      record.mirror.dispose()
    } catch {
      /* already disposed */
    }
    for (const conn of record.conns) conn.socket.close(1000, reason)
    record.conns.clear()
  }

  /**
   * Spawn (or respawn) the shell behind a record.
   *
   * `subs` is replaced rather than added to: a restart must stop listening to
   * the pty it is killing *before* killing it, or the dead shell's `onExit`
   * tears down the record that is supposed to survive it.
   */
  function startShell(record: TerminalRecord, mod: PtyModule, cwd: string, shell: string): void {
    const pty = mod.spawn(shell, [], {
      name: 'xterm-256color',
      cols: record.cols,
      rows: record.rows,
      cwd,
      // ConPTY reports TERM poorly; setting it here gives the shell (and
      // anything it launches) colour support.
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      // Windows only. The bundled conpty.dll takes the kill path that closes
      // the input handle, instead of the one that forks a helper process to
      // enumerate console PIDs. That helper fails with "AttachConsole failed"
      // when the server has no console of its own (running detached), which
      // both litters the log and makes every kill wait out its 5s timeout.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
    })

    record.pty = pty
    record.shell = shell
    record.cwd = cwd
    record.mirror.reset()
    record.mirror.resize(record.cols, record.rows)

    const dataSub = pty.onData((data) => {
      // Extremely large frames are dropped rather than buffered: a runaway
      // `yes` should not be able to grow the server's memory unbounded. The
      // mirror is fed the same way, so after such a drop it can disagree with
      // the real screen until something clears it — accepted, and the reason
      // this stays a single frame cap rather than a byte budget.
      if (data.length > MAX_FRAME_CHARS) return
      record.mirror.write(data)
      for (const conn of record.conns) {
        if (conn.ready) send(conn.socket, { type: 'output', data })
        else if (conn.pending.length < MAX_PENDING_CHARS) conn.pending.push(data)
      }
    })

    const exitSub = pty.onExit(({ exitCode }) => {
      // Before the kill, not after: `kill` closes these sockets, and a closed
      // socket cannot carry the reason. Sent the other way round, `exit` never
      // arrives and the client can only report the connection as dropped.
      for (const conn of record.conns) send(conn.socket, { type: 'exit', exitCode })
      kill(record, 'shell exited')
    })

    record.subs = [dataSub, exitSub]
  }

  /**
   * Hand a record to a socket: geometry first, then the screen, then the
   * output that arrived while the screen was being serialized.
   *
   * `attached` says whether this socket joined a shell that was already there
   * or is looking at one that was just created — the only thing the client
   * cannot work out for itself, and the difference between drawing a banner
   * and drawing it over a restored screen.
   */
  function attach(record: TerminalRecord, socket: WebSocket, cols: number, rows: number, attached: boolean): void {
    const sizeChanged = cols !== record.cols || rows !== record.rows
    if (sizeChanged) {
      // Both halves or neither: the mirror is only useful if it wraps exactly
      // where the browser wraps, and the pty resize is what makes a full-screen
      // app (vim, htop) repaint itself for the new size.
      try {
        record.pty.resize(cols, rows)
      } catch {
        /* raced with exit */
      }
      record.mirror.resize(cols, rows)
      record.cols = cols
      record.rows = rows
    }

    const conn: Conn = { socket, ready: false, pending: [] }
    record.conns.add(conn)
    record.lastActivity = Date.now()

    send(socket, {
      type: 'ready',
      id: record.id,
      shell: record.shell,
      cwd: record.cwd,
      attached,
    })

    // The barrier. `mirror.write` parses in a queue, so a callback queued after
    // this one has every byte already enqueued *in front of it* parsed into the
    // screen — which is precisely "the screen as of now". Serializing without
    // it races the parser and ships a screen that is missing its last chunk.
    record.mirror.write('', () => {
      if (!record.conns.has(conn)) return
      send(socket, {
        type: 'snapshot',
        data: record.serialize.serialize({
          scrollback: SNAPSHOT_SCROLLBACK,
          // A full-screen app that was reflowed has painted a frame for the old
          // size, and it is about to repaint (the resize above gave it
          // SIGWINCH). Shipping that frame would paint it over the repaint.
          // Same size: no repaint is coming, so the alt buffer *is* the screen.
          excludeAltBuffer: sizeChanged,
          // Modes carry the alt-buffer switch itself, cursor visibility,
          // bracketed paste… dropping them restores a ragged screen.
          excludeModes: false,
        }),
      })
      for (const chunk of conn.pending) send(socket, { type: 'output', data: chunk })
      conn.pending = []
      conn.ready = true
    })
  }

  // ---------------------------------------------------------------- routes

  app.get<{ Querystring: { id?: string; cwd?: string; cols?: string; rows?: string } }>(
    '/ws/terminal',
    { websocket: true },
    async (socket, req) => {
      if (!config.authDisabled) {
        const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE_NAME]
        if (!verifySession(config, token)) {
          socket.close(4401, 'unauthorized')
          return
        }
      }

      const fail = (message: string, code = 4400) => {
        send(socket, { type: 'error', message })
        socket.close(code, 'unavailable')
      }

      if (!config.terminal.enabled) {
        fail('终端已在服务端关闭')
        return
      }

      const cols = dimension(req.query.cols, 500, 80)
      const rows = dimension(req.query.rows, 200, 24)

      // An id that names a live shell is an attach. An id nobody knows — the
      // record was reaped, or the server restarted under it — is not an error:
      // the client gets a new shell and learns the new id from `ready`.
      const found = req.query.id ? terminals.get(req.query.id) : undefined
      if (found) {
        hook(socket, found, cols, rows, true)
        return
      }

      let cwd: string
      try {
        cwd = await resolveDirectory(config.workspaceRoots, req.query.cwd ?? config.workspaceRoots[0] ?? process.cwd())
      } catch (err) {
        fail((err as Error).message)
        return
      }

      // Only *new* shells are capped. Attaching is not a new shell, and a cap
      // that counted tabs was always a lie once a tab could leave and come back.
      if (terminals.size >= MAX_SESSIONS) {
        const idlest = [...terminals.values()]
          .filter((record) => record.conns.size === 0)
          .sort((a, b) => a.lastActivity - b.lastActivity)[0]
        if (!idlest) {
          fail(`同时最多 ${MAX_SESSIONS} 个终端，请先在别的设备上退出`)
          return
        }
        app.log.info({ id: idlest.id }, 'terminal evicted to make room')
        kill(idlest, 'evicted')
      }

      let mod: PtyModule
      let Mirror: MirrorCtor
      try {
        ;[mod, Mirror] = await Promise.all([loadPty(), loadMirror()])
      } catch (err) {
        fail((err as Error).message)
        return
      }

      const record: TerminalRecord = {
        id: randomUUID(),
        pty: null as unknown as IPty,
        // Constructed with the geometry because cols/rows are init-only
        // options: the mirror has to be the same width as the pty from the
        // first byte, and `attach` is the only other place that may change it.
        mirror: new Mirror({ cols, rows, scrollback: SNAPSHOT_SCROLLBACK, allowProposedApi: true }),
        serialize: new SerializeAddon(),
        subs: [],
        conns: new Set(),
        cols,
        rows,
        shell: config.terminal.shell,
        cwd,
        lastActivity: Date.now(),
      }
      // The addon's typings ask for the browser terminal, which the headless
      // one is not assignable to (it has no DOM to be missing). Same parser,
      // same buffer, no renderer — which is all `serialize()` reads.
      record.serialize.activate(record.mirror as unknown as Parameters<SerializeAddon['activate']>[0])
      terminals.set(record.id, record)

      try {
        startShell(record, mod, cwd, config.terminal.shell)
      } catch (err) {
        terminals.delete(record.id)
        record.mirror.dispose()
        fail((err as Error).message)
        return
      }

      // A new record, whether the id was absent or one the server has since
      // forgotten. Both are "here is a shell for you", not "here is yours back".
      hook(socket, record, cols, rows, false)
    },
  )

  /** Wire a socket to a record: attach, then every message it can send. */
  function hook(socket: WebSocket, record: TerminalRecord, cols: number, rows: number, attached: boolean): void {
    attach(record, socket, cols, rows, attached)

    let detached = false
    const detach = () => {
      if (detached) return
      detached = true
      for (const conn of record.conns) {
        if (conn.socket === socket) record.conns.delete(conn)
      }
      // The idle clock starts when the last client leaves, not when it last
      // typed: a shell sitting behind a tab that was closed hours ago is what
      // the reaper is for.
      record.lastActivity = Date.now()
    }

    socket.on('message', (raw: Buffer) => {
      record.lastActivity = Date.now()
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      switch (msg.type) {
        case 'input':
          if (typeof msg.data === 'string') record.pty.write(msg.data)
          break
        case 'resize':
          // A zero dimension makes ConPTY throw; ignore rather than kill.
          if (msg.cols > 0 && msg.rows > 0) {
            const nextCols = Math.min(msg.cols, 500)
            const nextRows = Math.min(msg.rows, 200)
            try {
              record.pty.resize(nextCols, nextRows)
            } catch {
              /* resize raced with exit */
            }
            // The mirror has to follow, or the next snapshot wraps at a width
            // the browser is not using. (Two attached viewers with different
            // sizes is last-writer-wins; with an id per browser tab that is
            // rare enough to leave alone.)
            record.mirror.resize(nextCols, nextRows)
            record.cols = nextCols
            record.rows = nextRows
          }
          break
        case 'restart':
          restart()
          break
        case 'ping':
          send(socket, { type: 'pong' })
          break
      }
    })

    /**
     * Same id, brand-new shell. The id is what the browser remembers, so a
     * restart that minted a new one would look like a reaped terminal.
     */
    function restart(): void {
      if (!config.terminal.enabled) return
      void loadPty()
        .then((mod) => {
          for (const conn of record.conns) {
            // Any client still waiting for a snapshot was waiting for the shell
            // that is about to die; release it rather than leaving it gated.
            conn.ready = true
            conn.pending = []
          }
          for (const sub of record.subs) sub.dispose()
          record.subs = []
          try {
            record.pty.kill()
          } catch {
            /* already gone */
          }
          startShell(record, mod, record.cwd, config.terminal.shell)
          for (const conn of record.conns) {
            send(conn.socket, {
              type: 'ready',
              id: record.id,
              shell: record.shell,
              cwd: record.cwd,
              attached: false,
            })
          }
        })
        .catch((err) => send(socket, { type: 'error', message: (err as Error).message }))
    }

    socket.on('close', detach)
    socket.on('error', detach)
  }

  // ------------------------------------------------------------------ reap

  const reaper = setInterval(() => {
    const now = Date.now()
    for (const record of [...terminals.values()]) {
      // Unattached only, and not "nobody typed": a build that has been printing
      // for twenty minutes with the phone in a pocket is exactly what must
      // survive, and an open tab keeps its shell by pinging.
      if (record.conns.size === 0 && now - record.lastActivity > config.terminal.idleTimeoutMs) {
        app.log.info({ id: record.id }, 'terminal idled out')
        kill(record, 'idle')
      }
    }
  }, SWEEP_MS)
  reaper.unref?.()

  app.addHook('onClose', async () => {
    clearInterval(reaper)
    for (const record of [...terminals.values()]) kill(record, 'server shutting down')
  })
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== 1) return
  try {
    socket.send(JSON.stringify(message))
  } catch {
    /* socket died mid-send */
  }
}
