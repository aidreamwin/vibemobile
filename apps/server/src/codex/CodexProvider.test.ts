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
})
