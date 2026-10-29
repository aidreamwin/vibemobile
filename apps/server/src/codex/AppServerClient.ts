/**
 * WebSocket JSON-RPC client for `codex app-server`.
 *
 * Protocol notes (verified against openai/codex @ rust-v0.154.0):
 *  - Not real JSON-RPC 2.0: neither side sends a `jsonrpc` field.
 *  - Envelope is dispatched structurally:
 *      has `method`                    -> request (has `id`) or notification
 *      has `id` and `result`/`error`   -> response
 *  - Server -> client requests (approvals) MUST be answered. Leaving one
 *    unanswered hangs the turn until the server times out. Anything we do not
 *    implement is answered with -32601.
 *  - There is no protocol version negotiation.
 *  - The server rejects WS upgrades carrying an `Origin` header, so this must
 *    only ever be used server-side. `ws` omits Origin by default.
 */
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

export interface AppServerClientOptions {
  url: string
  clientName?: string
  clientVersion?: string
  /** Enable experimental protocol surface (available_decisions, plan deltas…). */
  experimentalApi?: boolean
  /** Suppress notification methods we know we ignore, to cut bandwidth. */
  optOutNotificationMethods?: string[]
  requestTimeoutMs?: number
  /** Backoff schedule for reconnects, in ms. Last value repeats. */
  reconnectDelays?: number[]
}

export interface ServerRequestContext {
  id: number | string
  method: string
  params: unknown
  /** Send a successful result back to the server. */
  respond: (result: unknown) => void
  /** Send a JSON-RPC error back to the server. */
  fail: (code: number, message: string) => void
}

export type ServerRequestHandler = (ctx: ServerRequestContext) => void

type State = 'idle' | 'connecting' | 'ready' | 'closing' | 'closed'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  method: string
  timer: NodeJS.Timeout
}

const DEFAULT_RECONNECT_DELAYS = [500, 1_000, 2_000, 5_000, 10_000, 15_000]

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: event overloads need declaration merging
export declare interface AppServerClient {
  on(event: 'notification', listener: (method: string, params: any) => void): this
  on(event: 'ready', listener: (info: { userAgent: string; platformOs: string }) => void): this
  /** Emitted after a reconnect; thread subscriptions must be re-established. */
  on(event: 'reconnected', listener: () => void): this
  on(event: 'disconnected', listener: (err?: Error) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  emit(event: string, ...args: any[]): boolean
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: event overloads need declaration merging
export class AppServerClient extends EventEmitter {
  readonly #opts: Required<Omit<AppServerClientOptions, 'optOutNotificationMethods'>> & {
    optOutNotificationMethods: string[]
  }

  #ws?: WebSocket
  #state: State = 'idle'
  #nextId = 1
  #pending = new Map<number, Pending>()
  #serverRequestHandler?: ServerRequestHandler
  #reconnectAttempt = 0
  #reconnectTimer?: NodeJS.Timeout
  #hasConnectedBefore = false

  constructor(opts: AppServerClientOptions) {
    super()
    this.#opts = {
      clientName: 'vibemobile',
      clientVersion: '0.1.0',
      experimentalApi: true,
      requestTimeoutMs: 60_000,
      reconnectDelays: DEFAULT_RECONNECT_DELAYS,
      optOutNotificationMethods: [],
      ...opts,
    }
  }

  get state(): State {
    return this.#state
  }

  get isReady(): boolean {
    return this.#state === 'ready'
  }

