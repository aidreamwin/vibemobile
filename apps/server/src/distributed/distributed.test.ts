import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { WebSocket } from 'ws'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RunnerStore } from './runnerStore.js'
import type { Config } from '../config.js'
import { hashPin } from '../config.js'
import { signSession, COOKIE_NAME } from '../auth/jwt.js'
import { createHub, parsePublicOrigins, tokenHash } from './hubApp.js'
import { connectRunner, parseHubUrl } from './bridge.js'
import { allowedPath, PROTOCOL } from './wire.js'
import { assertFree, port } from './runtime.js'

const serviceToken = crypto.randomBytes(32).toString('hex')
const tokens = [crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')]
const image = Buffer.from([0, 255, 128, 10, 13, 42])
const config: Config = {
  host: '127.0.0.1',
  port: 0,
  secret: crypto.randomBytes(32).toString('hex'),
  pinHash: hashPin('test-login'),
  authDisabled: false,
  sessionTtlMs: 60_000,
  sessionVersion: 1,
  workspaceRoots: [],
  codex: { port: 0 },
  stateDir: '',
  webDist: 'missing-test-web-dist',
  trustProxy: false,
  terminal: { enabled: true, shell: '', idleTimeoutMs: 60_000 },
  logLevel: 'silent',
}
const cookie = `${COOKIE_NAME}=${signSession(config).token}`
let hub: Awaited<ReturnType<typeof createHub>>
let hubUrl: string
const backends: ReturnType<typeof Fastify>[] = []
const stops: (() => void)[] = []
const clients: WebSocket[] = []
const turns = [0, 0]

async function until(check: () => Promise<boolean>, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition did not become true')
}
async function online(id: string) {
  const response = await hub.inject({ url: '/api/runners', headers: { cookie } })
  return response.json().data.find((r: { id: string }) => r.id === id)?.online === true
}
function client(path: string, headers: Record<string, string> = { cookie }) {
  const ws = new WebSocket(hubUrl.replace('http:', 'ws:') + path, { headers })
  clients.push(ws)
  const messages: { data: Buffer; binary: boolean }[] = []
  ws.on('message', (data, binary) => messages.push({ data: Buffer.from(data as Buffer), binary }))
  ws.on('error', () => undefined)
  return {
    ws,
    async next() {
      await until(async () => messages.length > 0)
      return messages.shift()!
    },
  }
}

beforeAll(async () => {
  for (let index = 0; index < 2; index++) {
    const app = Fastify()
    await app.register(websocket)
    app.addHook('onRequest', async (req, reply) => {
      if (req.headers.authorization !== `Bearer ${serviceToken}`) return reply.code(401).send({ error: 'private' })
    })
    app.get('/api/sessions', () => ({
      data: [{ id: 'same-id', provider: 'codex', title: `runner-${index}`, cwd: `/workspace/${index}` }],
    }))
    app.post('/api/sessions', async (req) => ({ id: 'created', index, body: req.body }))
    app.post('/api/sessions/same-id/open', () => ({ opened: true, index }))
    app.get('/api/files/content', (req) => ({ index, query: req.query }))
    app.put('/api/files/content', (req, reply) => {
      if ((req.body as { rev: string }).rev !== 'current') return reply.code(409).send({ error: 'file_changed' })
      return { index, body: req.body }
    })
    app.get('/api/images/picture.png', (_req, reply) =>
      reply.header('cache-control', 'private, max-age=31536000, immutable').type('image/png').send(image),
    )
    app.get('/ws', { websocket: true }, (ws) => {
      ws.send(JSON.stringify({ type: 'hello', runner: index, approvalId: 'same-approval' }))
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'startTurn') turns[index]++
        ws.send(
          JSON.stringify({
            type: 'ack',
            runner: index,
            requestId: message.clientRequestId,
            approvalId: message.requestId,
            turns: turns[index],
          }),
        )
      })
    })
    app.get('/ws/terminal', { websocket: true }, (ws) => {
      ws.send(JSON.stringify({ type: 'snapshot', data: `screen-${index}` }))
      ws.on('message', (data, binary) => ws.send(data, { binary }))
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    backends.push(app)
  }
  hub = await createHub(
    config,
    tokens.map((token, index) => ({ id: `r${index}`, name: `机器 ${index}`, tokenHash: tokenHash(token) })),
    'r0',
    '',
  )
  hubUrl = await hub.listen({ host: '127.0.0.1', port: 0 })
  for (let index = 0; index < 2; index++)
    stops.push(
      connectRunner({
        hubUrl: hubUrl.replace('http:', 'ws:'),
        runnerId: `r${index}`,
        token: tokens[index],
        localUrl: `http://127.0.0.1:${(backends[index].server.address() as { port: number }).port}`,
        serviceToken,
      }),
    )
  await until(async () => (await online('r0')) && (await online('r1')))
}, 15_000)

