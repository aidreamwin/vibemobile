// Isolated browser regression: serves a built SPA with fake HTTP/WS providers.
// Never connects to the installed service or launches an agent.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { WebSocket, WebSocketServer } from 'ws'

const dist = path.resolve(process.argv[2] ?? 'apps/web/dist')
const out = path.resolve(process.argv[3] ?? '.vibemobile/error-smoke')
fs.mkdirSync(out, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemobile-error-smoke-'))
const browserPath = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p))
if (!browserPath) throw new Error('No test browser found')
let failed = false
let retried = false
const commands = []
const retryItem = {
  kind: 'retry',
  id: 'retry:turn',
  attempts: [{ attempt: 2, maxRetries: 10, delayMs: 1200, message: '503 unavailable' }],
}
const session = {
  id: 'fixture',
  provider: 'claude',
  title: 'Error visibility test',
  cwd: 'D:/fixture',
  status: 'idle',
  model: 'test',
  createdAt: Date.now(),
  updatedAt: Date.now(),
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture')
  const route = url.pathname.replace(/^\/r\/fixture/, '')
  const json = (value) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(value))
  }
  if (route === '/api/auth/mode') return json({ authDisabled: true })
  if (route === '/api/hub') return json({ mode: 'hub' })
  if (route === '/api/runners')
    return json({ default: 'fixture', data: [{ id: 'fixture', name: 'Fixture', online: true }] })
  if (route.endsWith('/open')) return json(session)
  if (route === '/api/sessions/fixture')
    return json({
      session,
      turns: [
        {
          id: 'turn',
          status: failed ? 'failed' : 'completed',
          items: [
            { kind: 'message', id: 'prompt', role: 'user', text: 'Fixture task' },
            ...(failed
              ? [retryItem, { kind: 'error', id: 'turn-error:turn', message: '500 gateway unavailable' }]
              : []),
            ...(retried ? [{ kind: 'message', id: 'prompt-retried', role: 'user', text: 'Fixture task' }] : []),
          ],
        },
      ],
    })
  if (route.endsWith('/models')) return json({ data: [{ id: 'test', displayName: 'Test' }] })
  if (route === '/api/providers')
    return json({ default: 'claude', data: [{ id: 'claude', available: true, authenticated: true }] })
  if (route === '/api/features') return json({ terminal: false })
  if (route.startsWith('/api/')) return json({ data: [] })
  const candidate = path.resolve(dist, '.' + url.pathname)
  const file =
    candidate.startsWith(dist + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(dist, 'index.html')
  res.setHeader(
    'content-type',
    file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.svg')
          ? 'image/svg+xml'
          : 'text/html',
  )
  res.end(fs.readFileSync(file))
})
const wss = new WebSocketServer({ server })
wss.on('connection', (peer) =>
  peer.on('message', (raw) => {
    const message = JSON.parse(raw)
    if (message.type === 'startTurn') commands.push(message)
    if (message.clientRequestId) peer.send(JSON.stringify({ type: 'ack', requestId: message.clientRequestId }))
  }),
)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let cdp
let sequence = 0
const pending = new Map()
const exceptions = []
function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method}: timeout`))
    }, 10000)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject,
    })
    cdp.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(expression)) return
    await delay(100)
  }
  throw new Error(`Browser assertion timed out: ${expression}`)
}
function emit(event) {
  for (const peer of wss.clients)
    if (peer.readyState === 1)
      peer.send(JSON.stringify({ type: 'event', event: { threadId: 'fixture', turnId: 'turn', ...event } }))
}
try {
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100)
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0]
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve) => cdp.once('open', resolve))
  cdp.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
    }
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails)
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: `${base}/r/fixture/chat/fixture` })
  await waitFor("document.body.innerText.includes('Fixture task')")
  emit({ kind: 'turn.started' })
  emit({ kind: 'session.status', status: 'working' })
  emit({ kind: 'item.updated', item: retryItem })
  emit({ kind: 'error', message: '503 unavailable', willRetry: true, retryAttempt: 2, maxRetries: 10, retryInMs: 1200 })
  await waitFor("document.querySelector('[role=status]')?.innerText.includes('2/10')")
  const retryImage = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(out, 'retry.png'), Buffer.from(retryImage.data, 'base64'))
  emit({ kind: 'turn.completed', status: 'failed', error: { message: '500 gateway unavailable' } })
  emit({ kind: 'session.status', status: 'idle' })
  await waitFor(
    "document.querySelector('[role=alert]')?.innerText.includes('500 gateway unavailable') && !document.querySelector('[role=status]')",
  )
  failed = true
  await send('Page.reload')
  await waitFor(
    "document.querySelector('[role=alert]')?.innerText.includes('500 gateway unavailable') && document.body.innerText.includes('本轮失败')",
  )
  await waitFor(
    "document.body.innerText.includes('自动重试记录（1 次）') && [...document.querySelectorAll('button')].some(b => b.textContent === '重试上一条')",
  )
  const failureImage = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(out, 'failure-after-reload.png'), Buffer.from(failureImage.data, 'base64'))
  if (commands.length) throw new Error('Retry ran without a click')
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === '重试上一条').click()")
  await waitFor("[...document.querySelectorAll('button')].some(b => b.textContent === '重试上一条' && !b.disabled)")
  if (
    commands.length !== 1 ||
    commands[0].threadId !== 'fixture' ||
    !commands[0].input.some((i) => i.type === 'text' && i.text === 'Fixture task')
  )
    throw new Error('Retry did not send the original prompt exactly once')
  retried = true
  emit({ kind: 'item.completed', item: { kind: 'message', id: 'prompt-retried', role: 'user', text: 'Fixture task' } })
  await delay(150)
  if ((await evaluate("document.body.innerText.split('Fixture task').length - 1")) !== 1)
    throw new Error('Retry duplicated the unanswered prompt bubble')
  await send('Page.reload')
  await waitFor("document.body.innerText.includes('Fixture task')")
  if ((await evaluate("document.body.innerText.split('Fixture task').length - 1")) !== 1)
    throw new Error('Reload duplicated the retried prompt bubble')
  if (exceptions.length) throw new Error(`Uncaught browser errors: ${JSON.stringify(exceptions)}`)
  if (await evaluate('document.documentElement.scrollWidth > innerWidth')) throw new Error('Mobile layout overflows')
  console.log(
    'PASS: live retries, retry history, persistent failure and manual retry click; fake WS received original prompt once; no agent executed.',
  )
} finally {
  cdp?.close()
  for (const peer of wss.clients) peer.terminate()
  wss.close()
  server.close()
  browser.kill()
}
