import { WebSocket, type RawData } from 'ws'

export const PROTOCOL = 'vibemobile-runner-v1'
export const MAX_BODY = 8 * 1024 * 1024
export const MAX_FRAME = 12 * 1024 * 1024
export const MAX_BUFFER = 24 * 1024 * 1024
export const MAX_CHANNELS = 64
export const TIMEOUT = 120_000

export type Frame =
  | { type: 'http'; id: string; method: string; path: string; body?: string }
  | { type: 'response'; id: string; status: number; headers: Record<string, string>; body: string }
  | { type: 'open'; id: string; path: string }
  | { type: 'data'; id: string; body: string; binary: boolean }
  | { type: 'close'; id: string }
  | { type: 'failure'; id: string; error: string }

// Only the existing execution API is exposed. No absolute URL, auth, static,
// arbitrary TCP target, redirects, or caller-supplied HTTP headers cross here.
export function allowedPath(value: string, ws = false): boolean {
  if (value.length > 16_384 || /[\\#\r\n\0]/.test(value)) return false
  const pathname = value.split('?')[0]
  if (ws) return pathname === '/ws' || pathname === '/ws/terminal'
  return (
    /^\/api\/(?:health|features|providers(?:\/[^/]+\/models)?|projects|sessions(?:\/[^/]+(?:\/(?:open|fork))?)?|files(?:\/(?:content|diff))?|images\/[^/]+)$/.test(
      pathname,
    ) && !/%(?:2f|5c|2e)/i.test(pathname)
  )
}

export function parseFrame(raw: RawData): Frame {
  const frame: unknown = JSON.parse(raw.toString())
  if (!frame || typeof frame !== 'object') throw new Error('invalid frame')
  const f = frame as Record<string, unknown>
  if (typeof f.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(f.id)) throw new Error('invalid id')
  const str = (key: string) => typeof f[key] === 'string'
  switch (f.type) {
    case 'http':
      if (
        !str('path') ||
        !str('method') ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(f.method as string) ||
        (f.body !== undefined && !str('body'))
      )
        break
      return frame as Frame
    case 'open':
      if (str('path')) return frame as Frame
      break
    case 'data':
      if (str('body') && typeof f.binary === 'boolean') return frame as Frame
      break
    case 'close':
      return frame as Frame
    case 'failure':
      if (str('error')) return frame as Frame
      break
    case 'response':
      if (
        Number.isInteger(f.status) &&
        Number(f.status) >= 200 &&
        Number(f.status) <= 599 &&
        str('body') &&
        f.headers &&
        typeof f.headers === 'object' &&
        !Array.isArray(f.headers) &&
        Object.values(f.headers).every((v) => typeof v === 'string')
      )
        return frame as Frame
  }
  throw new Error('invalid frame')
}

export function sendFrame(socket: WebSocket, frame: Frame): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false
  const data = JSON.stringify(frame)
  if (Buffer.byteLength(data) > MAX_FRAME || socket.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFER) {
    socket.close(1013, 'runner channel capacity exceeded')
    return false
  }
  socket.send(data)
  return true
}

export function sendData(socket: WebSocket, raw: RawData, binary: boolean): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false
  if (socket.bufferedAmount + Buffer.byteLength(raw.toString()) > MAX_BUFFER) {
    socket.close(1013, 'client too slow')
    return false
  }
  socket.send(raw, { binary })
  return true
}

export const RESPONSE_HEADERS = ['content-type', 'cache-control', 'x-content-type-options', 'retry-after']

export function rawBuffer(raw: RawData): Buffer {
  return Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
}