  /**
   * Register the handler for server-initiated requests (approvals).
   * Unhandled methods are automatically answered with -32601.
   */
  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.#serverRequestHandler = handler
  }

  async start(): Promise<void> {
    if (this.#state === 'ready' || this.#state === 'connecting') return
    this.#state = 'idle'
    return this.#connect()
  }

  #connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#state = 'connecting'
      const ws = new WebSocket(this.#opts.url)
      this.#ws = ws

      const onInitialError = (err: Error) => {
        ws.off('open', onOpen)
        reject(err)
      }

      const onOpen = () => {
        ws.off('error', onInitialError)
        this.#handshake()
          .then((info) => {
            this.#state = 'ready'
            this.#reconnectAttempt = 0
            this.emit('ready', info)
            if (this.#hasConnectedBefore) this.emit('reconnected')
            this.#hasConnectedBefore = true
            resolve()
          })
          .catch((err: Error) => {
            this.#state = 'closed'
            ws.close()
            reject(err)
          })
      }

      ws.once('open', onOpen)
      ws.once('error', onInitialError)
      ws.on('message', (raw: WebSocket.RawData) => this.#onMessage(raw.toString()))
      ws.on('close', () => this.#onClose())
      ws.on('error', (err: Error) => this.emit('error', err))
    })
  }

  async #handshake(): Promise<{ userAgent: string; platformOs: string }> {
    const res = (await this.request('initialize', {
      clientInfo: {
        name: this.#opts.clientName,
        title: 'VibeMobile',
        version: this.#opts.clientVersion,
      },
      capabilities: {
        experimentalApi: this.#opts.experimentalApi,
        ...(this.#opts.optOutNotificationMethods.length
          ? { optOutNotificationMethods: this.#opts.optOutNotificationMethods }
          : {}),
      },
    })) as { userAgent: string; platformOs: string }

    // Optional per the server (it only logs client notifications), but cheap.
    this.notify('initialized', {})
    return res
  }

  #onMessage(text: string) {
    let msg: any
    try {
      msg = JSON.parse(text)
    } catch {
      this.emit('error', new Error(`non-JSON frame from app-server: ${text.slice(0, 200)}`))
      return
    }

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.#pending.get(msg.id)
      if (!pending) return // late response after timeout/disconnect
      this.#pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) {
        const e = new Error(
          typeof msg.error === 'string' ? msg.error : (msg.error.message ?? JSON.stringify(msg.error)),
        )
        ;(e as any).code = msg.error?.code
        ;(e as any).data = msg.error?.data
        pending.reject(e)
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    // Server -> client request. Must always be answered.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.#onServerRequest(msg)
      return
    }

    if (typeof msg.method === 'string') {
      this.emit('notification', msg.method, msg.params ?? {})
    }
  }

  #onServerRequest(msg: { id: number | string; method: string; params?: unknown }) {
    const ctx: ServerRequestContext = {
      id: msg.id,
      method: msg.method,
      params: msg.params ?? {},
      respond: (result) => this.#send({ id: msg.id, result: result ?? {} }),
      fail: (code, message) => this.#send({ id: msg.id, error: { code, message } }),
    }
    if (this.#serverRequestHandler) {
      try {
        this.#serverRequestHandler(ctx)
        return
      } catch (err) {
        this.emit('error', err as Error)
      }
    }
    // Never silently drop: the server would hang waiting on us.
    ctx.fail(-32601, `Method not supported by vibemobile: ${msg.method}`)
  }

  #onClose() {
    // Read both flags *before* overwriting the state — `close()` sets
    // 'closing' and then awaits the socket, so this handler is the one that
    // sees it. Checking after the assignment would always read 'closed' and
    // a deliberate shutdown would schedule a reconnect.
    const wasReady = this.#state === 'ready'
    const wasClosing = this.#state === 'closing'
    this.#state = 'closed'
    this.#ws = undefined

    const err = new Error('app-server connection closed')
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.#pending.clear()

    if (wasReady) this.emit('disconnected', err)
    if (wasClosing) return
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer) return
    const delays = this.#opts.reconnectDelays
    const delay = delays[Math.min(this.#reconnectAttempt, delays.length - 1)]!
    this.#reconnectAttempt++
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      if (this.#state === 'closing') return
      this.#connect().catch((err) => {
        this.emit('error', err as Error)
        this.#scheduleReconnect()
      })
    }, delay)
  }

  #send(obj: unknown) {
    if (this.#ws?.readyState !== WebSocket.OPEN) {
      throw new Error('app-server socket is not open')
    }
    this.#ws.send(JSON.stringify(obj))
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`cannot send ${method}: socket not open`))
    }
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`${method}: timed out after ${this.#opts.requestTimeoutMs}ms`))
        }
      }, this.#opts.requestTimeoutMs)
      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
        timer,
      })
      this.#send({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.#send({ method, params })
  }

  async close(): Promise<void> {
    this.#state = 'closing'
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
    }
    const ws = this.#ws
    if (!ws) {
      this.#state = 'closed'
      return
    }
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close()
      setTimeout(resolve, 2_000).unref?.()
    })
    this.#state = 'closed'
  }
}
