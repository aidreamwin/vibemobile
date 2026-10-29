import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../config.js'
import { hashPin } from '../config.js'
import { COOKIE_NAME, verifySession } from '../auth/jwt.js'
import { registerAuthRoutes } from './auth.js'

let dir: string
let config: Config

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibemobile-auth-route-'))
  config = {
    host: '127.0.0.1',
    port: 0,
    secret: 'b'.repeat(64),
    pinHash: hashPin('test-pin'),
    authDisabled: false,
    sessionTtlMs: 60_000,
    sessionVersion: 1,
    workspaceRoots: [],
    codex: { port: 0 },
    stateDir: dir,
    webDist: '',
    trustProxy: false,
    terminal: { enabled: false, shell: '', idleTimeoutMs: 1_000 },
    logLevel: 'silent',
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function makeApp() {
  const app = Fastify()
  await app.register(cookie)
  registerAuthRoutes(app, config)
  await app.ready()
  return app
}

async function login(app: Awaited<ReturnType<typeof makeApp>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { pin: 'test-pin' },
  })
  const header = response.headers['set-cookie']
  const pair = String(Array.isArray(header) ? header[0] : header).split(';')[0]
  return { status: response.statusCode, pair, token: pair.slice(COOKIE_NAME.length + 1) }
}

describe('multi-device sessions', () => {
  it('keeps every device signed in after another login', async () => {
    const app = await makeApp()
    try {
      const first = await login(app)
      const second = await login(app)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(verifySession(config, first.token)?.sub).toBe('owner')
      expect(verifySession(config, second.token)?.sub).toBe('owner')
    } finally {
      await app.close()
    }
  })

  it('revokes every device, including the caller, on logout-all', async () => {
    const app = await makeApp()
    try {
      const first = await login(app)
      const second = await login(app)
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout-all',
        headers: { cookie: first.pair },
      })
      expect(logout.statusCode).toBe(200)
      expect(verifySession(config, first.token)).toBeNull()
      expect(verifySession(config, second.token)).toBeNull()
      expect(String(logout.headers['set-cookie'])).toContain(`${COOKIE_NAME}=;`)
    } finally {
      await app.close()
    }
  })

  it('requires a session to revoke everything', async () => {
    const app = await makeApp()
    try {
      expect((await app.inject({ method: 'POST', url: '/api/auth/logout-all' })).statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })

  it('does not touch the generation on a failed login', async () => {
    const app = await makeApp()
    try {
      expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { pin: 'wrong' } })).statusCode).toBe(
        401,
      )
      expect(config.sessionVersion).toBe(1)
    } finally {
      await app.close()
    }
  })
})
