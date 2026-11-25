import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AgentApp,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type SessionConfigOption,
  type PromptResponse,
  type SessionUpdate,
  type RequestPermissionOutcome,
} from '@agentclientprotocol/sdk'
import type { AgentEvent } from '@vibemobile/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProvider } from './AntigravityProvider.js'

let cwd: string
let agent: AgentApp
let provider: AntigravityProvider
let connection: ClientConnection
let events: AgentEvent[]
let apiKey: string
let launchKeys: (string | undefined)[]
const configOptions = [
  {
    type: 'select',
    category: 'model',
    id: 'model',
    name: 'Model',
    currentValue: 'gemini-a',
    options: [
      { value: 'gemini-a', name: 'Gemini A' },
      { value: 'gemini-b', name: 'Gemini B' },
    ],
  },
] satisfies SessionConfigOption[]
beforeEach(() => {
  apiKey = ''
  launchKeys = []
  cwd = mkdtempSync(path.join(os.tmpdir(), 'vibe-agy-acp-'))
  agent = new AgentApp().onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.16' },
    authMethods: [{ id: 'gemini-api-key', name: 'Gemini API key' }],
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, close: {} },
      promptCapabilities: { image: true },
    },
  }))
  provider = new AntigravityProvider({
    bin: 'agy',
    workspaceRoots: [cwd],
    stateDir: cwd,
    apiKey: () => apiKey,
    connect: async (client, _cwd, _bin, key) => {
      launchKeys.push(key)
      connection = client.connect(agent)
      return connection
    },
  })
  events = []
  provider.subscribe((event) => events.push(structuredClone(event)))
})
afterEach(async () => {
  await provider.stop()
  rmSync(cwd, { recursive: true, force: true })
})

