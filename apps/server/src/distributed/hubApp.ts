import crypto from 'node:crypto'
import fs from 'node:fs'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import type { Config } from '../config.js'
import type { CreateRunnerRequest } from '@vibemobile/protocol'
import { COOKIE_NAME, verifySession } from '../auth/jwt.js'
import { registerAuthRoutes } from '../routes/auth.js'
import { requireAuth } from '../routes/guards.js'
import { RunnerTunnel, RunnerOfflineError } from './tunnel.js'
import { allowedPath, MAX_BODY, MAX_FRAME, PROTOCOL, RESPONSE_HEADERS } from './wire.js'
import type { HubHttpsOptions } from './tls.js'
import type { RunnerStore } from './runnerStore.js'

export interface RunnerSpec {
  id: string
  name: string
  tokenHash: string
}
export const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

export function validateRunners(value: unknown): RunnerSpec[] {
  if (!Array.isArray(value) || !value.length || value.length > 200)
    throw new Error('runner config must contain 1..200 runners')
  const ids = new Set<string>()
  for (const runner of value) {
    if (
      !runner ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(runner.id) ||
      typeof runner.name !== 'string' ||
      !runner.name.length ||
      runner.name.length > 100 ||
      !/^[a-f0-9]{64}$/.test(runner.tokenHash) ||
      ids.has(runner.id)
    )
      throw new Error('invalid or duplicate runner config')
    ids.add(runner.id)
  }
  return value as RunnerSpec[]
}

/** Comma-separated allowlist. Each entry must already be a normalized origin (lowercase, no trailing slash). */
export function parsePublicOrigins(value?: string): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  for (const origin of origins)
    if (new URL(origin).origin !== origin)
      throw new Error('PUBLIC_ORIGIN entries must be lowercase origins without trailing slashes')
  return origins
}

