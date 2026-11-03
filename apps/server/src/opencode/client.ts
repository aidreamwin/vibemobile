/**
 * HTTP + SSE client for the opencode v2 API.
 *
 * Deliberately transport-only: no session or event semantics live here. The
 * provider decides what a 404 means and which events matter; this file only
 * knows how to authenticate, how to parse an SSE frame, and how to surface an
 * error without ever putting the service password into a message or a log.
 */
import type { OpencodeInfo } from './types.js'

/** Raised for a non-2xx response. `body` is truncated and already redacted. */
export class OpencodeHttpError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string
  readonly body: string

  constructor(method: string, path: string, status: number, body: string) {
    super(`opencode ${method} ${path} -> ${status}: ${body.slice(0, 300)}`)
    this.name = 'OpencodeHttpError'
    this.status = status
    this.method = method
    this.path = path
    this.body = body
  }
}

export interface OpencodeClientOptions {
  baseUrl: string
  password?: string
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Per-request timeout, not applied to the SSE stream. */
  timeoutMs?: number
}

/**
 * Incremental SSE decoder.
 *
 * opencode sends `data: <json>` frames separated by a blank line and uses
 * comment lines as heartbeats. There is no `event:` field in the frames this
 * provider consumes. A frame boundary can arrive split across arbitrary byte
 * chunks, which is the whole reason this is a stateful class rather than a
 * regular expression over the accumulated buffer.
 */
export class SseDecoder {
  #buffer = ''

  /** Feed a decoded chunk; returns every complete event payload it completed. */
  push(chunk: string): string[] {
    this.#buffer += chunk
    const payloads: string[] = []
    // Tolerate CRLF and bare CR; the server currently uses LF.
    let index = this.#buffer.search(/\r?\n\r?\n/)
    while (index >= 0) {
      const frame = this.#buffer.slice(0, index)
      const match = /\r?\n\r?\n/.exec(this.#buffer.slice(index))
      const consumed = index + (match?.[0].length ?? 2)
      this.#buffer = this.#buffer.slice(consumed)
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) payloads.push(data)
      index = this.#buffer.search(/\r?\n\r?\n/)
    }
    return payloads
  }
}

function authHeader(password?: string): Record<string, string> {
  if (!password) return {}
  return {
    // The API's Basic user is fixed; only the password is per-service.
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
  }
}

export class OpencodeClient {
  readonly baseUrl: string
  readonly #password?: string
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(opts: OpencodeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.#password = opts.password
    this.#fetch = opts.fetchImpl ?? fetch
    this.#timeoutMs = opts.timeoutMs ?? 30_000
  }

  /** A URL safe to put in a log line: credentials and query values removed. */
  displayUrl(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  async info(signal?: AbortSignal): Promise<OpencodeInfo> {
    const info = await this.request<OpencodeInfo>('GET', '/api/info', undefined, { signal })
    return info
  }

  async get<T>(path: string, opts: { signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('GET', path, undefined, opts)
  }

  async post<T>(path: string, body: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('POST', path, body, opts)
  }

  async patch<T>(path: string, body: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('PATCH', path, body, opts)
  }

  async del<T>(path: string, opts: { signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('DELETE', path, undefined, opts)
  }

  async request<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.#fetch(this.baseUrl + path, {
        method,
        signal,
        headers: {
          ...authHeader(this.#password),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      throw new Error(`opencode ${method} ${path} failed: ${(err as Error).message}`)
    }
    const text = await response.text()
    if (!response.ok) {
      throw new OpencodeHttpError(method, path, response.status, redact(text, this.#password))
    }
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`opencode ${method} ${path} returned non-JSON`)
    }
  }

  /**
   * Consume `GET /api/event` until `signal` aborts or the server closes.
   *
   * Each decoded frame is handed to `onFrame` as the raw JSON value; it is not
   * validated or interpreted here.
   */
  async streamEvents(onFrame: (value: unknown) => void, signal: AbortSignal, onOpen?: () => void): Promise<void> {
    const response = await this.#fetch(`${this.baseUrl}/api/event`, {
      signal,
      headers: { ...authHeader(this.#password), accept: 'text/event-stream' },
    })
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new OpencodeHttpError('GET', '/api/event', response.status, redact(text, this.#password))
    }
    onOpen?.()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const sse = new SseDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        for (const payload of sse.push(decoder.decode(value, { stream: true }))) {
          try {
            onFrame(JSON.parse(payload))
          } catch {
            // A malformed frame is not worth ending the stream over; the next
            // event may be perfectly good and the API is experimental.
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}

/** Remove the password from a response body before it reaches an error or log. */
export function redact(text: string, password: string | undefined): string {
  if (!password) return text
  return text.split(password).join('<redacted>')
}