describe('Antigravity ACP session lifecycle', () => {
  it('authenticates each managed connection before new or resumed sessions and restores CLI login on removal', async () => {
    let authenticatedLaunch = 0
    const methods: string[] = []
    agent.onRequest('authenticate', ({ params }) => {
      expect(params).toEqual({ methodId: 'gemini-api-key' })
      authenticatedLaunch = launchKeys.length
      methods.push(params.methodId)
      return {}
    })
    agent.onRequest('session/new', () => {
      expect(authenticatedLaunch).toBe(launchKeys.length)
      return { sessionId: 'one' }
    })
    agent.onRequest('session/load', ({ params }) => {
      expect(authenticatedLaunch).toBe(launchKeys.length)
      expect(params.sessionId).toBe('one')
      return {}
    })
    agent.onRequest('session/list', () => {
      if (authenticatedLaunch !== launchKeys.length) throw new RequestError(-32000, 'Authentication required')
      return { sessions: [] }
    })
    apiKey = 'first-key'
    const session = await provider.createSession({ cwd })
    await provider.stop()
    apiKey = 'next-key'
    await expect(provider.resumeSession(session.id)).resolves.toMatchObject({ id: session.id })
    await expect(provider.probe()).resolves.toMatchObject({ authenticated: true })
    await provider.stop()
    apiKey = ''
    await expect(provider.probe()).resolves.toMatchObject({ available: true, authenticated: false })
    expect(launchKeys).toEqual(['first-key', 'next-key', ''])
    expect(methods).toEqual(['gemini-api-key', 'gemini-api-key'])
  })

  it('distinguishes an agent requiring login from an unusable CLI', async () => {
    agent.onRequest('session/list', () => {
      throw new RequestError(-32000, 'Authentication required')
    })
    agent.onRequest('session/new', () => {
      throw new RequestError(-32000, 'Authentication required')
    })
    await expect(provider.probe()).resolves.toMatchObject({ available: true, authenticated: false, version: '1.5.16' })
    await expect(provider.createSession({ cwd })).rejects.toThrow('agy acp --login')
    const missing = new AntigravityProvider({ bin: path.join(cwd, 'missing-agy'), workspaceRoots: [cwd] })
    await expect(missing.probe()).resolves.toMatchObject({ available: false })
  })

  it('lists and resumes CLI history using the native id, scoped to allowed workspaces', async () => {
    agent.onRequest('session/list', ({ params }) =>
      params.cursor
        ? {
            sessions: [{ sessionId: 'older', title: 'Older chat', cwd }],
          }
        : {
            sessions: [
              { sessionId: 'outside', cwd: os.tmpdir() },
              { sessionId: 'multi', cwd, additionalDirectories: [os.tmpdir()] },
            ],
            nextCursor: 'page2',
          },
    )
    let loads = 0
    agent.onRequest('session/load', async ({ params, client }) => {
      expect(params).toMatchObject({ cwd, sessionId: 'older', mcpServers: [] })
      loads++
      const emit = (update: SessionUpdate) => client.notify('session/update', { sessionId: params.sessionId, update })
      await emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'CLI question' } })
      for (let i = 0; i < 75; i++) {
        await emit({ sessionUpdate: 'tool_call', toolCallId: `call${i}`, title: `Tool ${i}`, status: 'completed' })
      }
      await emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First reply' } })
      return { configOptions }
    })
    agent.onRequest('session/prompt', async ({ client, params }) => {
      expect(params.sessionId).toBe('older')
      await client.notify('session/update', {
        sessionId: 'older',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Second reply' },
        },
      })
      return { stopReason: 'end_turn' }
    })
    expect((await provider.listSessions({ search: 'old' })).map((s) => s.id)).toEqual(['agy:older'])
    await expect(provider.getSession('agy:outside')).resolves.toBeNull()
    await expect(provider.getSession('agy:multi')).resolves.toBeNull()
    await expect(provider.getSession('codex-id')).resolves.toBeNull()
    const [summary, latest] = await Promise.all([
      provider.resumeSession('agy:older'),
      provider.getTranscript('agy:older', { targetItems: 60 }),
    ])
    expect(loads).toBe(1)
    expect(summary?.canDelete).toBe(false)
    expect(events.filter((e) => e.kind.startsWith('item.') || e.kind === 'delta')).toEqual([])
    expect(latest?.turns[0]?.items).toHaveLength(60)
    expect(latest?.turns[0]?.hasEarlierItems).toBe(true)
    await provider.startTurn('agy:older', [{ type: 'text', text: 'Continue' }])
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'turn.completed')).toBe(true))
    if (!latest?.nextCursor) throw new Error('missing older page')
    const older = await provider.getTranscript('agy:older', { targetItems: 60, cursor: latest.nextCursor })
    expect(older?.turns[0]?.items).toHaveLength(17)
    expect(older?.turns[0]?.items[0]).toMatchObject({ text: 'CLI question' })
    expect(older?.turns[0]?.id).toBe(latest.turns[0]?.id)
    expect(older?.hasMore).toBeUndefined()
    expect(loads).toBe(1)
    await expect(provider.deleteSession('agy:older')).rejects.toMatchObject({ statusCode: 501 })
  })

  it('creates a native session, sends model and images, and routes exactly the selected one-time approval', async () => {
    let outcome: RequestPermissionOutcome | undefined
    let appliedModel = ''
    agent.onRequest('session/new', ({ params }) => {
      expect(params.cwd).toBe(cwd)
      return { sessionId: 'phone', configOptions }
    })
    agent.onRequest('session/set_config_option', ({ params }) => {
      appliedModel = String(params.value)
      return { configOptions: configOptions.map((option) => ({ ...option, currentValue: appliedModel })) }
    })
    agent.onRequest('session/prompt', async ({ params, client }) => {
      expect(params.sessionId).toBe('phone')
      expect(params.prompt[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AQID' })
      const notify = (update: SessionUpdate) => client.notify('session/update', { sessionId: params.sessionId, update })
      await notify({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } })
      const approval = await client.request('session/request_permission', {
        sessionId: 'phone',
        toolCall: { toolCallId: 'cmd', kind: 'execute', title: 'Run test' },
        options: [
          { optionId: 'allow-this', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny-this', name: 'Deny', kind: 'reject_once' },
          { optionId: 'persist', name: 'Always allow', kind: 'allow_always' },
        ],
      })
      outcome = approval.outcome
      for (const text of ['works', '!'])
        await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
      return { stopReason: 'end_turn' }
    })
    const session = await provider.createSession({ cwd })
    expect((await provider.listModels()).map((m) => m.id)).toEqual(['gemini-a', 'gemini-b'])
    const run = await provider.startTurn(
      session.id,
      [
        { type: 'text', text: 'hello' },
        { type: 'image', url: 'data:image/png;base64,AQID' },
      ],
      { model: 'gemini-b', sandbox: 'workspace-write', approvalPolicy: 'on-request' },
    )
    expect(appliedModel).toBe('gemini-b')
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'approval.requested')).toBe(true))
    const approval = events.find((e) => e.kind === 'approval.requested')?.approval
    if (!approval) throw new Error('missing approval')
    expect(approval.availableDecisions).toEqual(['accept', 'decline', 'cancel'])
    expect((await provider.resumeSession(session.id))?.status).toBe('waitingApproval')
    expect((await provider.getTranscript(session.id))?.turns[0]?.id).toBe(run.turnId)
    await expect(provider.answerApproval(approval.requestId, 'acceptForSession')).rejects.toThrow()
    await provider.answerApproval(approval.requestId, 'accept')
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'turn.completed')).toBe(true))
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow-this' })
    const items = (await provider.getTranscript(session.id))?.turns[0]?.items ?? []
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ role: 'user', text: 'hello', images: [expect.stringMatching(/\.png$/)] })
    expect(items[1]).toMatchObject({ role: 'assistant', text: 'works!' })
    expect(events.filter((e) => e.kind === 'delta')).toHaveLength(2)
    expect((await provider.getSession(session.id))?.status).toBe('idle')
  })

  it('steers and cancels the same turn and releases a pending prompt when ACP exits', async () => {
    let finish: ((result: PromptResponse) => void) | undefined
    let requests = 0
    agent.onRequest('session/new', () => ({ sessionId: 'working' }))
    agent.onRequest('session/prompt', () => {
      if (++requests === 2) return { stopReason: 'end_turn' }
      return new Promise<PromptResponse>((resolve) => {
        finish = resolve
      })
    })
    agent.onNotification('session/cancel', () => {
      finish?.({ stopReason: 'cancelled' })
    })
    const { id } = await provider.createSession({ cwd })
    await expect(provider.startTurn(id, [], { approvalPolicy: 'never' })).rejects.toThrow('按需确认')
    const { turnId } = await provider.startTurn(id, [{ type: 'text', text: 'start' }])
    await expect(provider.startTurn(id, [])).rejects.toThrow('正在运行')
    await provider.steer(id, turnId, [{ type: 'text', text: 'more' }])
    expect(events.filter((e) => e.kind === 'turn.started')).toHaveLength(1)
    await provider.interrupt(id, turnId)
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ kind: 'turn.completed', status: 'interrupted' })),
    )
    await provider.startTurn(id, [{ type: 'text', text: 'another' }])
    connection.close()
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ kind: 'turn.completed', status: 'failed' })),
    )
  })

  it('replays newer native history when a user continues in the terminal between phone visits', async () => {
    let revision = 1
    let loads = 0
    agent.onRequest('session/list', () => ({
      sessions: [{ sessionId: 'shared', cwd, title: 'Terminal', updatedAt: new Date(revision * 1000).toISOString() }],
    }))
    agent.onRequest('session/close', () => ({}))
    agent.onRequest('session/load', async ({ client }) => {
      loads++
      for (let i = 1; i <= revision; i++) {
        for (const role of ['user_message_chunk', 'agent_message_chunk'] as const)
          await client.notify('session/update', {
            sessionId: 'shared',
            update: { sessionUpdate: role, content: { type: 'text', text: String(i) } },
          })
      }
      return {}
    })
    expect((await provider.getTranscript('agy:shared'))?.turns).toHaveLength(1)
    await provider.renameSession('agy:shared', 'Phone alias')
    revision++
    expect((await provider.listSessions())[0]?.title).toBe('Phone alias')
    await provider.resumeSession('agy:shared')
    expect((await provider.getTranscript('agy:shared'))?.turns).toHaveLength(2)
    expect(loads).toBe(2)
    expect(events.some((e) => e.kind.startsWith('item.'))).toBe(false)
  })
})
