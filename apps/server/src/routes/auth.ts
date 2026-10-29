import type { FastifyInstance } from 'fastify'
import type { LoginResponse, MeResponse } from '@vibemobile/protocol'
import type { Config } from '../config.js'
import { bumpSessionVersion, verifyPin } from '../config.js'
import { cookieOptions, COOKIE_NAME, signSession, verifySession } from '../auth/jwt.js'
import { RateLimiter } from '../auth/rateLimit.js'
import { requireAuth } from './guards.js'

export function registerAuthRoutes(app: FastifyInstance, config: Config): void {
  // A PIN chosen via VIBEMOBILE_PIN can be short, so it is only safe behind a throttle.
  const limiter = new RateLimiter({ max: 5, windowMs: 60_000, blockMs: 5 * 60_000 })
  const sweep = setInterval(() => limiter.sweep(), 60_000)
  sweep.unref?.()
  app.addHook('onClose', async () => clearInterval(sweep))

  app.post<{ Body: { pin?: string } }>('/api/auth/login', async (req, reply) => {
    if (config.authDisabled) {
      const { token, expiresAt } = signSession(config)
      reply.setCookie(COOKIE_NAME, token, cookieOptions(config, config.sessionTtlMs))
      return { ok: true, expiresAt } satisfies LoginResponse
    }

    const key = req.ip
    const verdict = limiter.check(key)
    if (!verdict.allowed) {
      reply.header('Retry-After', Math.ceil(verdict.retryAfterMs / 1000))
      return reply.code(429).send({ error: 'too many attempts, try again later' })
    }

    const pin = req.body?.pin
    if (typeof pin !== 'string' || !config.pinHash) {
      return reply.code(400).send({ error: 'pin is required' })
    }

    if (!verifyPin(pin, config.pinHash)) {
      req.log.warn({ ip: key }, 'failed login attempt')
      return reply.code(401).send({ error: 'incorrect PIN' })
    }

    limiter.reset(key)
    // Deliberately does NOT bump the session generation: several devices may
    // stay signed in at once. Only a PIN change or "log out all devices"
    // revokes existing tokens.
    const { token, expiresAt } = signSession(config)
    reply.setCookie(COOKIE_NAME, token, cookieOptions(config, config.sessionTtlMs))
    return { ok: true, expiresAt } satisfies LoginResponse
  })

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' })
    return { ok: true }
  })

  // Revokes every token, including the caller's own. Requires a session so an
  // unauthenticated request cannot log the owner out at will.
  app.post('/api/auth/logout-all', { preHandler: requireAuth(config) }, async (_req, reply) => {
    bumpSessionVersion(config)
    reply.clearCookie(COOKIE_NAME, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', { preHandler: requireAuth(config) }, async () => {
    return { authenticated: true } satisfies MeResponse
  })

  // Unauthenticated: lets the login screen know whether a PIN is even needed.
  app.get('/api/auth/mode', async () => ({ authDisabled: config.authDisabled }))
}

export function currentSession(config: Config, cookie: string | undefined) {
  return verifySession(config, cookie)
}
