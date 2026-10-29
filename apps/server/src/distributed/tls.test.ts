import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import crypto from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { WebSocket } from 'ws'
import { loadHubTls, loadRunnerCa, defaultRunnerTransport } from './tls.js'
import { createHub, tokenHash } from './hubApp.js'
import { connectRunner } from './bridge.js'
import { PROTOCOL } from './wire.js'
import { COOKIE_NAME, signSession } from '../auth/jwt.js'
import type { Config } from '../config.js'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const ca = fs.readFileSync(fixture('ca.pem'))
const tlsEnv = {
  VIBEMOBILE_HUB_TLS: 'on',
  VIBEMOBILE_HUB_TLS_CERT_FILE: fixture('hub-cert.pem'),
  VIBEMOBILE_HUB_TLS_KEY_FILE: fixture('hub-key.pem'),
  VIBEMOBILE_HUB_CA_FILE: fixture('ca.pem'),
}

describe('TLS configuration', () => {
  it('defaults to plain WS and supports explicitly disabling native TLS with existing file settings', () => {
    expect(loadHubTls({})).toBeUndefined()
    expect(loadHubTls({ ...tlsEnv, VIBEMOBILE_HUB_TLS: 'off' })).toBeUndefined()
    expect(defaultRunnerTransport(5900, undefined, tlsEnv)).toEqual({
      VIBEMOBILE_HUB_URL: 'ws://127.0.0.1:5900',
      VIBEMOBILE_HUB_CA_FILE: '',
    })
  })

  it('loads the certificate pair and configures the default runner to trust the same private CA', () => {
    const tls = loadHubTls(tlsEnv)!
    expect(tls.cert).toEqual(fs.readFileSync(tlsEnv.VIBEMOBILE_HUB_TLS_CERT_FILE))
    expect(defaultRunnerTransport(5900, tls, tlsEnv)).toEqual({
      VIBEMOBILE_HUB_URL: 'wss://127.0.0.1:5900',
      VIBEMOBILE_HUB_CA_FILE: fixture('ca.pem'),
    })
    expect(
      defaultRunnerTransport(5900, tls, { ...tlsEnv, VIBEMOBILE_DEFAULT_RUNNER_HUB_URL: 'wss://localhost:5900' })
        .VIBEMOBILE_HUB_URL,
    ).toBe('wss://localhost:5900')
    expect(() =>
      defaultRunnerTransport(5900, tls, { VIBEMOBILE_DEFAULT_RUNNER_HUB_URL: 'ws://localhost:5900' }),
    ).toThrow('TLS mode')
    expect(
      defaultRunnerTransport(5900, tls, { VIBEMOBILE_HUB_TLS_CERT_FILE: 'self-signed.pem' }).VIBEMOBILE_HUB_CA_FILE,
    ).toBe('self-signed.pem')
  })

  it('fails on missing, malformed or mismatched certificate settings before execution starts', () => {
    expect(() => loadHubTls({ VIBEMOBILE_HUB_TLS: 'invalid' })).toThrow('on or off')
    expect(() => loadHubTls({ VIBEMOBILE_HUB_TLS: 'on' })).toThrow('CERT_FILE')
    expect(() => loadHubTls({ ...tlsEnv, VIBEMOBILE_HUB_TLS_KEY_FILE: 'missing-key.pem' })).toThrow()
    expect(() => loadHubTls({ ...tlsEnv, VIBEMOBILE_HUB_TLS_CERT_FILE: fixture('untrusted-ca.pem') })).toThrow()
    expect(() => loadRunnerCa('wss://hub.lan', { VIBEMOBILE_HUB_CA_FILE: fixture('README.md') })).toThrow(
      'PEM certificates',
    )
    expect(() => loadRunnerCa('wss://hub.lan', { VIBEMOBILE_HUB_CA_FILE: 'missing-ca.pem' })).toThrow()
  })

  it('uses public trust by default for Nginx WSS and reads custom CA files only for WSS', () => {
    expect(loadRunnerCa('wss://public.example', {})).toBeUndefined()
    expect(loadRunnerCa('ws://192.168.1.10:5900', { VIBEMOBILE_HUB_CA_FILE: 'unused.pem' })).toBeUndefined()
    expect(loadRunnerCa('wss://hub.lan', tlsEnv)).toEqual(ca)
  })
})

