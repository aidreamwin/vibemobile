import crypto from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig, getGeneratedPin } from '../config.js'
import { createHub, tokenHash, validateRunners } from './hubApp.js'
import { RunnerStore } from './runnerStore.js'
import { assertFree, port, statePath } from './runtime.js'
import { defaultRunnerTransport, loadHubTls } from './tls.js'

const hubPort = port(process.env.PORT, 5900, 'hub')
const withDefault = process.env.VIBEMOBILE_DEFAULT_RUNNER !== 'off'
const defaultId = process.env.VIBEMOBILE_DEFAULT_RUNNER_ID?.trim() || 'local'
const runnerPort = port(process.env.VIBEMOBILE_RUNNER_PORT, 5901)
const codexPort = port(process.env.CODEX_PORT, 6900)
const https = loadHubTls()
const defaultTransport = withDefault ? defaultRunnerTransport(hubPort, https) : undefined
if (https) process.env.VIBEMOBILE_SECURE_COOKIE = '1'
await assertFree(withDefault ? [hubPort, runnerPort, codexPort] : [hubPort])
// The state dir has to be known before the runners file: when no explicit
// VIBEMOBILE_RUNNERS_FILE is set, UI-created credentials live inside it (and
// therefore inside the hub-data volume).
// `??` is not enough: Docker Compose writes `${HUB_RUNNERS_FILE:-}` as an
// *empty string* on the container, and an empty path made the store write a
// temp file into /app and then rename it to "" — every create failed as
// `runner_store_unwritable` while the volume itself was writable.
const stateDir = process.env.VIBEMOBILE_STATE_DIR?.trim() || statePath('hub')
process.env.VIBEMOBILE_STATE_DIR = stateDir
const runnersFile = process.env.VIBEMOBILE_RUNNERS_FILE?.trim() || path.join(stateDir, 'runners.json')
const runnerStore = new RunnerStore(runnersFile)
// Validate *after* prepending the default runner. The remote list may be
// empty while the default runner is enabled — validating it alone would reject
// that perfectly normal configuration.
const configured = runnerStore.list()
const defaultToken = crypto.randomBytes(32).toString('hex')
let specs = configured
if (withDefault) {
  if (configured.some((s) => s.id === defaultId))
    throw new Error('default runner ID collides with configured remote runner')
  specs = [
    {
      id: defaultId,
      name: process.env.VIBEMOBILE_DEFAULT_RUNNER_NAME?.trim() || '本机',
      tokenHash: tokenHash(defaultToken),
    },
    ...configured,
  ]
}
validateRunners(specs)
process.env.PORT = String(hubPort)
const config = loadConfig()
const app = await createHub(
  config,
  specs,
  withDefault ? defaultId : specs[0].id,
  process.env.VIBEMOBILE_PUBLIC_ORIGIN,
  https,
  runnerStore,
)
const generatedPin = getGeneratedPin(config.stateDir)
app.log.info(generatedPin ? `Hub login PIN: ${generatedPin}` : 'Hub PIN: configured by environment')

if (withDefault) {
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './runner.ts' : './runner.js', import.meta.url)),
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
      env: {
        ...process.env,
        VIBEMOBILE_STATE_DIR:
          process.env.VIBEMOBILE_DEFAULT_RUNNER_STATE_DIR?.trim() || statePath('runners', defaultId),
        ...defaultTransport,
        VIBEMOBILE_RUNNER_ID: defaultId,
        VIBEMOBILE_RUNNER_TOKEN: defaultToken,
        VIBEMOBILE_RUNNER_PORT: String(runnerPort),
        CODEX_PORT: String(codexPort),
      },
    },
  )
  child.on('error', (error) => app.log.error({ err: error }, 'default runner failed'))
  child.on('exit', (code) => app.log.warn({ code }, 'default runner exited; remote runners remain available'))
  app.addHook('onClose', async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (process.platform === 'win32' && child.pid)
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill('SIGKILL')
        resolve()
      }, 10_000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      if (child.connected) child.send('shutdown')
      else child.kill('SIGTERM')
    })
  })
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
process.on('message', (message) => {
  if (message === 'shutdown') process.emit('SIGTERM')
})
await app.listen({ host: config.host, port: hubPort })