afterAll(async () => {
  stops.forEach((stop) => {
    stop()
  })
  clients.forEach((ws) => {
    ws.terminate()
  })
  await hub?.close()
  await Promise.all(backends.map((app) => app.close()))
})

describe('distributed Hub and two reverse runners', () => {
  it('authenticates once at the Hub and keeps private runner tokens out of the list', async () => {
    expect((await hub.inject('/api/runners')).statusCode).toBe(401)
    const login = await hub.inject({ method: 'POST', url: '/api/auth/login', payload: { pin: 'test-login' } })
    expect(login.statusCode).toBe(200)
    expect(login.headers['set-cookie']).toBeTruthy()
    const result = await hub.inject({ url: '/api/runners', headers: { cookie } })
    expect(result.json().data).toHaveLength(2)
    expect(result.body).not.toContain('tokenHash')
    expect(result.body).not.toContain(tokens[0])
    expect(
      (await hub.inject({ url: '/api/runners', headers: { cookie, host: new URL(hubUrl).host, origin: hubUrl } }))
        .statusCode,
    ).toBe(200)
  })

  it('accepts every configured public origin and nothing else', async () => {
    expect(() => parsePublicOrigins('https://Hub.LAN:3000')).toThrow('lowercase')
    expect(() => parsePublicOrigins('https://hub.lan:3000/')).toThrow()
    const app = await createHub(
      config,
      [{ id: 'r0', name: 'machine 0', tokenHash: tokenHash(tokens[0]) }],
      'r0',
      'https://hub.lan:3000,https://127.0.0.1:3000',
    )
    try {
      for (const origin of ['https://hub.lan:3000', 'https://127.0.0.1:3000']) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/auth/login',
              headers: { origin },
              payload: { pin: 'test-login' },
            })
          ).statusCode,
        ).toBe(200)
      }
      expect((await app.inject({ url: '/api/hub', headers: { origin: 'https://attacker.example' } })).statusCode).toBe(
        403,
      )
      // Top-level navigations carry no Origin header and must stay available.
      expect((await app.inject({ url: '/api/hub' })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('routes identical local IDs to the selected machine', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await hub.inject({ url: `/r/r${i}/api/sessions?provider=all`, headers: { cookie } })
      expect(response.statusCode).toBe(200)
      expect(response.json().data[0]).toMatchObject({ id: 'same-id', title: `runner-${i}` })
    }
  })

  it('forwards JSON bodies and query strings without changing file revisions', async () => {
    const created = await hub.inject({
      method: 'POST',
      url: '/r/r1/api/sessions',
      headers: { cookie },
      payload: { cwd: 'D:\\代码\\demo', provider: 'claude' },
    })
    expect(created.json()).toMatchObject({ index: 1, body: { cwd: 'D:\\代码\\demo' } })
    const read = await hub.inject({ url: '/r/r0/api/files/content?path=%2Fworkspace%2Ftest.txt', headers: { cookie } })
    expect(read.json().query.path).toBe('/workspace/test.txt')
    const stale = await hub.inject({
      method: 'PUT',
      url: '/r/r1/api/files/content',
      headers: { cookie },
      payload: { path: 'a', text: 'b', rev: 'stale' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toBe('file_changed')
    const opened = await hub.inject({ method: 'POST', url: '/r/r1/api/sessions/same-id/open', headers: { cookie } })
    expect(opened.statusCode).toBe(200)
    expect(opened.json()).toMatchObject({ opened: true, index: 1 })
  })

  it('preserves image bytes, MIME and private immutable caching', async () => {
    const response = await hub.inject({ url: '/r/r0/api/images/picture.png', headers: { cookie } })
    expect(response.rawPayload).toEqual(image)
    expect(response.headers['content-type']).toBe('image/png')
    expect(response.headers['cache-control']).toContain('private')
    expect(response.headers['cache-control']).toContain('immutable')
  })

  it('isolates chat and approval traffic between machines', async () => {
    const a = client('/r/r0/ws')
    const b = client('/r/r1/ws')
    expect(JSON.parse((await a.next()).data.toString()).runner).toBe(0)
    expect(JSON.parse((await b.next()).data.toString()).runner).toBe(1)
    a.ws.send(JSON.stringify({ type: 'answerApproval', requestId: 'same-approval', clientRequestId: 'answer' }))
    expect(JSON.parse((await a.next()).data.toString())).toMatchObject({
      runner: 0,
      approvalId: 'same-approval',
      requestId: 'answer',
    })
  })

  it('forwards terminal snapshots and binary frames without corruption', async () => {
    const terminal = client('/r/r1/ws/terminal?id=local-shell&cols=80&rows=24')
    expect(JSON.parse((await terminal.next()).data.toString()).data).toBe('screen-1')
    terminal.ws.send(image, { binary: true })
    const echo = await terminal.next()
    expect(echo.binary).toBe(true)
    expect(echo.data).toEqual(image)
  })

  it('rejects unsigned HTTP, cross-origin HTTP and browser WebSockets', async () => {
    expect((await hub.inject('/r/r0/api/sessions')).statusCode).toBe(401)
    expect(
      (await hub.inject({ url: '/r/r0/api/sessions', headers: { cookie, origin: 'https://attacker.example' } }))
        .statusCode,
    ).toBe(403)
    for (const [headers, status] of [
      [{}, 401],
      [{ cookie, origin: 'https://attacker.example' }, 403],
    ] as [Record<string, string>, number][]) {
      const ws = client('/r/r0/ws', headers).ws
      const actual = await new Promise<number>((resolve) =>
        ws.on('unexpected-response', (_req, response) => {
          resolve(response.statusCode!)
          response.resume()
          ws.terminate()
        }),
      )
      expect(actual).toBe(status)
    }
  })

  it('rejects wrong runner credentials and duplicate live identities', async () => {
    for (const [token, status] of [
      ['x'.repeat(64), 401],
      [tokens[0], 409],
    ] as const) {
      const ws = new WebSocket(hubUrl.replace('http:', 'ws:') + '/runner/connect', PROTOCOL, {
        headers: { authorization: `Bearer ${token}`, 'x-runner-id': 'r0' },
      })
      ws.on('error', () => undefined)
      const response = new Promise<number>((resolve) =>
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode!)
          res.resume()
          ws.terminate()
        }),
      )
      expect(await response).toBe(status)
    }
  })

  it('rejects non-execution paths and unknown runners', async () => {
    expect((await hub.inject({ url: '/r/r0/api/auth/login', headers: { cookie } })).statusCode).toBe(404)
    // The body shape matters: the custom handler must win over Fastify's
    // default serializer, which would replace `{ error }` with
    // `{statusCode,error,message}` and break the client's code mapping.
    const unknown = await hub.inject({ url: '/r/missing/api/sessions', headers: { cookie } })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toEqual({ error: 'unknown_runner' })
    expect(unknown.headers['cache-control']).toBe('no-store')
    for (const path of [
      'https://example.com/api/files',
      '//example.com',
      '/api/images/%2e%2e',
      '/api/../auth/login',
      '/api/files\\content',
      '/api/auth/login',
    ])
      expect(allowedPath(path)).toBe(false)
  })

  it('accepts WS and WSS Hub addresses across machines while rejecting invalid transports and embedded credentials', () => {
    for (const url of [
      'ws://192.168.1.10:5900',
      'ws://hub.lan:5900',
      'ws://[fd00::10]:5900',
      'wss://vibe.example.com',
    ]) {
      expect(parseHubUrl(url).href).toBe(new URL(url).href)
    }
    for (const url of [
      'http://192.168.1.10:5900',
      'https://hub.lan',
      'ws://user:password@hub.lan:5900',
      'wss://user@hub.lan',
      'not-a-url',
    ]) {
      expect(() => parseHubUrl(url)).toThrow()
    }
    expect(() =>
      connectRunner({
        hubUrl: 'ws://hub.lan:5900',
        runnerId: 'test',
        token: tokens[0],
        localUrl: 'http://192.168.1.10:5901',
        serviceToken,
      }),
    ).toThrow('loopback')
  })

  it('allows port 3000 only for the Hub and refuses reserved or occupied executor ports', async () => {
    expect(port('3000', 5900, 'hub')).toBe(3000)
    expect(() => port('8788', 5900, 'hub')).toThrow('reserved')
    expect(() => port('3000', 5900)).toThrow('reserved')
    expect(() => port('8788', 6900)).toThrow('reserved')
    const occupied = (backends[0].server.address() as { port: number }).port
    await expect(assertFree([occupied])).rejects.toThrow('occupied')
  })

  it('reconnects the reverse link and never replays an execution command', async () => {
    const chat = client('/r/r0/ws')
    await chat.next()
    chat.ws.send(JSON.stringify({ type: 'startTurn', clientRequestId: 'turn-1' }))
    expect(JSON.parse((await chat.next()).data.toString()).turns).toBe(1)
    for (const ws of hub.websocketServer.clients) if (ws.protocol === PROTOCOL) ws.terminate()
    await until(async () => !(await online('r0')))
    const response = await hub.inject({ url: '/r/r0/api/sessions', headers: { cookie } })
    expect(response.statusCode).toBe(503)
    expect(response.headers['cache-control']).toBe('no-store')
    await until(async () => await online('r0'))
    const recovered = client('/r/r0/ws')
    expect(JSON.parse((await recovered.next()).data.toString()).approvalId).toBe('same-approval')
    expect(turns[0]).toBe(1)
    expect((await hub.inject({ url: '/r/r0/api/sessions', headers: { cookie } })).statusCode).toBe(200)
  })

  it('recovers remote runner connections after the Hub restarts', async () => {
    const previousPort = (hub.server.address() as { port: number }).port
    await hub.close()
    hub = await createHub(
      config,
      tokens.map((token, index) => ({ id: `r${index}`, name: `机器 ${index}`, tokenHash: tokenHash(token) })),
      'r0',
    )
    hubUrl = await hub.listen({ host: '127.0.0.1', port: previousPort })
    await until(async () => (await online('r0')) && (await online('r1')))
    const response = await hub.inject({ url: '/r/r1/api/sessions', headers: { cookie } })
    expect(response.json().data[0].title).toBe('runner-1')
    expect(turns).toEqual([1, 0])
  })
})

