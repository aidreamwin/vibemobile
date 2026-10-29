import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { ImageStore } from '../images/store.js'
import { registerImageRoutes } from './images.js'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let dir: string
let app: ReturnType<typeof Fastify>

async function build(overrides: Parameters<typeof loadConfig>[0] = {}) {
  const config = loadConfig({ authDisabled: true, stateDir: dir, ...overrides })
  const instance = Fastify()
  await instance.register(cookie)
  registerImageRoutes(instance, config)
  await instance.ready()
  return instance
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-image-route-'))
  app = await build()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/images/:id', () => {
  it('serves the stored bytes with an immutable cache header', async () => {
    const token = new ImageStore(path.join(dir, 'images')).put(`data:image/png;base64,${PNG_B64}`)!

    const res = await app.inject({ method: 'GET', url: `/api/images/${token}` })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    // The token IS the hash of these bytes, so a year-long cache is correct
    // rather than merely convenient — different content is a different URL.
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.rawPayload.toString('base64')).toBe(PNG_B64)
  })

  it('answers a miss with no-store, so a cleared image can come back', async () => {
    // Without `no-store` the browser caches the 404 against a URL it is told is
    // immutable, and the picture can never reappear — even though re-reading
    // the transcript restores it.
    const missing = 'a'.repeat(32) + '.png'
    const res = await app.inject({ method: 'GET', url: `/api/images/${missing}` })

    expect(res.statusCode).toBe(404)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('refuses ids that would escape the image directory', async () => {
    // `state.json` holds the JWT signing secret and the plaintext PIN.
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ secret: 'x'.repeat(64) }))

    for (const id of ['..%2Fstate.json', '..%5Cstate.json', '....//state.json', 'state.json']) {
      const res = await app.inject({ method: 'GET', url: `/api/images/${id}` })
      expect(res.statusCode, id).toBe(404)
    }
  })

  it('requires a session when auth is on', async () => {
    const authed = await build({ authDisabled: false, pinHash: 'scrypt$aa$bb' })
    try {
      const res = await authed.inject({ method: 'GET', url: `/api/images/${'a'.repeat(32)}.png` })
      expect(res.statusCode).toBe(401)
    } finally {
      await authed.close()
    }
  })
})
