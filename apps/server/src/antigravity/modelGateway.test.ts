import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { acpModelId, startModelGateway } from './modelGateway.js'

describe('Antigravity supplier models', () => {
  it('keeps simultaneous variants distinct, preserves SSE and forwards only the supplier credential', async () => {
    const calls: { url?: string; key?: string | string[]; body: string }[] = []
    const upstream = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      calls.push({ url: req.url, key: req.headers['x-goog-api-key'], body: Buffer.concat(chunks).toString() })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'request-id' })
      res.end('data: response\n\n')
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const models = ['gemini-4-neon-low', 'gemini-4-neon-high', 'team/custom']
    const gateway = await startModelGateway(
      {
        id: 'saved',
        name: 'Gemini',
        apiKey: 'supplier-key',
        updatedAt: 1,
        baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/supplier/v1beta`,
        model: models[0],
        models,
      },
      models,
    )
    try {
      const url = `${gateway.baseUrl}/v1beta/models`
      expect((await fetch(url)).status).toBe(401)
      const catalog = (await (await fetch(url, { headers: gateway.headers })).json()) as {
        models: { name: string; displayName: string }[]
      }
      expect(catalog.models.map((m) => m.displayName)).toEqual(models)
      expect(gateway.headers['x-goog-api-key']).not.toBe('supplier-key')
      await Promise.all(
        models.map(async (id) => {
          const opts = { method: 'POST', headers: gateway.headers, body: JSON.stringify({ text: id }) }
          const response = await fetch(`${url}/${acpModelId(id)}:streamGenerateContent?alt=sse`, opts)
          expect(response.headers.get('x-request-id')).toBe('request-id')
          expect(await response.text()).toBe('data: response\n\n')
        }),
      )
      expect(
        (await fetch(`${url}/${acpModelId('missing')}:generateContent`, { method: 'POST', headers: gateway.headers }))
          .status,
      ).toBe(404)
      expect(calls).toHaveLength(models.length)
      for (const id of models)
        expect(calls).toContainEqual({
          url: `/supplier/v1beta/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`,
          key: 'supplier-key',
          body: JSON.stringify({ text: id }),
        })
    } finally {
      gateway.close()
      upstream.close()
      upstream.closeAllConnections()
    }
  })
})
