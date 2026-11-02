import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../config.js'
import { registerSystemRoutes } from './system.js'

const dirs: string[] = []

function tempConfig(): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-system-route-'))
  dirs.push(dir)
  return {
    authDisabled: true,
    stateDir: dir,
    installDir: dir,
    releaseDir: dir,
    update: { enabled: false, packageName: 'vibemobile', allowHttp: false, ttlMs: 0, downloadTimeoutMs: 0 },
  } as unknown as Config
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('system update routes', () => {
  it('reports an unsupported deployment without touching PM2', async () => {
    const app = Fastify()
    registerSystemRoutes(app, tempConfig())
    const res = await app.inject({ method: 'GET', url: '/api/system/update' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toMatchObject({ supported: false, updateAvailable: false, job: null })
    await app.close()
  })

  it('refuses a start with a stable error code', async () => {
    const app = Fastify()
    registerSystemRoutes(app, tempConfig())
    const res = await app.inject({ method: 'POST', url: '/api/system/update' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'update_not_supported' })
    await app.close()
  })

  it('rejects a cross-origin POST', async () => {
    const app = Fastify()
    registerSystemRoutes(app, tempConfig())
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/update',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'origin_not_allowed' })
    await app.close()
  })
})
