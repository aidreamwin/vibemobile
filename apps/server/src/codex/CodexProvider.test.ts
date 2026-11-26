import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppServerClient } from './AppServerClient.js'
import { CodexProvider } from './CodexProvider.js'
import { SessionNotFoundError, SessionProviderMismatchError } from '../providers/types.js'
import { AppServerSupervisor } from './supervisor.js'

describe('CodexProvider session listing', () => {
  beforeEach(() => {
    vi.spyOn(AppServerSupervisor.prototype, 'modelProvider', 'get').mockReturnValue('OpenAI')
  })
  afterEach(() => vi.restoreAllMocks())

  it('lists sessions from every model provider after a profile switch', async () => {
    const request = vi.spyOn(AppServerClient.prototype, 'request').mockResolvedValue({ data: [] })
    const provider = new CodexProvider({ workspaceRoots: [] })

    await provider.listSessions()

    expect(request).toHaveBeenCalledWith(
      'thread/list',
      expect.objectContaining({
        // An empty list is Codex app-server's explicit "all providers" value.
        modelProviders: [],
      }),
    )
    await provider.stop()
  })

  it('discovers loaded global skills through the existing connection without starting another process', async () => {
    vi.spyOn(AppServerClient.prototype, 'isReady', 'get').mockReturnValue(true)
    const skill = { path: 'C:/user/.codex/skills/demo/SKILL.md', name: 'demo', scope: 'user' }
    const request = vi.spyOn(AppServerClient.prototype, 'request').mockResolvedValue({ data: [{ skills: [skill] }] })
    const start = vi.spyOn(AppServerSupervisor.prototype, 'start')
    const provider = new CodexProvider({ workspaceRoots: ['C:/workspace'] })
    await expect(provider.listGlobalSkills()).resolves.toEqual([skill])
    expect(request).toHaveBeenCalledWith('skills/list', { cwds: ['C:/workspace'], forceReload: true })
    expect(start).not.toHaveBeenCalled()
    await provider.stop()
  })

  it('keeps document browsing independent of an offline Codex process', async () => {
    const start = vi.spyOn(AppServerSupervisor.prototype, 'start')
    const request = vi.spyOn(AppServerClient.prototype, 'request')
    const provider = new CodexProvider({ workspaceRoots: [] })
    await expect(provider.listGlobalSkills()).rejects.toThrow('offline')
    expect(start).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    await provider.stop()
  })

  it('limits the model picker to the active profile models', async () => {
    vi.spyOn(AppServerClient.prototype, 'request').mockResolvedValue({
      data: [
        { id: 'first-a', name: 'First A' },
        { id: 'first-b', name: 'First B' },
        { id: 'second-a', name: 'Second A' },
      ],
    })
    const provider = new CodexProvider({
      workspaceRoots: [],
      connection: () => ({
        id: 'profile-0123456789abcdef',
        name: 'First',
        baseUrl: 'https://first.example.test/v1',
        apiKey: 'secret',
        model: 'first-a',
        models: ['first-a', 'first-b'],
        updatedAt: 1,
      }),
    })

    await expect(provider.listModels()).resolves.toEqual([
      { id: 'first-a', displayName: 'First A', efforts: undefined, defaultEffort: undefined },
      { id: 'first-b', displayName: 'First B', efforts: undefined, defaultEffort: undefined },
    ])
    await provider.stop()
  })

  it('resumes an existing thread with the active profile provider', async () => {
    const request = vi.spyOn(AppServerClient.prototype, 'request').mockResolvedValue({
      thread: { id: 'thread-1', name: 'Existing', status: 'idle', model: 'gpt-4o' },
      cwd: 'C:/workspace',
    })
    const provider = new CodexProvider({
      workspaceRoots: [],
      connection: () => ({
        id: 'profile-0123456789abcdef',
        name: 'Custom gateway',
        baseUrl: 'https://gateway.example.test/v1',
        apiKey: 'secret',
        model: 'compatible-model',
        models: ['compatible-model'],
        updatedAt: 1,
      }),
    })

    await provider.resumeSession('thread-1')

    expect(request).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({
        threadId: 'thread-1',
        modelProvider: 'OpenAI',
      }),
    )
    await provider.stop()
  })

  it('uses Codex native provider casing when no profile is active', async () => {
    const request = vi.spyOn(AppServerClient.prototype, 'request').mockResolvedValue({
      thread: { id: 'thread-1', name: 'Existing', status: 'idle', model: 'gpt-6.1-sol' },
      cwd: 'C:/workspace',
    })
    const provider = new CodexProvider({ workspaceRoots: [], connection: () => undefined })

    await provider.resumeSession('thread-1')

    expect(request).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({ threadId: 'thread-1', modelProvider: 'OpenAI' }),
    )
    await provider.stop()
  })

  it('opens a saved thread when the active profile cannot resume its old model', async () => {
    const request = vi
      .spyOn(AppServerClient.prototype, 'request')
      .mockRejectedValueOnce(new Error('model provider mismatch: model is not configured'))
      .mockResolvedValueOnce({
        thread: { id: 'thread-1', name: 'Existing', status: 'idle', model: 'old-model' },
        cwd: 'C:/workspace',
      })
    const provider = new CodexProvider({
      workspaceRoots: [],
      connection: () => ({
        id: 'profile-0123456789abcdef',
        name: 'New gateway',
        baseUrl: 'https://new.example.test/v1',
        apiKey: 'secret',
        model: 'new-model',
        models: ['new-model'],
        updatedAt: 1,
      }),
    })

    await expect(provider.resumeSession('thread-1')).resolves.toMatchObject({
      id: 'thread-1',
      model: 'old-model',
    })
    expect(request).toHaveBeenNthCalledWith(2, 'thread/read', { threadId: 'thread-1', includeTurns: false })
    await provider.stop()
  })

  it('recovers metadata from the unfiltered durable list when the thread is unloaded', async () => {
    const request = vi
      .spyOn(AppServerClient.prototype, 'request')
      .mockRejectedValueOnce(new Error('thread not loaded: thread-1'))
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ id: 'thread-1', name: 'Saved', status: 'idle', model: 'old-model', cwd: 'C:/workspace' }],
      })

    const provider = new CodexProvider({ workspaceRoots: [] })

    await expect(provider.getSession('thread-1')).resolves.toMatchObject({
      id: 'thread-1',
      title: 'Saved',
      model: 'old-model',
      archived: true,
    })
    expect(request).toHaveBeenNthCalledWith(
      2,
      'thread/list',
      expect.objectContaining({ modelProviders: [], archived: false }),
    )
    expect(request).toHaveBeenNthCalledWith(
      3,
      'thread/list',
      expect.objectContaining({ modelProviders: [], archived: true }),
    )
    await provider.stop()
  })

  it('resumes a durable thread before its first turn after an app-server restart', async () => {
    const request = vi
      .spyOn(AppServerClient.prototype, 'request')
      .mockRejectedValueOnce(new Error('thread not loaded: thread-1'))
      .mockResolvedValueOnce({
        data: [{ id: 'thread-1', name: 'Saved', status: 'idle', model: 'old-model', cwd: 'C:/workspace' }],
      })
      .mockResolvedValueOnce({
        thread: { id: 'thread-1', name: 'Saved', status: 'idle', model: 'old-model' },
        cwd: 'C:/workspace',
      })
      .mockResolvedValueOnce({ turn: { id: 'turn-1' } })

    const provider = new CodexProvider({ workspaceRoots: [] })

    // This is what registry.forSession does before routing the websocket turn.
    await expect(provider.getSession('thread-1')).resolves.toMatchObject({ id: 'thread-1' })
    await expect(provider.startTurn('thread-1', [{ type: 'text', text: 'continue' }])).resolves.toEqual({
      turnId: 'turn-1',
    })
    expect(request).toHaveBeenNthCalledWith(3, 'thread/resume', expect.objectContaining({ threadId: 'thread-1' }))
    expect(request).toHaveBeenNthCalledWith(4, 'turn/start', expect.objectContaining({ threadId: 'thread-1' }))
    await provider.stop()
  })

  it('preserves the resume failure when only durable metadata can be recovered', async () => {
    const request = vi
      .spyOn(AppServerClient.prototype, 'request')
      .mockRejectedValueOnce(new Error('no rollout found for thread id thread-1'))
      .mockRejectedValueOnce(new Error('thread not loaded: thread-1'))
      .mockResolvedValueOnce({
        data: [{ id: 'thread-1', name: 'Saved', status: 'idle', model: 'old-model', cwd: 'C:/workspace' }],
      })

    const provider = new CodexProvider({ workspaceRoots: [] })

    await expect(provider.startTurn('thread-1', [{ type: 'text', text: 'continue' }])).rejects.toThrow(
      'no rollout found',
    )
    expect(request).not.toHaveBeenCalledWith('turn/start', expect.anything())
    await provider.stop()
  })

  it('recognizes the newer thread-not-found wording', async () => {
    const request = vi
      .spyOn(AppServerClient.prototype, 'request')
      .mockRejectedValueOnce(new Error('thread not found: thread-1'))
    const provider = new CodexProvider({ workspaceRoots: [] })

    await expect(provider.deleteSession('thread-1')).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(request).toHaveBeenCalledWith('thread/delete', { threadId: 'thread-1' })
    await provider.stop()
  })

  it('resumes a thread whose metadata is readable but whose status is notLoaded', async () => {
    const thread = { id: 'thread-1', name: 'Saved', status: { type: 'notLoaded' }, cwd: 'C:/workspace' }
    const request = vi
      .spyOn(AppServerClient.prototype, 'request')
      .mockResolvedValueOnce({ thread })
      .mockResolvedValueOnce({ thread: { ...thread, status: { type: 'idle' } } })
      .mockResolvedValueOnce({ turn: { id: 'turn-1' } })
    const provider = new CodexProvider({ workspaceRoots: [] })

    await provider.getSession('thread-1')
    await expect(provider.startTurn('thread-1', [{ type: 'text', text: 'continue' }])).resolves.toEqual({
      turnId: 'turn-1',
    })
    expect(request).toHaveBeenNthCalledWith(2, 'thread/resume', expect.objectContaining({ threadId: 'thread-1' }))
    expect(request).toHaveBeenNthCalledWith(3, 'turn/start', expect.objectContaining({ threadId: 'thread-1' }))
    await provider.stop()
  })

  it('keeps history readable but reports a provider mismatch before sending to an unloaded thread', async () => {
    const mismatch = new Error(
      'This chat uses OpenAI, but your current provider is custom. Switch to OpenAI to continue.',
    )
    const saved = { thread: { id: 'thread-1', name: 'Saved', status: { type: 'notLoaded' } } }
    const request = vi
      .spyOn(AppServerClient.prototype, 'request')
      .mockRejectedValueOnce(mismatch)
      .mockResolvedValueOnce(saved)
      .mockRejectedValueOnce(mismatch)
    const provider = new CodexProvider({ workspaceRoots: [] })

    await expect(provider.resumeSession('thread-1')).rejects.toBeInstanceOf(SessionProviderMismatchError)
    await expect(provider.getSession('thread-1')).resolves.toMatchObject({ id: 'thread-1' })
    await expect(provider.startTurn('thread-1', [{ type: 'text', text: 'continue' }])).rejects.toMatchObject({
      code: 'session_provider_mismatch',
      sessionId: 'thread-1',
    })
    expect(request).not.toHaveBeenCalledWith('turn/start', expect.anything())
    await provider.stop()
  })

  it('reports a removed provider as copyable without mistaking model or policy errors for a key mismatch', async () => {
    const request = vi.spyOn(AppServerClient.prototype, 'request')
    const provider = new CodexProvider({ workspaceRoots: [] })
    request.mockRejectedValueOnce(
      new Error(
        'This chat uses model provider “old”, which is no longer configured. Restore this provider’s configuration to continue.',
      ),
    )
    await expect(provider.resumeSession('thread-1')).rejects.toBeInstanceOf(SessionProviderMismatchError)
    expect(request).toHaveBeenCalledTimes(1)

    const policyError = new Error('Your organization does not allow this model provider.')
    request.mockRejectedValueOnce(policyError).mockResolvedValueOnce({ thread: null })
    await expect(provider.resumeSession('thread-1')).rejects.toBe(policyError)
    await provider.stop()
  })

  it('copies history to a new id with the current provider and profile model, then sends only to the copy', async () => {
    const request = vi
      .spyOn(AppServerClient.prototype, 'request')
      .mockResolvedValueOnce({
        thread: { id: 'copy-1', name: 'Saved', status: { type: 'idle' }, model: 'old-model' },
        model: 'new-model',
        cwd: 'C:/workspace',
      })
      .mockResolvedValueOnce({ turn: { id: 'turn-copy' } })
    const provider = new CodexProvider({
      workspaceRoots: [],
      connection: () => ({
        id: 'profile-0123456789abcdef',
        name: 'Current',
        baseUrl: 'https://gateway.example.test/v1',
        apiKey: 'secret',
        model: 'new-model',
        models: ['new-model'],
        updatedAt: 1,
      }),
    })
    await expect(provider.forkSession('source-1')).resolves.toMatchObject({ id: 'copy-1', model: 'new-model' })
    expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', {
      threadId: 'source-1',
      modelProvider: 'OpenAI',
      model: 'new-model',
      excludeTurns: true,
      deferGoalContinuation: true,
    })
    await expect(provider.startTurn('copy-1', [{ type: 'text', text: 'continue' }])).resolves.toEqual({
      turnId: 'turn-copy',
    })
    expect(request).toHaveBeenNthCalledWith(2, 'turn/start', expect.objectContaining({ threadId: 'copy-1' }))
    expect(request).not.toHaveBeenCalledWith('thread/resume', expect.anything())
    await provider.stop()
  })

  it('lets an external app-server select the copy provider and model', async () => {
    const request = vi.spyOn(AppServerClient.prototype, 'request').mockResolvedValue({
      thread: { id: 'copy-1', status: { type: 'idle' } },
    })
    const provider = new CodexProvider({ workspaceRoots: [], attachUrl: 'ws://127.0.0.1:8788' })
    await provider.forkSession('source-1')
    expect(request).toHaveBeenCalledWith('thread/fork', {
      threadId: 'source-1',
      excludeTurns: true,
      deferGoalContinuation: true,
    })
    await provider.stop()
  })

  it('loads a compatible model before starting a turn after a profile switch', async () => {
    const request = vi
      .spyOn(AppServerClient.prototype, 'request')
      .mockResolvedValueOnce({
        thread: { id: 'thread-1', name: 'Saved', status: 'idle', model: 'new-model' },
        cwd: 'C:/workspace',
      })
      .mockResolvedValueOnce({ turn: { id: 'turn-1' } })
    const provider = new CodexProvider({
      workspaceRoots: [],
      connection: () => ({
        id: 'profile-0123456789abcdef',
        name: 'New gateway',
        baseUrl: 'https://new.example.test/v1',
        apiKey: 'secret',
        model: 'new-model',
        models: ['new-model'],
        updatedAt: 1,
      }),
    })

    await expect(
      provider.startTurn('thread-1', [{ type: 'text', text: 'continue' }], { model: 'new-model' }),
    ).resolves.toEqual({
      turnId: 'turn-1',
    })
    expect(request).toHaveBeenNthCalledWith(
      1,
      'thread/resume',
      expect.objectContaining({ threadId: 'thread-1', modelProvider: 'OpenAI', model: 'new-model' }),
    )
    expect(request).toHaveBeenNthCalledWith(2, 'turn/start', expect.objectContaining({ threadId: 'thread-1' }))
    await provider.stop()
  })
})

it('logs model metadata fallback warnings without reporting a failed turn', async () => {
  const clientEvents = vi.spyOn(AppServerClient.prototype, 'on')
  const notice = vi.fn()
  const provider = new CodexProvider({ workspaceRoots: [], onNotice: notice })
  try {
    const client = clientEvents.mock.contexts[0] as AppServerClient
    const listener = vi.fn()
    const threadId = 'thread-1'
    const turnId = 'turn-1'
    const message =
      'Model metadata for `gpt-6.2-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'
    provider.subscribe(listener)

    client.emit('notification', 'warning', { threadId, message })
    expect(notice).toHaveBeenCalledWith(`Codex: ${message}`)
    expect(listener).not.toHaveBeenCalled()

    client.emit('notification', 'error', { threadId, turnId, error: { message: '503 unavailable' }, willRetry: false })
    expect(listener).toHaveBeenCalledWith({
      kind: 'error',
      threadId,
      turnId,
      message: '503 unavailable',
      willRetry: false,
    })
  } finally {
    clientEvents.mockRestore()
    await provider.stop()
  }
})
