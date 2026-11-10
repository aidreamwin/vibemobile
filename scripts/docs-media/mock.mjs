import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import {
  NOW,
  ROOT,
  THREAD,
  TURN,
  INTRO,
  RESULT,
  SOURCE,
  DIFF,
  providers,
  sessions,
  approval,
  steps,
  command,
  agentProfiles,
} from './fixtures.mjs'

// This server has no agent, credentials, shell or workspace access. Unknown API
// calls fail closed; static reads can only reach this run's temporary Vite build.
export async function startMock(buildDir, { port = 0, manual = false } = {}) {
  const faults = []
  const clients = new Set()
  const timers = new Set()
  let phase = 'idle'
  let prompt = ''
  let streamed = ''
  const message = (id, role, text) => ({ kind: 'message', id, role, text })
  const event = (kind, data = {}) => ({ kind, threadId: THREAD, turnId: TURN, ...data })
  const emit = (e) => {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'event', event: e }))
    }
  }
  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
  }
  const plan = (completed) =>
    steps.map((step, i) => ({ step, status: i < completed ? 'completed' : i === completed ? 'inProgress' : 'pending' }))
  const items = () => [
    ...(prompt ? [message('demo-user', 'user', prompt)] : []),
    ...(streamed ? [message('demo-intro', 'assistant', streamed)] : []),
    ...(phase === 'done' ? [command, message('demo-result', 'assistant', RESULT)] : []),
    ...(phase === 'interrupted' ? [message('demo-refused', 'assistant', '已取消测试命令，未执行任何操作。')] : []),
  ]
  const status = () => (phase === 'approval' ? 'waitingApproval' : phase === 'working' ? 'working' : 'idle')
  const summary = () => ({ ...sessions[0], status: status(), needsAttention: phase === 'approval' })
  const snapshot = () => ({
    session: summary(),
    turns: prompt
      ? [
          {
            id: TURN,
            status: phase === 'done' ? 'completed' : phase === 'interrupted' ? 'interrupted' : 'inProgress',
            items: items(),
          },
        ]
      : [],
  })
  const control = {
    faults,
    get phase() {
      return phase
    },
    delta(text) {
      streamed += text
      emit(event('delta', { itemId: 'demo-intro', channel: 'text', text }))
    },
    approve() {
      phase = 'approval'
      emit(event('item.completed', { item: message('demo-intro', 'assistant', INTRO) }))
      emit(event('plan.updated', { plan: plan(2) }))
      emit(event('session.status', { status: status() }))
      emit({ kind: 'approval.requested', approval })
    },
    complete() {
      phase = 'done'
      emit(event('approval.resolved', { requestId: approval.requestId }))
      emit(event('item.completed', { item: command }))
      emit(event('diff.updated', { diff: DIFF }))
      emit(event('plan.updated', { plan: plan(3) }))
      emit(event('item.completed', { item: message('demo-result', 'assistant', RESULT) }))
      emit(event('turn.completed', { status: 'completed', at: NOW }))
      emit(event('session.status', { status: 'idle' }))
    },
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://demo.invalid')
    const route = url.pathname.replace(/^\/r\/demo-(?:studio|build)/, '')
    const reply = (body, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (route.startsWith('/api/')) {
      if (req.method !== 'GET' && !(req.method === 'POST' && route === `/api/sessions/${THREAD}/open`)) {
        faults.push(`Unsupported mock API: ${req.method} ${route}`)
        return reply({ error: 'demo_only', message: '演示不执行此操作。' }, 404)
      }
      if (route === '/api/auth/mode') return reply({ authDisabled: false })
      if (route === '/api/auth/me') return reply({ authenticated: true })
      if (route === '/api/hub') return reply({ mode: 'hub' })
      if (route === '/api/runners')
        return reply({
          default: 'demo-studio',
          data: [
            { id: 'demo-studio', name: '演示工作站', online: true, lastSeen: NOW },
            { id: 'demo-build', name: '演示构建机', online: true, lastSeen: NOW },
          ],
        })
      if (route === '/api/system/update')
        return reply({
          scope: 'runner',
          role: 'runner',
          sharedInstall: false,
          supported: false,
          manager: 'unknown',
          reason: 'update_not_supported',
          manualCommand: null,
          current: { serverVersion: '0.1.64', webVersion: '0.1.64', commit: null, dirty: false },
          latest: null,
          updateAvailable: false,
          checking: false,
          feedError: null,
          job: null,
          logTail: null,
        })
      if (route === '/api/health')
        return reply({
          ok: true,
          uptime: 18420,
          build: { version: '0.1.64', commit: null, dirty: false, builtAt: NOW },
          buildOnDisk: null,
          providers: providers.map((provider) => ({ id: provider.id, ready: true })),
          roots: [ROOT],
          terminal: { enabled: true },
        })
      if (route === '/api/agents') return reply({ data: [] })
      if (route === '/api/agent-profiles') return reply(agentProfiles)
      if (route === '/api/projects')
        return reply({
          data: [{ id: 'aurora-shop', name: 'Aurora Shop', path: ROOT, isGitRepo: true, gitBranch: 'demo/cart-fix' }],
        })
      if (route === '/api/providers') return reply({ default: 'codex', data: providers })
      if (/^\/api\/providers\/[^/]+\/models$/.test(route)) {
        const provider = providers.find((p) => route.includes(`/${p.id}/`))
        return reply({
          data: provider
            ? [
                {
                  id: provider.model,
                  displayName: provider.model,
                  efforts: ['low', 'medium', 'high'],
                  defaultEffort: 'medium',
                },
              ]
            : [],
        })
      }
      if (route === '/api/features') return reply({ terminal: true, terminalReason: null })
      if (route === '/api/sessions') {
        const filter = url.searchParams.get('provider')
        const search = url.searchParams.get('search') ?? ''
        return reply({
          data: [summary(), ...sessions.slice(1)].filter(
            (s) => (!filter || filter === 'all' || s.provider === filter) && s.title.includes(search),
          ),
        })
      }
      if (route === `/api/sessions/${THREAD}/open`) return reply(summary())
      if (route === `/api/sessions/${THREAD}`) return reply(snapshot())
      if (route === '/api/files/diff') return reply({ diff: phase === 'done' ? DIFF : '' })
      if (
        route === '/api/files/content' &&
        req.method === 'GET' &&
        url.searchParams.get('path') === `${ROOT}/src/cart.ts`
      ) {
        return reply({
          path: `${ROOT}/src/cart.ts`,
          text: SOURCE,
          bytes: Buffer.byteLength(SOURCE),
          truncated: false,
          rev: 'demo-revision',
        })
      }
      faults.push(`Unsupported mock API: ${req.method} ${route}`)
      return reply({ error: 'demo_only', message: '演示仅开放录制流程，其他操作不连接真实服务。' }, 404)
    }
    const relative =
      route === '/sw.js'
        ? 'sw.js'
        : route.startsWith('/assets/') || /^\/(?:icon-192.png|favicon.png|manifest.webmanifest)$/.test(route)
          ? route.slice(1)
          : 'index.html'
    const file = path.resolve(buildDir, relative)
    if (!file.startsWith(`${path.resolve(buildDir)}${path.sep}`)) {
      res.writeHead(403)
      return res.end()
    }
    try {
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.webmanifest': 'application/manifest+json',
      }
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  const ws = new WebSocketServer({ server })
  ws.on('connection', (client, req) => {
    if (req.url.includes('/ws/terminal')) {
      client.send(
        JSON.stringify({ type: 'ready', id: 'demo-terminal', shell: 'demo-shell', cwd: ROOT, attached: true }),
      )
      later(
        () =>
          client.send(
            JSON.stringify({
              type: 'output',
              data: '\u001b[36mAurora Shop · terminal\u001b[0m\r\n\r\n$ npm test -- src/cart.test.ts\r\n\r\n\u001b[32mPASS\u001b[0m src/cart.test.ts\r\n  ✓ empty cart returns zero\r\n  ✓ adds item totals\r\n  ✓ supports multiple quantities\r\n\r\nTests  3 passed (3)\r\n\r\n$ ',
            }),
          ),
        100,
      )
      return // Deliberately never interprets or executes terminal input.
    }
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.clientRequestId) client.send(JSON.stringify({ type: 'ack', requestId: msg.clientRequestId }))
      if (msg.type === 'subscribe' && phase !== 'idle') {
        emit(event('session.status', { status: status() }))
        emit(event('plan.updated', { plan: plan(phase === 'done' ? 3 : phase === 'approval' ? 2 : 0) }))
        if (phase === 'approval') emit({ kind: 'approval.requested', approval })
        if (phase === 'done') emit(event('diff.updated', { diff: DIFF }))
      }
      if (msg.type === 'startTurn') {
        prompt = msg.input
          .filter((i) => i.type === 'text')
          .map((i) => i.text)
          .join('\n')
        streamed = ''
        phase = 'working'
        emit(event('turn.started'))
        emit(event('session.status', { status: status() }))
        emit(event('item.completed', { item: message('demo-user', 'user', prompt) }))
        emit(event('item.started', { item: message('demo-intro', 'assistant', '') }))
        emit(event('plan.updated', { plan: plan(0) }))
        if (!manual) {
          Array.from(INTRO).forEach((c, i) => {
            later(() => control.delta(c), 500 + i * 45)
          })
          later(() => control.approve(), 500 + INTRO.length * 45)
        }
      }
      if (msg.type === 'answerApproval') {
        if (msg.decision === 'accept') control.complete()
        else {
          phase = 'interrupted'
          emit(event('approval.resolved', { requestId: approval.requestId }))
          emit(
            event('item.completed', {
              item: message('demo-refused', 'assistant', '已取消测试命令，未执行任何操作。'),
            }),
          )
          emit(event('turn.completed', { status: 'interrupted', at: NOW }))
          emit(event('session.status', { status: 'idle' }))
        }
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    ...control,
    get phase() {
      return phase
    },
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const timer of timers) clearTimeout(timer)
      for (const client of ws.clients) client.terminate()
      ws.close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
