import { WebSocket } from 'ws'
import {
  allowedPath,
  MAX_BODY,
  MAX_BUFFER,
  MAX_CHANNELS,
  MAX_FRAME,
  PROTOCOL,
  RESPONSE_HEADERS,
  TIMEOUT,
  parseFrame,
  rawBuffer,
  sendData,
  sendFrame,
  type Frame,
} from './wire.js'

export interface BridgeOptions {
  hubUrl: string
  runnerId: string
  token: string
  localUrl: string
  serviceToken: string
  /** Explicit trust anchors replace the connection's default public CA list. */
  ca?: Buffer
  onStatus?: (status: string) => void
}

/** LAN deployments may use plain WS; both transports use the same runner authentication. */
export function parseHubUrl(value: string): URL {
  const hub = new URL(value)
  if (!['ws:', 'wss:'].includes(hub.protocol) || hub.username || hub.password)
    throw new Error('Hub URL must use ws:// or wss:// without embedded credentials')
  return hub
}

/** Reverse connection only: localUrl is operator configuration, never a wire field. */
export function connectRunner(options: BridgeOptions): () => void {
  const local = new URL(options.localUrl)
  if (local.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(local.hostname))
    throw new Error('runner local service must use loopback HTTP')
  const hub = parseHubUrl(options.hubUrl)
  hub.pathname = '/runner/connect'
  hub.search = ''
  let stopped = false
  let socket: WebSocket | undefined
  let timer: NodeJS.Timeout | undefined
  let attempts = 0

  const connect = () => {
    if (stopped) return
    const channel = new WebSocket(hub, PROTOCOL, {
      ...(options.ca ? { ca: options.ca } : {}),
      rejectUnauthorized: true,
      headers: { authorization: `Bearer ${options.token}`, 'x-runner-id': options.runnerId },
      maxPayload: MAX_FRAME,
      handshakeTimeout: 10_000,
    })
    socket = channel
    const streams = new Map<string, { socket: WebSocket; queued: { body: Buffer; binary: boolean }[]; bytes: number }>()
    const requests = new Map<string, AbortController>()
    let lastPing = Date.now()
    channel.on('ping', () => {
      lastPing = Date.now()
    })
    const watchdog = setInterval(() => {
      if (Date.now() - lastPing > 75_000) channel.terminate()
    }, 15_000)
    watchdog.unref()
    const fail = (id: string, error: string) => sendFrame(channel, { type: 'failure', id, error })

    const receive = async (frame: Frame) => {
      if (frame.type === 'http') {
        if (!allowedPath(frame.path)) {
          fail(frame.id, 'path_not_allowed')
          return
        }
        if (requests.size >= MAX_CHANNELS || requests.has(frame.id)) {
          fail(frame.id, 'runner_busy')
          return
        }
        const body = frame.body ? Buffer.from(frame.body, 'base64') : undefined
        if (body && body.length > MAX_BODY) {
          fail(frame.id, 'request_too_large')
          return
        }
        const controller = new AbortController()
        requests.set(frame.id, controller)
        const timeout = setTimeout(() => controller.abort(), TIMEOUT)
        try {
          const response = await fetch(new URL(frame.path, local), {
            method: frame.method,
            headers: {
              ...(body ? { 'content-type': 'application/json' } : {}),
              authorization: `Bearer ${options.serviceToken}`,
            },
            body: body && frame.method !== 'GET' ? body : undefined,
            signal: controller.signal,
            redirect: 'error',
          })
          const chunks: Buffer[] = []
          let bytes = 0
          if (response.body) {
            const reader = response.body.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                bytes += value.length
                if (bytes > MAX_BODY) {
                  controller.abort()
                  throw new Error('response too large')
                }
                chunks.push(Buffer.from(value))
              }
            } finally {
              reader.releaseLock()
            }
          }
          const headers: Record<string, string> = {}
          for (const name of RESPONSE_HEADERS) {
            const value = response.headers.get(name)
            if (value) headers[name] = value
          }
          sendFrame(channel, {
            type: 'response',
            id: frame.id,
            status: response.status,
            headers,
            body: Buffer.concat(chunks).toString('base64'),
          })
        } catch {
          fail(frame.id, 'runner_request_failed_result_unknown')
        } finally {
          clearTimeout(timeout)
          requests.delete(frame.id)
        }
      } else if (frame.type === 'open') {
        if (!allowedPath(frame.path, true)) {
          fail(frame.id, 'path_not_allowed')
          return
        }
        if (streams.size >= MAX_CHANNELS || streams.has(frame.id)) {
          fail(frame.id, 'runner_busy')
          return
        }
        const target = new URL(frame.path, local)
        target.protocol = 'ws:'
        const ws = new WebSocket(target, {
          headers: { authorization: `Bearer ${options.serviceToken}` },
          maxPayload: MAX_BODY,
          handshakeTimeout: 10_000,
        })
        const stream = { socket: ws, queued: [] as { body: Buffer; binary: boolean }[], bytes: 0 }
        streams.set(frame.id, stream)
        ws.on('open', () => {
          for (const message of stream.queued) sendData(ws, message.body, message.binary)
          stream.queued = []
          stream.bytes = 0
        })
        ws.on('message', (raw, binary) => {
          if (!sendFrame(channel, { type: 'data', id: frame.id, body: rawBuffer(raw).toString('base64'), binary }))
            ws.close()
        })
        const close = () => {
          if (streams.delete(frame.id)) sendFrame(channel, { type: 'close', id: frame.id })
        }
        ws.on('close', close)
        ws.on('error', close)
      } else if (frame.type === 'data') {
        const stream = streams.get(frame.id)
        if (!stream) return
        const body = Buffer.from(frame.body, 'base64')
        if (stream.socket.readyState === WebSocket.CONNECTING) {
          stream.bytes += body.length
          if (stream.bytes > MAX_BUFFER) {
            stream.socket.terminate()
            return
          }
          stream.queued.push({ body, binary: frame.binary })
        } else sendData(stream.socket, body, frame.binary)
      } else if (frame.type === 'close') {
        requests.get(frame.id)?.abort()
        const stream = streams.get(frame.id)
        streams.delete(frame.id)
        if (stream?.socket.readyState === WebSocket.CONNECTING) stream.socket.terminate()
        else stream?.socket.close()
      }
    }

    channel.on('open', () => {
      attempts = 0
      options.onStatus?.('connected')
    })
    channel.on('message', (raw) => {
      try {
        void receive(parseFrame(raw)).catch(() => channel.close(1011, 'bridge failure'))
      } catch {
        channel.close(1008, 'invalid hub message')
      }
    })
    channel.on('error', (error: Error & { code?: string }) => {
      // Error codes help diagnose certificate failures without logging credentials or URLs.
      options.onStatus?.(`connection_error:${error.code ?? 'connection_failed'}`)
    })
    channel.on('close', () => {
      clearInterval(watchdog)
      for (const request of requests.values()) request.abort()
      for (const stream of streams.values()) {
        if (stream.socket.readyState === WebSocket.CONNECTING) stream.socket.terminate()
        else stream.socket.close()
      }
      requests.clear()
      streams.clear()
      options.onStatus?.('disconnected')
      if (!stopped)
        timer = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempts++, 5)) + Math.random() * 250)
    })
  }
  connect()
  return () => {
    stopped = true
    clearTimeout(timer)
    socket?.terminate()
  }
}
