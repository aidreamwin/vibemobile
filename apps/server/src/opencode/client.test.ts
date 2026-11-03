import { describe, expect, it } from 'vitest'
import { OpencodeClient, OpencodeHttpError, SseDecoder } from './client.js'

describe('SseDecoder', () => {
  it('assembles frames split across chunks and ignores comments', () => {
    const decoder = new SseDecoder()
    expect(decoder.push(': heartbeat\n\n')).toEqual([])
    expect(decoder.push('data: {"a":')).toEqual([])
    expect(decoder.push('1}\n\ndata: line1\n')).toEqual(['{"a":1}'])
    expect(decoder.push('data: line2\n\n')).toEqual(['line1\nline2'])
  })

  it('handles CRLF and a frame with no data', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('event: x\r\n\r\n')).toEqual([])
    expect(decoder.push('data: {"ok":true}\r\n\r\n')).toEqual(['{"ok":true}'])
  })
})

function clientWith(fetchImpl: typeof fetch, password = 'secret') {
  return new OpencodeClient({ baseUrl: 'http://127.0.0.1:1/', password, fetchImpl })
}

describe('OpencodeClient', () => {
  it('sends the fixed user and the service password', async () => {
    let captured: RequestInit | undefined
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = init
      return new Response(JSON.stringify({ version: '2.2.5', pid: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    const info = await clientWith(fetchImpl).info()
    expect(info).toEqual({ version: '2.2.5', pid: 1 })
    const headers = captured?.headers as Record<string, string> | undefined
    expect(headers?.authorization).toBe(`Basic ${Buffer.from('opencode:secret').toString('base64')}`)
  })

  it('returns undefined for 204', async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await expect(clientWith(fetchImpl).post('/x', {})).resolves.toBeUndefined()
  })

  it('redacts the password from an error body', async () => {
    const fetchImpl = (async () => new Response('bad secret', { status: 401 })) as unknown as typeof fetch
    const error = await clientWith(fetchImpl)
      .get('/api/info')
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OpencodeHttpError)
    expect((error as Error).message).toContain('<redacted>')
    expect((error as Error).message).not.toContain('bad secret')
  })
})