export async function createHub(
  config: Config,
  specs: RunnerSpec[],
  defaultRunner: string,
  publicOrigin?: string,
  https?: HubHttpsOptions,
  runnerStore?: RunnerStore,
) {
  const publicOrigins = parsePublicOrigins(publicOrigin)
  validateRunners(specs)
  if (!specs.some((r) => r.id === defaultRunner)) throw new Error('default runner must exist')
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : true,
    trustProxy: config.trustProxy,
    bodyLimit: MAX_BODY,
    ...(https ? { https } : {}),
  })
  await app.register(cookie)
  await app.register(websocket, { options: { maxPayload: MAX_FRAME } })
  // Must be installed before `@fastify/static` is registered: a plugin
  // registered first leaves the root context on Fastify's default serializer,
  // and every error then loses its `{ error }` body (the client saw the raw
  // `runner_store_unwritable` instead of a mapped message). Errors thrown by
  // the management routes carry `statusCode`; unknown ones stay 502.
  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { statusCode?: number }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 502
    reply.header('cache-control', 'no-store').code(status).send({ error: err.message })
  })
  const entries = new Map(
    specs.map((spec) => [
      spec.id,
      { spec, tunnel: undefined as RunnerTunnel | undefined, lastSeen: null as number | null },
    ]),
  )
  /** Runners created through the Hub — the only ones the UI may rotate or delete. */
  const remoteIds = new Set(runnerStore ? runnerStore.list().map((spec) => spec.id) : [])
  const sameOrigin = (origin: string | undefined, protocol: string, host: string | undefined) =>
    !origin ||
    (publicOrigins.length ? publicOrigins.includes(origin.toLowerCase()) : origin === `${protocol}://${host}`)
  app.addHook('onRequest', async (req, reply) => {
    if (!sameOrigin(req.headers.origin, req.protocol, req.headers.host))
      return reply.code(403).send({ error: 'origin_not_allowed' })
  })
  registerAuthRoutes(app, config)
  const auth = { preHandler: requireAuth(config) }
  app.get('/api/hub', () => ({ mode: 'hub', protocol: PROTOCOL }))
  app.get('/api/runners', auth, () => ({
    default: defaultRunner,
    data: [...entries.values()].map(({ spec, tunnel, lastSeen }) => ({
      id: spec.id,
      name: spec.name,
      online: tunnel?.socket.readyState === 1,
      lastSeen,
      // The default runner is managed by the Hub process, not by the store.
      ...(remoteIds.has(spec.id) ? { managed: true } : {}),
    })),
  }))

  if (runnerStore) {
    const store = runnerStore
    // The store attaches the underlying fs error as `cause`; log it before the
    // client only sees the stable code. Without this a read-only mount is
    // invisible in `docker logs`.
    const write = <T>(action: () => T): T => {
      try {
        return action()
      } catch (error) {
        const cause = (error as { cause?: unknown }).cause
        if (cause) app.log.warn({ err: cause }, 'runner credential store failed')
        throw error
      }
    }

    app.post<{ Body: Partial<CreateRunnerRequest> }>('/api/runners', auth, async (req, reply) => {
      if (entries.size >= 200) throw Object.assign(new Error('runner_limit'), { statusCode: 409 })
      const created = write(() =>
        store.create(typeof req.body?.name === 'string' ? req.body.name : '', (id) => entries.has(id)),
      )
      entries.set(created.spec.id, { spec: created.spec, tunnel: undefined, lastSeen: null })
      remoteIds.add(created.spec.id)
      app.log.info({ runner: created.spec.id }, 'runner credential created')
      reply.header('cache-control', 'no-store')
      return reply.code(201).send({ id: created.spec.id, name: created.spec.name, token: created.token })
    })

    app.post<{ Params: { id: string } }>('/api/runners/:id/token', auth, async (req, reply) => {
      const id = req.params.id
      const entry = entries.get(id)
      if (!entry || !remoteIds.has(id)) throw Object.assign(new Error('runner_not_found'), { statusCode: 404 })
      // Persist the new hash before touching anything: a read-only file must
      // leave the old token working rather than silently invalidating it.
      const rotated = write(() => store.refresh(id))
      entry.spec = rotated.spec
      // The old token is dead from here. Drop a live runner so a revoked
      // credential cannot keep executing work until it happens to reconnect.
      entry.tunnel?.socket.terminate()
      app.log.info({ runner: id }, 'runner credential rotated')
      reply.header('cache-control', 'no-store')
      return { id, name: rotated.spec.name, token: rotated.token }
    })

    app.delete<{ Params: { id: string } }>('/api/runners/:id', auth, async (req) => {
      const id = req.params.id
      if (!entries.has(id) || !remoteIds.has(id))
        throw Object.assign(new Error('runner_not_found'), { statusCode: 404 })
      // With VIBEMOBILE_DEFAULT_RUNNER=off the default is a stored runner;
      // removing it would leave `specs` empty and the Hub without an executor.
      if (id === defaultRunner) throw Object.assign(new Error('runner_default'), { statusCode: 409 })
      write(() => store.remove(id))
      const entry = entries.get(id)
      entry?.tunnel?.socket.terminate()
      entries.delete(id)
      remoteIds.delete(id)
      app.log.info({ runner: id }, 'runner credential deleted')
      return { ok: true }
    })
  }

  app.get(
    '/runner/connect',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const id = req.headers['x-runner-id']
        const entry = typeof id === 'string' ? entries.get(id) : undefined
        const token = req.headers.authorization?.replace(/^Bearer /, '')
        if (
          !entry ||
          !token ||
          token.length < 32 ||
          !crypto.timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(entry.spec.tokenHash, 'hex'))
        )
          return reply.code(401).send({ error: 'invalid_runner_credentials' })
        if (req.headers['sec-websocket-protocol'] !== PROTOCOL)
          return reply.code(426).send({ error: 'runner_protocol_mismatch' })
        // A new process must not silently replace an active executor with the same identity.
        if (entry.tunnel?.socket.readyState === 1) return reply.code(409).send({ error: 'runner_already_connected' })
      },
    },
    (socket, req) => {
      const entry = entries.get(req.headers['x-runner-id'] as string)!
      if (entry.tunnel?.socket.readyState === 1) {
        socket.close(1008, 'duplicate runner')
        return
      }
      const tunnel = new RunnerTunnel(socket)
      entry.tunnel = tunnel
      entry.lastSeen = Date.now()
      let alive = true
      socket.on('pong', () => {
        alive = true
        entry.lastSeen = Date.now()
      })
      const heartbeat = setInterval(() => {
        if (!alive) socket.terminate()
        else {
          alive = false
          socket.ping()
        }
      }, 30_000)
      heartbeat.unref()
      socket.on('close', () => {
        clearInterval(heartbeat)
        if (entry.tunnel === tunnel) entry.tunnel = undefined
      })
    },
  )

  const tunnelFor = (runner: string) => {
    const entry = entries.get(runner)
    if (!entry) throw Object.assign(new Error('unknown_runner'), { statusCode: 404 })
    if (!entry.tunnel || entry.tunnel.socket.readyState !== 1) throw new RunnerOfflineError()
    return entry.tunnel
  }
  app.route<{ Params: { runner: string; '*': string } }>({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/r/:runner/api/*',
    ...auth,
    handler: async (req, reply) => {
      const path = `/api/${req.params['*']}${req.raw.url?.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : ''}`
      if (!allowedPath(path)) return reply.code(404).send({ error: 'path_not_allowed' })
      const body = req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body)).toString('base64')
      const response = await tunnelFor(req.params.runner).request(req.method, path, body)
      for (const name of RESPONSE_HEADERS) if (response.headers[name]) reply.header(name, response.headers[name])
      // Failures must never become permanent cached image misses.
      if (response.status >= 400) reply.header('cache-control', 'no-store')
      return reply.code(response.status).send(Buffer.from(response.body, 'base64'))
    },
  })
  for (const endpoint of ['/r/:runner/ws', '/r/:runner/ws/terminal']) {
    app.get<{ Params: { runner: string } }>(endpoint, { websocket: true, ...auth }, (socket, req) => {
      try {
        const path = req.raw.url!.replace(/^\/r\/[^/]+/, '')
        if (!allowedPath(path, true)) {
          socket.close(1008, 'path not allowed')
          return
        }
        tunnelFor(req.params.runner).open(socket, path)
      } catch {
        socket.close(1013, 'runner unavailable')
      }
    })
  }
  app.addHook('onClose', async () => {
    for (const entry of entries.values()) entry.tunnel?.socket.terminate()
  })
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, index: false })
    app.get('/', (_req, reply) => reply.sendFile('index.html'))
    app.setNotFoundHandler((req, reply) => {
      if (
        req.url.startsWith('/api') ||
        req.url.startsWith('/runner') ||
        /^\/r\/[^/]+\/(?:api|ws)(?:\/|\?|$)/.test(req.url)
      )
        return reply.code(404).send({ error: 'not_found' })
      return reply.sendFile('index.html')
    })
  }
  return app
}
