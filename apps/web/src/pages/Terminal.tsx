import { Terminal as TerminalIcon, RotateCcw } from 'lucide-react'
import ToolbarRow, { ToolbarIdentity } from '../components/ToolbarRow'
import RunnerSelector from '../components/RunnerSelector'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../lib/workspace'
import { runnerPath, runnerStorageKey } from '../lib/runner'

type ServerMessage =
  | { type: 'ready'; id: string; shell: string; cwd: string; attached: boolean }
  | { type: 'snapshot'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }

type Status = 'connecting' | 'open' | 'exited' | 'error'

/**
 * Which shell this browser tab owns.
 *
 * sessionStorage on purpose: it survives a reload (so a refresh lands back in
 * the same shell) and dies with the tab (so a second device, or a second tab,
 * gets its own). Deliberately *not* localStorage — sharing one shell between a
 * phone and a laptop is a different feature, and the resize fight between two
 * viewers of different widths is not worth it.
 */
const ID_KEY = runnerStorageKey('vibemobile.terminalId')

/** Reconnect attempts before giving up and showing the retry screen. */
const MAX_ATTEMPTS = 5
const MAX_BACKOFF = 8_000

/** Control codes for the keys a phone keyboard simply does not have. */
const KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '^Z', seq: '\x1a' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '/', seq: '/' },
]

