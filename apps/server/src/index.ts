import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { loadConfig } from './config.js'
import { registry } from './providers/registry.js'
import { probeCache } from './providers/probeCache.js'
import { CodexProvider } from './codex/CodexProvider.js'
import { ClaudeProvider } from './claude/ClaudeProvider.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerFileRoutes } from './routes/files.js'
import { registerImageRoutes } from './routes/images.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerHub } from './ws/hub.js'
import { registerTerminal } from './ws/terminal.js'

const config = loadConfig()

const app = Fastify({
  logger: {
    level: config.logLevel === 'silent' ? 'silent' : config.logLevel === 'debug' ? 'debug' : 'info',
  },
  // Opt-in (VIBEMOBILE_TRUST_PROXY), because the login throttle keys on
  // `req.ip` and this is what decides whether that is the socket address or a
  // header the client wrote. See the field comment in `config.ts`: with it on
  // unconditionally, a rotating `X-Forwarded-For` defeats the throttle
  // entirely, and the throttle is the only thing standing between the network
  // and the login PIN.
  trustProxy: config.trustProxy,
})

await app.register(cookie)
await app.register(websocket)

// A distributed runner's loopback API accepts only its bridge's private token.
// Browser cookies and public runner credentials never enter this local service.
const serviceToken = process.env.VIBEMOBILE_RUNNER_SERVICE_TOKEN
if (serviceToken) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${serviceToken}`) return reply.code(401).send({ error: 'unauthorized' })
  })
}

// ---------------------------------------------------------------- provider

// The routing layer's own diagnostics (a provider that failed a session
// lookup) go to the service log rather than a console nobody reads.
registry.log = (message, detail) => app.log.warn({ detail }, message)

const codex = new CodexProvider({
  port: config.codex.port,
  attachUrl: config.codex.attachUrl,
  workspaceRoots: config.workspaceRoots,
  stateDir: config.stateDir,
  onLog: (line) => app.log.debug(line),
  // Same reasoning as Claude's below: the only thing ever sent here is the
  // notice that a thread came back on an unattended pair, and `debug` is
  // invisible at the deployed level.
  onNotice: (line) => app.log.warn(line),
})
registry.register(codex)

// Registered AFTER Codex on purpose: `registry.default` is "the first provider
// registered", so this keeps existing behaviour for every request that does not
// name one. Nothing here is fatal either — if the Claude CLI is missing,
// `probe()` reports it unavailable and the UI says so rather than the server
// refusing to start.
const claude = new ClaudeProvider({
  workspaceRoots: config.workspaceRoots,
  stateDir: config.stateDir,
  onLog: (line) => app.log.debug(line),
  // Warn rather than debug: this is the line that says a session came back on
  // a level that acts without asking, and the deployment runs at `info`.
  onNotice: (line) => app.log.warn(line),
})
registry.register(claude)

codex.on('reconnected', async () => {
  app.log.warn('app-server reconnected; re-subscribing known threads')
  await codex.resubscribeAll?.().catch((err) => app.log.error({ err }, 'resubscribe failed'))
})
codex.on('error', (err: Error) => app.log.error({ err }, 'codex provider error'))
claude.on('error', (err: Error) => app.log.error({ err }, 'claude provider error'))

app.addHook('onClose', async () => {
  await Promise.allSettled([codex.stop(), claude.stop()])
})

// ------------------------------------------------------------------ routes

registerHealthRoutes(app, config)
registerAuthRoutes(app, config)
registerSessionRoutes(app, config)
registerFileRoutes(app, config)
registerImageRoutes(app, config)
registerHub(app, config)
registerTerminal(app, config)

// ------------------------------------------------------------------ static

if (fs.existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist, index: false })

  // With `index: false`, @fastify/static answers 403 for any path that
  // resolves to a directory — including `/` itself, which is exactly where the
  // app lives. A static route beats its wildcard, so this wins.
  app.get('/', (req, reply) => reply.sendFile('index.html'))

  // SPA fallback: anything that is not /api or /ws renders the app shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
  app.log.info({ webDist: config.webDist }, 'serving built web assets')
} else {
  app.log.info(
    { webDist: config.webDist },
    'no built web assets found — run the Vite dev server (npm run dev:web) or `npm run build`',
  )
}

// ------------------------------------------------------------------- start

await app.listen({ host: config.host, port: config.port })

try {
  await codex.start()
  app.log.info('codex app-server ready')
} catch (err) {
  // The HTTP server stays up so the UI can explain what is wrong.
  app.log.error({ err }, 'codex app-server failed to start — check `codex login status`')
}

// Claude needs no eager startup — its `start()` only flips a flag, because the
// CLI is spawned per turn. Any real problem (missing binary, bad credentials)
// shows up in `probe()`, which is what the UI reads.
await claude.start().catch((err) => app.log.error({ err }, 'claude provider failed to start'))

// Warm the probe cache while nobody is waiting. `probe()` is not cheap —
// Claude's spawns a ~230 MB native CLI binary — and the session list screen
// reads provider status before it renders anything, so the first phone to
// connect used to pay that spawn itself. Nothing here is awaited: a provider
// that is down will burn the app-server's 30 s readiness timeout, and that must
// not delay startup or the HTTP listener.
void probeCache.probeAll(registry.list())

printBanner(app.log)

// ---------------------------------------------------------------- shutdown

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`received ${signal}, shutting down`)
    app.close().finally(() => process.exit(0))
  })
}

function printBanner(log: typeof app.log) {
  if (serviceToken) {
    log.info({ port: config.port }, 'private runner execution service (loopback, bridge authentication required)')
    return
  }
  const lines: string[] = []
  const lan = lanAddresses()

  lines.push('')
  lines.push('  VibeMobile is running')
  lines.push('')
  for (const addr of lan) lines.push(`    phone  ->  http://${addr}:${config.port}`)
  if (!lan.length) lines.push(`    local  ->  http://localhost:${config.port}`)
  lines.push('')

  if (config.authDisabled) {
    lines.push('  AUTH DISABLED — anyone who can reach this port controls your machine.')
  } else {
    const generated = readGeneratedPin(config.stateDir)
    if (generated) {
      lines.push(`  PIN:  ${generated}`)
      lines.push('  (auto-generated; set VIBEMOBILE_PIN to choose your own)')
    } else {
      lines.push('  PIN:  as configured via VIBEMOBILE_PIN')
    }
  }

  lines.push('')
  lines.push(`  workspaces: ${config.workspaceRoots.join(', ')}`)
  lines.push('')
  log.info(lines.join('\n'))
}

function lanAddresses(): string[] {
  const out: string[] = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address)
    }
  }
  return out
}

function readGeneratedPin(stateDir: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    return raw?.generatedPin
  } catch {
    return undefined
  }
}