describe('runner credential management', () => {
  let dir: string
  let storeFile: string
  let admin: Awaited<ReturnType<typeof createHub>>

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibemobile-hub-admin-'))
    storeFile = path.join(dir, 'runners.json')
    admin = await createHub(
      config,
      [{ id: 'local', name: '本机', tokenHash: tokenHash(crypto.randomBytes(32).toString('hex')) }],
      'local',
      '',
      undefined,
      new RunnerStore(storeFile),
    )
  })

  afterAll(async () => {
    await admin?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function create(name: string) {
    const response = await admin.inject({ method: 'POST', url: '/api/runners', headers: { cookie }, payload: { name } })
    expect(response.statusCode).toBe(201)
    return response.json() as { id: string; name: string; token: string }
  }

  const persisted = () => JSON.parse(readFileSync(storeFile, 'utf8')) as { id: string; tokenHash: string }[]
  const list = async () =>
    (await admin.inject({ url: '/api/runners', headers: { cookie } })).json() as {
      default: string
      data: { id: string; managed?: boolean; online: boolean }[]
    }

  it('requires a session and rejects cross-origin mutation', async () => {
    expect((await admin.inject({ method: 'POST', url: '/api/runners', payload: { name: '机器B' } })).statusCode).toBe(
      401,
    )
    const crossOrigin = await admin.inject({
      method: 'POST',
      url: '/api/runners',
      headers: { cookie, origin: 'https://attacker.example' },
      payload: { name: '机器B' },
    })
    expect(crossOrigin.statusCode).toBe(403)
  })

  it('creates a runner and returns the token exactly once', async () => {
    const response = await admin.inject({
      method: 'POST',
      url: '/api/runners',
      headers: { cookie },
      payload: { name: '  机器B ' },
    })
    expect(response.statusCode).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json()
    expect(body.name).toBe('机器B')
    expect(body.token).toMatch(/^[a-f0-9]{64}$/)
    expect(response.body).not.toContain('tokenHash')

    const runners = await list()
    expect(runners.data.find((runner) => runner.id === body.id)?.managed).toBe(true)
    expect(runners.data.find((runner) => runner.id === 'local')?.managed).toBeUndefined()
    expect(persisted()).toEqual([{ id: body.id, name: '机器B', tokenHash: tokenHash(body.token) }])
  })

  it('rejects an invalid name', async () => {
    expect(
      (await admin.inject({ method: 'POST', url: '/api/runners', headers: { cookie }, payload: { name: '   ' } }))
        .statusCode,
    ).toBe(400)
  })

  it('rotates the token so the old one no longer matches', async () => {
    const created = await create('机器C')
    const response = await admin.inject({
      method: 'POST',
      url: `/api/runners/${created.id}/token`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const rotated = response.json()
    expect(rotated.token).not.toBe(created.token)

    const spec = persisted().find((runner) => runner.id === created.id)
    expect(spec).toBeDefined()
    expect(spec?.tokenHash).toBe(tokenHash(rotated.token))
    expect(spec?.tokenHash).not.toBe(tokenHash(created.token))
  })

  it('deletes the runner from the list and the file', async () => {
    const created = await create('机器D')
    expect(
      (await admin.inject({ method: 'DELETE', url: `/api/runners/${created.id}`, headers: { cookie } })).statusCode,
    ).toBe(200)
    expect((await list()).data.some((runner) => runner.id === created.id)).toBe(false)
    expect(persisted().some((runner) => runner.id === created.id)).toBe(false)
    // A retried delete is a plain 404, which the UI treats as already gone.
    expect(
      (await admin.inject({ method: 'DELETE', url: `/api/runners/${created.id}`, headers: { cookie } })).statusCode,
    ).toBe(404)
  })

  it('reports an unwritable store as a stable error code', async () => {
    const brokenDir = path.join(dir, 'blocked')
    const broken = await createHub(
      config,
      [{ id: 'local', name: '本机', tokenHash: tokenHash(crypto.randomBytes(32).toString('hex')) }],
      'local',
      '',
      undefined,
      new RunnerStore(path.join(brokenDir, 'runners.json')),
    )
    try {
      const first = await broken.inject({
        method: 'POST',
        url: '/api/runners',
        headers: { cookie },
        payload: { name: 'a' },
      })
      expect(first.statusCode).toBe(201)
      // Make the parent path a regular file so mkdir/rename cannot succeed.
      renameSync(brokenDir, `${brokenDir}-moved`)
      writeFileSync(brokenDir, 'blocked')
      const response = await broken.inject({
        method: 'POST',
        url: '/api/runners',
        headers: { cookie },
        payload: { name: 'b' },
      })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({ error: 'runner_store_unwritable' })
    } finally {
      await broken.close()
    }
  })

  it('never lets the default local runner be rotated or deleted', async () => {
    expect(
      (await admin.inject({ method: 'POST', url: '/api/runners/local/token', headers: { cookie } })).statusCode,
    ).toBe(404)
    expect((await admin.inject({ method: 'DELETE', url: '/api/runners/local', headers: { cookie } })).statusCode).toBe(
      404,
    )
  })
})