export default function TerminalPage() {
  const defaultCwd = useWorkspaceStore((state) => state.defaultCwd)
  const workspaceLoaded = useWorkspaceStore((state) => state.loaded)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  /** The shell this tab is attached to; updated by every `ready`. */
  const idRef = useRef<string | null>(null)
  /**
   * Read inside the xterm callback, which is registered once.
   *
   * The socket is opened from the size *at open time*, not from live state, or
   * every rotation would tear the socket down and reattach. Later changes go
   * out as `resize` messages instead.
   */
  const sizeRef = useRef({ cols: 0, rows: 0 })
  const ctrlArmedRef = useRef(false)
  const attemptRef = useRef(0)
  const retryRef = useRef<number | undefined>(undefined)
  /** Set when the shell itself ended, so its close is not treated as a drop. */
  const exitedRef = useRef(false)

  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [shell, setShell] = useState('')
  const [ctrlArmed, setCtrlArmed] = useState(false)
  /** Flips once the first fit has produced a real geometry. */
  const [sized, setSized] = useState(false)
  const [generation, setGeneration] = useState(0)

  const setCtrl = useCallback((armed: boolean) => {
    ctrlArmedRef.current = armed
    setCtrlArmed(armed)
  }, [])

  const send = useCallback((message: unknown) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }, [])

  // ------------------------------------------------------------- terminal

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    idRef.current = sessionStorage.getItem(ID_KEY)

    const term = new XTerm({
      // Small enough that 80 columns fit in portrait on a 390pt-wide phone.
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: '#0f1115',
        foreground: '#d4d4d8',
        cursor: '#818cf8',
        selectionBackground: '#3f3f46',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term

    const syncSize = () => {
      try {
        fit.fit()
      } catch {
        /* container not laid out yet */
      }
      sizeRef.current = { cols: term.cols, rows: term.rows }
      // Only the first fit gates the socket; later ones are told to the shell.
      setSized(true)
      send({ type: 'resize', cols: term.cols, rows: term.rows })
    }
    // First fit must wait for layout, otherwise cols/rows come out as 2x1.
    requestAnimationFrame(syncSize)

    const dataSub = term.onData((data) => {
      if (ctrlArmedRef.current && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0)
        // Ctrl+A..Ctrl+Z map to 0x01..0x1a.
        if (code >= 65 && code <= 90) {
          send({ type: 'input', data: String.fromCharCode(code - 64) })
          setCtrl(false)
          return
        }
        setCtrl(false)
      }
      send({ type: 'input', data })
    })

    const observer = new ResizeObserver(syncSize)
    observer.observe(container)
    window.addEventListener('orientationchange', syncSize)

    term.focus()

    return () => {
      observer.disconnect()
      window.removeEventListener('orientationchange', syncSize)
      dataSub.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [send, setCtrl])

  // --------------------------------------------------------------- socket

  useEffect(() => {
    if (!sized || !workspaceLoaded || !defaultCwd) return
    let disposed = false
    exitedRef.current = false

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const query = new URLSearchParams({
      cwd: defaultCwd,
      cols: String(sizeRef.current.cols),
      rows: String(sizeRef.current.rows),
    })
    // An id the server no longer knows is not an error: it hands back a fresh
    // shell and a new id in `ready`.
    if (idRef.current) query.set('id', idRef.current)

    const socket = new WebSocket(`${proto}//${location.host}${runnerPath('/ws/terminal')}?${query}`)
    socketRef.current = socket
    setStatus('connecting')
    setError(null)

    socket.onopen = () => {
      if (disposed) return
      attemptRef.current = 0
      setStatus('open')
    }

    socket.onmessage = (event) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      const term = termRef.current
      switch (msg.type) {
        case 'ready':
          // The screen is about to be replaced wholesale by `snapshot`, so
          // whatever this xterm still holds (a previous connection's view after
          // a drop) has to go first or it shows through.
          term?.reset()
          // Guarded: a server older than this page does not send an id, and
          // storing the string "undefined" would then be sent back as one.
          if (msg.id) {
            idRef.current = msg.id
            sessionStorage.setItem(ID_KEY, msg.id)
          }
          setShell(msg.shell)
          // Only a brand-new shell gets the banner: writing into a restored
          // screen would put a line on it that the server's mirror does not
          // have, and the two drift apart from then on.
          if (!msg.attached) term?.writeln(`\x1b[90m${msg.shell} · ${msg.cwd}\x1b[0m\r\n`)
          else setNotice('已接回上次的终端')
          break
        case 'snapshot':
          term?.write(msg.data)
          break
        case 'output':
          term?.write(msg.data)
          break
        case 'exit':
          exitedRef.current = true
          setStatus('exited')
          term?.writeln(`\r\n\x1b[90m[进程已退出，代码 ${msg.exitCode}]\x1b[0m`)
          break
        case 'error':
          setStatus('error')
          setError(msg.message)
          break
        default:
          break
      }
    }

    socket.onclose = (event) => {
      if (disposed) return
      socketRef.current = null
      // 4401 is the session cookie; 4400 means the server already said why.
      if (event.code === 4401) {
        setStatus('error')
        setError('登录已过期，请重新登录')
        return
      }
      if (event.code === 4400 || exitedRef.current) {
        setStatus((prev) => (prev === 'error' ? prev : 'exited'))
        return
      }
      // An unexpected drop. Now that the shell outlives the socket, coming back
      // is lossless, so it is worth doing without being asked.
      if (attemptRef.current >= MAX_ATTEMPTS) {
        setStatus('error')
        setError('连接已断开，请重试')
        return
      }
      const delay = Math.min(500 * 2 ** attemptRef.current, MAX_BACKOFF)
      attemptRef.current++
      setStatus('connecting')
      retryRef.current = window.setTimeout(() => {
        retryRef.current = undefined
        setGeneration((g) => g + 1)
      }, delay)
    }

    socket.onerror = () => {
      // onclose always follows; the retry lives there.
    }

    return () => {
      disposed = true
      if (retryRef.current !== undefined) {
        clearTimeout(retryRef.current)
        retryRef.current = undefined
      }
      socket.close()
      socketRef.current = null
    }
  }, [sized, generation, defaultCwd, workspaceLoaded])

  // Keepalive: phones drop idle sockets aggressively, and a shell that looks
  // alive but is not is worse than one that reconnects.
  useEffect(() => {
    const timer = setInterval(() => send({ type: 'ping' }), 45_000)
    return () => clearInterval(timer)
  }, [send])

  // The reattach notice is for the moment of arrival, not for the session.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 3000)
    return () => clearTimeout(timer)
  }, [notice])

  // --------------------------------------------------------------- render

  const retryNow = useCallback(() => {
    attemptRef.current = 0
    setGeneration((g) => g + 1)
  }, [])

  /**
   * Two different things, and the distinction is the whole feature: 重开 means
   * "same tab, new shell" (the server respawns it under the same id), while a
   * dead socket means "same shell, new socket" — and that one must keep the id.
   */
  const onReopen = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) send({ type: 'restart' })
    else retryNow()
  }, [send, retryNow])

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      <header className="safe-top shrink-0 border-b border-border bg-background/95 backdrop-blur-xl">
        <ToolbarRow>
          <ToolbarIdentity icon={TerminalIcon} label="终端" />
          <RunnerSelector compact />
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              status === 'open' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-muted-foreground'
            }`}
          />
          <span
            role="status"
            title={error ?? notice ?? shell ?? '正在启动 shell…'}
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          >
            {error ?? notice ?? shell?.split(/[\\/]/).pop() ?? '…'}
          </span>
          <button
            type="button"
            onClick={onReopen}
            aria-label={status === 'open' ? '重开终端' : '重连终端'}
            title={status === 'open' ? '重开终端' : '重连终端'}
            className="tap shrink-0 rounded-xl text-muted-foreground active:bg-secondary"
          >
            <RotateCcw aria-hidden="true" className="size-5" strokeWidth={1.8} />
          </button>
        </ToolbarRow>
      </header>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden px-1 pt-1" />

      {/* Phone keyboards have no Esc/Ctrl/arrows — this row is what makes the
          terminal usable at all on a touch device. */}
      <div className="safe-bottom shrink-0 border-t border-border bg-card">
        <div className="scroll-x flex gap-1.5 px-2 py-2">
          <button
            type="button"
            onClick={() => setCtrl(!ctrlArmed)}
            className={`shrink-0 rounded-lg px-3 py-2 text-[12px] ${
              ctrlArmed ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
            }`}
          >
            Ctrl
          </button>
          {KEYS.map((key) => (
            <button
              type="button"
              key={key.label}
              onClick={() => send({ type: 'input', data: key.seq })}
              className="shrink-0 rounded-lg bg-secondary px-3 py-2 font-mono text-[12px] text-foreground/90 active:bg-raised"
            >
              {key.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