const token = crypto.randomBytes(32).toString('hex')
const serviceToken = crypto.randomBytes(32).toString('hex')
const config: Config = {
  host: '127.0.0.1',
  port: 0,
  secret: crypto.randomBytes(32).toString('hex'),
  pinHash: null,
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
let backend: FastifyInstance
let url: string
let localUrl: string
const stops: (() => void)[] = []

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('TLS condition timed out')
}
function connect(id: string, options: { ca?: Buffer; hubUrl?: string } = {}) {
  const statuses: string[] = []
  stops.push(
    connectRunner({
      hubUrl: options.hubUrl ?? url,
      ca: options.ca,
      runnerId: id,
      token,
      localUrl,
      serviceToken,
      onStatus: (status) => statuses.push(status),
    }),
  )
  return statuses
}

beforeAll(async () => {
  backend = Fastify()
  await backend.register(websocket)
  backend.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${serviceToken}`) return reply.code(401).send()
  })
  backend.get('/api/sessions', () => ({ data: [{ id: 'tls-session', title: 'encrypted runner' }] }))
  backend.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (data) => socket.send(data))
  })
  localUrl = await backend.listen({ host: '127.0.0.1', port: 0 })
  hub = await createHub(
    config,
    ['trusted', 'no-ca', 'wrong-ca'].map((id) => ({ id, name: id, tokenHash: tokenHash(token) })),
    'trusted',
    undefined,
    loadHubTls(tlsEnv),
  )
  url = (await hub.listen({ host: '127.0.0.1', port: 0 })).replace('https:', 'wss:')
})

afterAll(async () => {
  stops.forEach((stop) => {
    stop()
  })
  await hub?.close()
  await backend?.close()
})

describe('native HTTPS/WSS Hub', () => {
  it('serves HTTPS and forwards HTTP and real-time events over an authenticated private-CA WSS tunnel', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      https
        .get(url.replace('wss:', 'https:') + '/api/hub', { ca }, (response) => {
          response.resume()
          resolve(response.statusCode!)
        })
        .on('error', reject)
    })
    expect(status).toBe(200)
    const statuses = connect('trusted', { ca: loadRunnerCa(url, tlsEnv) })
    await until(async () => statuses.includes('connected'))
    const response = await hub.inject({ url: '/r/trusted/api/sessions', headers: { cookie } })
    expect(response.json().data[0].id).toBe('tls-session')
    const client = new WebSocket(url + '/r/trusted/ws', { ca, headers: { cookie } })
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve)
        client.once('error', reject)
      })
      const echoed = new Promise<string>((resolve) => client.once('message', (message) => resolve(message.toString())))
      client.send('encrypted chat event')
      expect(await echoed).toBe('encrypted chat event')
    } finally {
      client.terminate()
    }
  })

  it('rejects an untrusted certificate with both default trust and an unrelated explicit CA', async () => {
    for (const [id, ca] of [
      ['no-ca', undefined],
      ['wrong-ca', fs.readFileSync(fixture('untrusted-ca.pem'))],
    ] as const) {
      const statuses = connect(id, { ca })
      await until(async () => statuses.some((status) => status.startsWith('connection_error:')))
      expect(statuses).not.toContain('connected')
      const runners = (await hub.inject({ url: '/api/runners', headers: { cookie } })).json().data
      expect(runners.find((runner: { id: string }) => runner.id === id).online).toBe(false)
    }
  })

  it('still verifies runner tokens after successful TLS validation', async () => {
    const client = new WebSocket(url + '/runner/connect', PROTOCOL, {
      ca,
      headers: { 'x-runner-id': 'no-ca', authorization: `Bearer ${'x'.repeat(64)}` },
    })
    client.on('error', () => undefined)
    const status = await new Promise<number>((resolve) =>
      client.on('unexpected-response', (_req, response) => {
        response.resume()
        resolve(response.statusCode!)
        client.terminate()
      }),
    )
    expect(status).toBe(401)
  })

  it('rejects a trusted certificate whose SAN does not match the Hub address', async () => {
    const other = await createHub(
      config,
      [{ id: 'wrong-host', name: 'wrong-host', tokenHash: tokenHash(token) }],
      'wrong-host',
      undefined,
      loadHubTls({ ...tlsEnv, VIBEMOBILE_HUB_TLS_CERT_FILE: fixture('wrong-host-cert.pem') }),
    )
    let stop: (() => void) | undefined
    try {
      const otherUrl = (await other.listen({ host: '127.0.0.1', port: 0 })).replace('https:', 'wss:')
      const statuses: string[] = []
      stop = connectRunner({
        hubUrl: otherUrl,
        ca,
        runnerId: 'wrong-host',
        token,
        localUrl,
        serviceToken,
        onStatus: (status) => statuses.push(status),
      })
      await until(async () => statuses.includes('connection_error:ERR_TLS_CERT_ALTNAME_INVALID'))
      expect(statuses).not.toContain('connected')
    } finally {
      stop?.()
      await other.close()
    }
  })
})
