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
})
