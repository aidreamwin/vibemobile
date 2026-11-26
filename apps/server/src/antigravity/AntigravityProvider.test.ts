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
import { acpModelId } from './modelGateway.js'
import { AgyTurnJournal } from './turnJournal.js'

let cwd: string
let agent: AgentApp
let nextAgent: () => AgentApp
let provider: AntigravityProvider
let connection: ClientConnection
let events: AgentEvent[]
let apiKey: string
let launchKeys: (string | undefined)[]
let baseUrl: string
let models: string[]
let launchUrls: (string | undefined)[]
let launchUnattended: boolean[]
let launchWorkerMode: boolean[]
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
function mockAgent(canDelete = false) {
  return new AgentApp().onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.16' },
    authMethods: [
      { id: 'gemini-api-key', name: 'Gemini API key' },
      { id: 'gateway', name: 'Gateway' },
    ],
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, close: {}, ...(canDelete ? { delete: {} } : {}) },
      promptCapabilities: { image: true },
    },
  }))
}
beforeEach(() => {
  apiKey = ''
  launchKeys = []
  baseUrl = ''
  models = []
  launchUrls = []
  launchUnattended = []
  launchWorkerMode = []
  cwd = mkdtempSync(path.join(os.tmpdir(), 'vibe-agy-acp-'))
  agent = mockAgent()
  nextAgent = () => agent
  provider = new AntigravityProvider({
    bin: 'agy',
    workspaceRoots: [cwd],
    stateDir: cwd,
    profile: () =>
      apiKey
        ? { apiKey, baseUrl, name: 'Gemini', id: 'gemini', updatedAt: 1, models, model: models[0] ?? '' }
        : undefined,
    connect: async (client, _cwd, _bin, key, url, _gateway, unattended, workerMode) => {
      launchKeys.push(key)
      launchUrls.push(url)
      launchUnattended.push(Boolean(unattended))
      launchWorkerMode.push(Boolean(workerMode))
      connection = client.connect(nextAgent())
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

describe('supplier catalogues larger than the ACP limit', () => {
  let prompts: { sessionId: string; model: string }[]
  let closed: string[]
  let failNextLoad: boolean
  let failNextClose: boolean
  beforeEach(() => {
    apiKey = 'test-key'
    models = Array.from({ length: 100 }, (_, i) => `supplier-${i}`)
    models[99] = 'gemini-4-neon-low'
    prompts = []
    closed = []
    failNextLoad = false
    failNextClose = false
    const history = new Map<string, string[]>()
    nextAgent = () => {
      let choices: { name: string; value: string }[] = []
      const selected = new Map<string, string>()
      const held = new Map<string, (response: PromptResponse) => void>()
      const controls = (id: string) => ({
        configOptions: [{ ...configOptions[0], options: choices, currentValue: selected.get(id) ?? choices[0].value }],
      })
      return mockAgent()
        .onRequest('authenticate', async ({ params }) => {
          const gateway = params._meta?.gateway as { baseUrl: string; headers: Record<string, string> }
          const response = await fetch(`${gateway.baseUrl}/v1beta/models`, { headers: gateway.headers })
          const catalog = (await response.json()) as { models: { name: string; displayName: string }[] }
          choices = catalog.models
            .slice(0, 32)
            .map((m) => ({ name: m.displayName, value: m.name.slice('models/'.length) }))
          expect(choices[0].name).toBe(models[0])
          return {}
        })
        .onRequest('session/new', () => {
          const id = String(history.size + 1)
          history.set(id, [])
          selected.set(id, choices[0].value)
          return { sessionId: id, ...controls(id) }
        })
        .onRequest('session/load', async ({ params: { sessionId }, client }) => {
          if (failNextLoad) {
            failNextLoad = false
            throw new RequestError(-32603, 'load failed')
          }
          for (const [index, text] of (history.get(sessionId) ?? []).entries())
            await client.notify('session/update', {
              sessionId,
              update: {
                sessionUpdate: 'user_message_chunk',
                messageId: `user-${index}`,
                content: { type: 'text', text },
              },
            })
          selected.set(sessionId, choices[0].value)
          return controls(sessionId)
        })
        .onRequest('session/close', ({ params: { sessionId } }) => {
          if (failNextClose) {
            failNextClose = false
            throw new RequestError(-32603, 'close failed')
          }
          selected.delete(sessionId)
          closed.push(sessionId)
          return {}
        })
        .onRequest('session/set_config_option', ({ params: { sessionId, value } }) => {
          expect(selected.has(sessionId)).toBe(true)
          expect(choices.some((m) => m.value === value)).toBe(true)
          selected.set(sessionId, String(value))
          return controls(sessionId)
        })
        .onRequest('session/prompt', ({ params: { sessionId, prompt } }) => {
          const model = choices.find((m) => m.value === selected.get(sessionId))
          if (!model || prompt[0]?.type !== 'text') throw new Error('wrong ACP session or prompt')
          const text = prompt[0].text
          history.get(sessionId)?.push(text)
          prompts.push({ sessionId, model: model.name })
          if (text === 'hold') return new Promise<PromptResponse>((resolve) => held.set(sessionId, resolve))
          return { stopReason: 'end_turn' }
        })
        .onNotification('session/cancel', ({ params: { sessionId } }) => {
          held.get(sessionId)?.({ stopReason: 'cancelled' })
        })
    }
  })

  it('selects entries 32, 33 and 100 and preserves the chat across a switch and restart', async () => {
    expect((await provider.listModels()).map((model) => model.id)).toEqual(models)
    expect(launchKeys).toHaveLength(0)
    const selections = [models[31], models[32], models[99], models[30]]
    const chats = await Promise.all(selections.map((model) => provider.createSession({ cwd, model })))
    const [a] = chats
    expect(chats.map((chat) => chat.model)).toEqual(selections)
    await Promise.all(chats.map((s) => provider.startTurn(s.id, [{ type: 'text', text: 'first' }])))
    await vi.waitFor(() => expect(provider.hasActiveTurn).toBe(false))
    expect(prompts).toHaveLength(chats.length)
    for (const chat of chats) expect(prompts).toContainEqual({ sessionId: chat.id.slice(4), model: chat.model })
    await provider.startTurn(a.id, [{ type: 'text', text: 'second' }], { model: 'gemini-4-neon', effort: 'low' })
    await vi.waitFor(() => expect(provider.hasActiveTurn).toBe(false))
    expect(launchKeys).toHaveLength(4)
    expect(closed).toEqual([a.id.slice(4)])
    expect(prompts.at(-1)).toEqual({ sessionId: a.id.slice(4), model: models[99] })
    expect((await provider.getTranscript(a.id))?.turns).toHaveLength(2)
    await provider.stop()
    expect((await provider.resumeSession(a.id))?.model).toBe(models[99])
    expect((await provider.getTranscript(a.id))?.turns).toHaveLength(2)
    expect(launchKeys).toHaveLength(5)
  })

  it('recovers the previous selection after a failed switch and isolates simultaneous turns on different workers', async () => {
    const a = await provider.createSession({ cwd, model: models[31] })
    const original = connection
    const b = await provider.createSession({ cwd, model: models[32] })
    failNextLoad = true
    await expect(provider.startTurn(a.id, [{ type: 'text', text: 'failed' }], { model: models[32] })).rejects.toThrow(
      'load failed',
    )
    expect(prompts).toEqual([])
    await provider.startTurn(a.id, [{ type: 'text', text: 'hold' }])
    const runningA = connection
    const { turnId } = await provider.startTurn(b.id, [{ type: 'text', text: 'hold' }])
    await vi.waitFor(() => {
      expect(prompts).toHaveLength(2)
      expect(prompts).toContainEqual({ sessionId: a.id.slice(4), model: models[31] })
      expect(prompts).toContainEqual({ sessionId: b.id.slice(4), model: models[32] })
    })
    runningA.close()
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'turn.completed', threadId: a.id, status: 'failed' }),
      ),
    )
    expect((await provider.getSession(b.id))?.status).toBe('working')
    expect(original.signal.aborted).toBe(false)
    await provider.interrupt(b.id, turnId)
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'turn.completed', threadId: b.id, status: 'interrupted' }),
      ),
    )
  })

  it('retains the original owner when a cross-catalogue handoff cannot close its worker', async () => {
    const session = await provider.createSession({ cwd, model: models[31] })
    const original = connection
    const launches = launchKeys.length
    failNextClose = true
    await expect(
      provider.startTurn(session.id, [{ type: 'text', text: 'switch' }], { model: models[32] }),
    ).rejects.toThrow('close failed')
    expect(launchKeys).toHaveLength(launches)
    expect(original.signal.aborted).toBe(false)
    expect(prompts).toEqual([])
    await provider.startTurn(session.id, [{ type: 'text', text: 'continue' }])
    await vi.waitFor(() => expect(provider.hasActiveTurn).toBe(false))
    expect(prompts).toEqual([{ sessionId: session.id.slice(4), model: models[31] }])
  })
})

