import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppServerClient } from './AppServerClient.js'
import { CodexProvider } from './CodexProvider.js'

describe('CodexProvider session listing', () => {
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
        modelProvider: 'custom',
      }),
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
      expect.objectContaining({ threadId: 'thread-1', modelProvider: 'custom', model: 'new-model' }),
    )
    expect(request).toHaveBeenNthCalledWith(2, 'turn/start', expect.objectContaining({ threadId: 'thread-1' }))
    await provider.stop()
  })
})
