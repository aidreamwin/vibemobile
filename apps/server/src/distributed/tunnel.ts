import crypto from 'node:crypto'
import { WebSocket } from 'ws'
import { MAX_BODY, MAX_CHANNELS, TIMEOUT, parseFrame, rawBuffer, sendData, sendFrame, type Frame } from './wire.js'

type Response = Extract<Frame, { type: 'response' }>

export class RunnerOfflineError extends Error {
  statusCode = 503
  constructor() {
    super('runner_offline')
  }
}

export class RunnerTunnel {
  private pending = new Map<
    string,
    { resolve: (value: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private streams = new Map<string, WebSocket>()

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      try {
        this.receive(parseFrame(raw))
      } catch {
        socket.close(1008, 'invalid runner message')
      }
    })
    socket.on('close', () => this.dispose())
    socket.on('error', () => this.dispose())
  }

  request(method: string, path: string, body?: string): Promise<Response> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new RunnerOfflineError())
    if (this.pending.size >= MAX_CHANNELS)
      return Promise.reject(Object.assign(new Error('runner_busy'), { statusCode: 429 }))
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        sendFrame(this.socket, { type: 'close', id })
        reject(Object.assign(new Error('runner_timeout_result_unknown'), { statusCode: 504 }))
      }, TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      if (!sendFrame(this.socket, { type: 'http', id, method, path, ...(body ? { body } : {}) })) this.dispose()
    })
  }

  open(client: WebSocket, path: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      client.close(1013, 'runner offline')
      return
    }
    if (this.streams.size >= MAX_CHANNELS) {
      client.close(1013, 'too many streams')
      return
    }
    const id = crypto.randomUUID()
    this.streams.set(id, client)
    client.on('message', (raw, binary) => {
      if (!sendFrame(this.socket, { type: 'data', id, body: rawBuffer(raw).toString('base64'), binary }))
        client.close(1013, 'runner unavailable')
    })
    const close = () => {
      if (!this.streams.delete(id)) return
      sendFrame(this.socket, { type: 'close', id })
    }
    client.on('close', close)
    client.on('error', close)
    if (!sendFrame(this.socket, { type: 'open', id, path })) client.close(1013, 'runner unavailable')
  }

  private receive(frame: Frame): void {
    if (frame.type === 'response' || frame.type === 'failure') {
      const pending = this.pending.get(frame.id)
      if (pending) {
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.type === 'response') {
          if (Buffer.byteLength(frame.body, 'base64') > MAX_BODY) pending.reject(new Error('runner_response_too_large'))
          else pending.resolve(frame)
        } else pending.reject(Object.assign(new Error(frame.error), { statusCode: 502 }))
      }
    }
    if (frame.type === 'data') {
      const client = this.streams.get(frame.id)
      if (client) sendData(client, Buffer.from(frame.body, 'base64'), frame.binary)
    } else if (frame.type === 'close' || frame.type === 'failure') {
      const client = this.streams.get(frame.id)
      this.streams.delete(frame.id)
      client?.close(1012, 'runner stream closed; reconnect to restore state')
    }
  }

  private dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new RunnerOfflineError())
    }
    this.pending.clear()
    for (const client of this.streams.values()) client.close(1012, 'runner disconnected')
    this.streams.clear()
  }
}