describe('Antigravity ACP session lifecycle', () => {
  it('serializes interrupted-turn recovery before starting ordinary workers', async () => {
    apiKey = 'test-key'
    models = ['gemini-4-neon-high']
    const journal = new AgyTurnJournal(path.join(cwd, 'antigravity-active-turns.json'))
    journal.mark('agy:interrupted')
    const sequence: string[] = []
    const modelOptions = [
      {
        ...configOptions[0],
        currentValue: acpModelId(models[0]),
        options: [{ name: models[0], value: acpModelId(models[0]) }],
      },
    ]
    nextAgent = () => {
      const recovery = !launchWorkerMode.at(-1)
      sequence.push(recovery ? 'recover' : 'worker')
      return mockAgent()
        .onRequest('authenticate', async ({ params }) => {
          if (recovery) {
            const gateway = params._meta?.gateway as { baseUrl: string; headers: Record<string, string> }
            const reply = await fetch(
              `${gateway.baseUrl}/v1beta/models/${acpModelId(models[0])}:streamGenerateContent`,
              {
                method: 'POST',
                headers: gateway.headers,
                body: '{}',
              },
            )
            expect(reply.status).toBe(400)
          }
          return {}
        })
        .onRequest('session/list', () => ({ sessions: [{ sessionId: 'interrupted', cwd }] }))
        .onRequest('session/load', () => ({ configOptions: modelOptions }))
        .onNotification('session/cancel', () => {
          sequence.push('cancel')
        })
        .onRequest('session/close', () => {
          sequence.push('close')
          return {}
        })
        .onRequest('session/prompt', () => {
          sequence.push('prompt')
          return { stopReason: 'end_turn' }
        })
    }
    await Promise.all([provider.resumeSession('agy:interrupted'), provider.getTranscript('agy:interrupted')])
    expect(launchWorkerMode).toEqual([false, true, true])
    expect(sequence.slice(0, 4)).toEqual(['recover', 'cancel', 'close', 'worker'])
    expect(new AgyTurnJournal(path.join(cwd, 'antigravity-active-turns.json')).pending()).toEqual([])
    expect(sequence).not.toContain('prompt')
    await provider.startTurn('agy:interrupted', [{ type: 'text', text: 'continue' }])
    await vi.waitFor(() => expect(provider.hasActiveTurn).toBe(false))
    expect(sequence.at(-1)).toBe('prompt')
  })

  it('records active prompts and clears their recovery entry after an orderly stop', async () => {
    let complete: ((result: PromptResponse) => void) | undefined
    agent.onRequest('session/new', () => ({ sessionId: 'active' }))
    agent.onRequest(
      'session/prompt',
      () =>
        new Promise<PromptResponse>((resolve) => {
          complete = resolve
        }),
    )
    const close = vi.fn(() => ({}))
    agent.onRequest('session/close', close)
    agent.onNotification('session/cancel', () => complete?.({ stopReason: 'cancelled' }))
    const session = await provider.createSession({ cwd })
    await provider.startTurn(session.id, [{ type: 'text', text: 'work' }])
    await vi.waitFor(() => expect(complete).toBeDefined())
    const journal = path.join(cwd, 'antigravity-active-turns.json')
    expect(new AgyTurnJournal(journal).pending()).toEqual([session.id])
    await provider.stop()
    expect(close).toHaveBeenCalledTimes(1)
    expect(new AgyTurnJournal(journal).pending()).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ kind: 'turn.completed', status: 'interrupted' }))
  })

  it('discovers native permission modes and applies them across model and permission changes', async () => {
    const choices = ['default', 'accept-edits', 'plan', 'auto']
    const modesFor = (currentModeId: string) => ({
      modes: { currentModeId, availableModes: choices.map((id) => ({ id, name: id })) },
      configOptions: [
        ...configOptions,
        {
          id: 'mode',
          category: 'mode',
          type: 'select' as const,
          name: 'Mode',
          currentValue: currentModeId,
          options: choices.map((value) => ({ value, name: value })),
        },
      ] satisfies SessionConfigOption[],
    })
    const runs: { id: string; mode: string; unattended: boolean }[] = []
    let count = 0
    nextAgent = () => {
      const unattended = launchUnattended.at(-1) ?? false
      const selected = new Map<string, string>()
      return mockAgent()
        .onRequest('session/list', () => ({ sessions: [] }))
        .onRequest('session/new', () => {
          const id = `mode-${++count}`
          selected.set(id, 'default')
          return { sessionId: id, ...modesFor('default') }
        })
        .onRequest('session/close', ({ params }) => {
          selected.delete(params.sessionId)
          return {}
        })
        .onRequest('session/load', ({ params }) => {
          selected.set(params.sessionId, 'default')
          return modesFor('default')
        })
        .onRequest('session/set_config_option', ({ params }) => {
          expect(params.configId).toBe('mode')
          selected.set(params.sessionId, String(params.value))
          return modesFor(String(params.value))
        })
        .onRequest('session/prompt', ({ params }) => {
          runs.push({ id: params.sessionId, mode: selected.get(params.sessionId) ?? '', unattended })
          return { stopReason: 'end_turn' }
        })
    }
    expect((await provider.probe()).permissionModes).toEqual(['on-request', 'accept-edits', 'plan', 'auto', 'never'])
    const session = await provider.createSession({ cwd, approvalPolicy: 'plan' })
    expect(session.approvalPolicy).toBe('plan')
    const other = await provider.createSession({ cwd })
    const send = async (id: string, approvalPolicy: 'on-request' | 'accept-edits' | 'plan' | 'auto' | 'never') => {
      await provider.startTurn(id, [{ type: 'text', text: 'test mode' }], {
        approvalPolicy,
        sandbox: approvalPolicy === 'never' ? 'danger-full-access' : 'workspace-write',
      })
      await vi.waitFor(() => expect(provider.hasActiveTurn).toBe(false))
    }
    await send(session.id, 'plan')
    await send(session.id, 'accept-edits')
    await send(session.id, 'auto')
    await send(session.id, 'never')
    await send(other.id, 'on-request')
    expect(runs.at(-1)).toEqual({ id: other.id.slice(4), mode: 'default', unattended: false })
    await provider.stop()
    expect((await provider.resumeSession(session.id))?.approvalPolicy).toBe('never')
    await send(session.id, 'never')
    await send(session.id, 'on-request')
    expect(
      runs.filter((run) => run.id === session.id.slice(4)).map(({ mode, unattended }) => [mode, unattended]),
    ).toEqual([
      ['plan', false],
      ['accept-edits', false],
      ['auto', false],
      ['default', true],
      ['default', true],
      ['default', false],
    ])
    expect((await provider.getSession(session.id))?.approvalPolicy).toBe('on-request')
    expect(launchUnattended).toEqual([false, true, false, true, false])
  })

  it('applies supplier defaults, accepts the old model/effort pair, and restores the selected full ID', async () => {
    apiKey = 'supplier-key'
    models = ['gateway-custom', 'gemini-4-neon-low']
    let ignoreSelection = false
    const prompt = vi.fn(() => ({ stopReason: 'end_turn' as const }))
    const responses = (selected: string) => ({
      configOptions: [
        {
          ...configOptions[0],
          currentValue: selected,
          options: models.map((id) => ({ value: acpModelId(id), name: id })),
        },
      ],
    })
    agent.onRequest('authenticate', ({ params }) => {
      expect(params.methodId).toBe('gateway')
      expect(JSON.stringify(params)).not.toContain(apiKey)
      return {}
    })
    agent.onRequest('session/new', () => ({ sessionId: 'managed', ...responses(acpModelId(models[1])) }))
    agent.onRequest('session/set_config_option', ({ params }) =>
      responses(ignoreSelection ? acpModelId(models[1]) : String(params.value)),
    )
    agent.onRequest('session/load', () => responses(acpModelId(models[1]).slice('gemini-'.length)))
    agent.onRequest('session/prompt', prompt)
    expect((await provider.listModels()).map((m) => m.id)).toEqual(models)
    const s = await provider.createSession({ cwd })
    expect(s.model).toBe(models[0])
    await provider.startTurn(s.id, [{ type: 'text', text: 'test' }], { model: 'gemini-4-neon', effort: 'low' })
    await vi.waitFor(() => expect(provider.hasActiveTurn).toBe(false))
    expect((await provider.getSession(s.id))?.model).toBe(models[1])
    await provider.stop()
    expect((await provider.resumeSession(s.id))?.model).toBe(models[1])
    await provider.startTurn(s.id, [{ type: 'image', url: 'data:image/png;base64,AQID' }])
    await vi.waitFor(() => expect(provider.hasActiveTurn).toBe(false))
    await expect(provider.createSession({ cwd, model: 'unconfigured' })).rejects.toMatchObject({ statusCode: 400 })
    ignoreSelection = true
    await expect(
      provider.startTurn(s.id, [{ type: 'text', text: 'verify selection' }], { model: models[0] }),
    ).rejects.toMatchObject({ statusCode: 502 })
    expect(prompt).toHaveBeenCalledTimes(2)
  })

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
    baseUrl = 'https://gemini.example.test'
    const session = await provider.createSession({ cwd })
    await provider.stop()
    apiKey = 'next-key'
    baseUrl = 'https://other.example.test'
    await expect(provider.resumeSession(session.id)).resolves.toMatchObject({ id: session.id })
    await expect(provider.probe()).resolves.toMatchObject({ authenticated: true })
    await provider.stop()
    apiKey = ''
    baseUrl = ''
    await expect(provider.probe()).resolves.toMatchObject({ available: true, authenticated: false })
    expect(launchKeys).toEqual(['first-key', 'next-key', 'next-key', undefined])
    expect(launchUrls).toEqual([
      'https://gemini.example.test',
      'https://other.example.test',
      'https://other.example.test',
      undefined,
    ])
    expect(methods).toEqual(['gemini-api-key', 'gemini-api-key', 'gemini-api-key'])
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
    await expect(provider.startTurn(id, [], { approvalPolicy: 'never' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(provider.startTurn(id, [], { approvalPolicy: 'auto' })).rejects.toMatchObject({ statusCode: 400 })
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

  it('reopens only a changed native revision without interrupting another active session', async () => {
    const saved = [{ user: 'old question', assistant: 'old answer' }]
    const now = vi.spyOn(Date, 'now')
    let clock = 10_000
    let revision = 1_000
    now.mockImplementation(() => clock)
    let loads = 0
    let finishOther: ((result: PromptResponse) => void) | undefined
    nextAgent = () => {
      const snapshot = saved.map((turn) => ({ ...turn }))
      return mockAgent()
        .onRequest('session/list', () => ({
          sessions: [{ sessionId: 'shared', cwd, updatedAt: new Date(revision).toISOString() }],
        }))
        .onRequest('session/new', () => ({ sessionId: 'other' }))
        .onRequest('session/close', () => ({}))
        .onRequest('session/load', async ({ params, client }) => {
          loads++
          for (const turn of snapshot) {
            for (const [sessionUpdate, text] of [
              ['user_message_chunk', turn.user],
              ['agent_message_chunk', turn.assistant],
            ] as const)
              await client.notify('session/update', {
                sessionId: params.sessionId,
                update: { sessionUpdate, content: { type: 'text', text } },
              })
          }
          return {}
        })
        .onRequest('session/prompt', () => new Promise<PromptResponse>((resolve) => (finishOther = resolve)))
    }
    try {
      const other = await provider.createSession({ cwd })
      const sharedConnection = connection
      const initial = await provider.getTranscript('agy:shared')
      const oldConnection = connection
      expect(initial?.turns).toHaveLength(1)
      expect(initial?.turns[0]?.items.at(-1)).toMatchObject({ text: 'old answer' })
      await provider.startTurn(other.id, [{ type: 'text', text: 'keep working' }])
      await vi.waitFor(() => expect(finishOther).toBeDefined())

      clock += 6_000
      await provider.refreshSession('agy:shared')
      await provider.resumeSession('agy:shared')
      expect(loads).toBe(1)
      expect(connection).toBe(oldConnection)
      expect(oldConnection.signal.aborted).toBe(false)

      saved.push({ user: 'new question', assistant: 'new answer' })
      revision += 1_000
      clock += 500
      await provider.refreshSession('agy:shared')
      const latest = await provider.getTranscript('agy:shared')
      expect(latest?.turns).toHaveLength(2)
      expect(latest?.turns.at(-1)?.items.at(-1)).toMatchObject({ text: 'new answer' })
      expect(loads).toBe(2)
      await vi.waitFor(() => expect(oldConnection.signal.aborted).toBe(true))
      expect(sharedConnection.signal.aborted).toBe(false)
      expect((await provider.getSession(other.id))?.status).toBe('working')

      saved.push({ user: 'third question', assistant: 'third answer' })
      revision += 1_000
      clock += 6_000
      await provider.resumeSession('agy:shared')
      expect((await provider.getTranscript('agy:shared'))?.turns.at(-1)?.items.at(-1)).toMatchObject({
        text: 'third answer',
      })
      expect(loads).toBe(3)
      finishOther?.({ stopReason: 'end_turn' })
      await vi.waitFor(() => expect(provider.hasActiveTurn).toBe(false))
    } finally {
      now.mockRestore()
    }
  })

  it('keeps the old transcript owner until a stale worker acknowledges close', async () => {
    let revision = 1_000
    let failClose = true
    const load = vi.fn(() => ({}))
    nextAgent = () =>
      mockAgent()
        .onRequest('session/list', () => ({
          sessions: [{ sessionId: 'shared', cwd, updatedAt: new Date(revision).toISOString() }],
        }))
        .onRequest('session/load', load)
        .onRequest('session/close', () => {
          if (failClose) {
            failClose = false
            throw new RequestError(-32603, 'close failed')
          }
          return {}
        })
    await provider.getTranscript('agy:shared')
    const oldConnection = connection
    const launches = launchKeys.length
    revision += 1_000
    await expect(provider.refreshSession('agy:shared')).rejects.toThrow('close failed')
    expect(launchKeys).toHaveLength(launches)
    expect(oldConnection.signal.aborted).toBe(false)
    await provider.refreshSession('agy:shared')
    expect(oldConnection.signal.aborted).toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps a newly created empty session on its original process until it is persisted', async () => {
    const now = vi.spyOn(Date, 'now')
    let clock = 10_000
    now.mockImplementation(() => clock)
    const load = vi.fn(() => {
      throw new RequestError(-32002, 'not persisted')
    })
    agent.onRequest('session/new', () => ({ sessionId: 'empty' }))
    agent.onRequest('session/load', load)
    try {
      const session = await provider.createSession({ cwd })
      const original = connection
      clock += 6_000
      await expect(provider.refreshSession(session.id)).resolves.toMatchObject({ id: session.id })
      expect(connection).toBe(original)
      expect(load).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })

  it('closes isolated ACP processes when sessions are pruned or deleted', async () => {
    nextAgent = () =>
      mockAgent(true)
        .onRequest('session/list', () => ({
          sessions: Array.from({ length: 7 }, (_, i) => ({ sessionId: String(i), cwd })),
        }))
        .onRequest('session/load', () => ({}))
        .onRequest('session/close', () => ({}))
        .onRequest('session/delete', () => ({}))
    let oldest: ClientConnection | undefined
    for (let i = 0; i < 7; i++) {
      await provider.getTranscript(`agy:${i}`)
      if (i === 0) oldest = connection
    }
    await vi.waitFor(() => expect(oldest?.signal.aborted).toBe(true))
    const deleted = connection
    await provider.deleteSession('agy:6')
    await vi.waitFor(() => expect(deleted.signal.aborted).toBe(true))
  })
})
