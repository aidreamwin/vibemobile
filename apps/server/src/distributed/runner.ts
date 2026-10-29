import crypto from 'node:crypto'
import { connectRunner, parseHubUrl } from './bridge.js'
import { assertFree, port, statePath } from './runtime.js'
import { loadRunnerCa } from './tls.js'

const runnerId = process.env.VIBEMOBILE_RUNNER_ID
const token = process.env.VIBEMOBILE_RUNNER_TOKEN
const hubUrl = process.env.VIBEMOBILE_HUB_URL
if (!runnerId || !/^[a-zA-Z0-9_-]{1,64}$/.test(runnerId) || !token || token.length < 32 || !hubUrl)
  throw new Error('set RUNNER_ID, RUNNER_TOKEN (32+ characters), and HUB_URL')
parseHubUrl(hubUrl)
const ca = loadRunnerCa(hubUrl)
const httpPort = port(process.env.VIBEMOBILE_RUNNER_PORT, 5901)
const codexPort = port(process.env.CODEX_PORT, 6900)
await assertFree([httpPort, codexPort])
const serviceToken = crypto.randomBytes(32).toString('hex')
Object.assign(process.env, {
  PORT: String(httpPort),
  CODEX_PORT: String(codexPort),
  CODEX_WS_URL: '',
  VIBEMOBILE_HOST: '127.0.0.1',
  VIBEMOBILE_PIN: '',
  VIBEMOBILE_NO_AUTH: 'true',
  VIBEMOBILE_RUNNER_SERVICE_TOKEN: serviceToken,
  VIBEMOBILE_STATE_DIR: process.env.VIBEMOBILE_STATE_DIR ?? statePath('runners', runnerId),
  VIBEMOBILE_WEB_DIST: statePath('no-web-assets'),
})
// Register before startup: parent IPC can disappear while a provider is starting.
let shutdownRequested = false
let executionReady = false
const shutdown = () => {
  shutdownRequested = true
  if (executionReady) process.emit('SIGTERM')
}
process.on('message', (message) => {
  if (message === 'shutdown') shutdown()
})
process.on('disconnect', shutdown)
// Reuse the execution service without changing providers or their persistence.
await import('../index.js')
executionReady = true
if (shutdownRequested) process.emit('SIGTERM')
else {
  const stop = connectRunner({
    hubUrl,
    runnerId,
    token,
    ca,
    localUrl: `http://127.0.0.1:${httpPort}`,
    serviceToken,
    onStatus: (status) => console.log(`runner ${runnerId}: ${status}`),
  })
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
