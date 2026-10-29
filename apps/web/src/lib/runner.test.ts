import { afterEach, describe, expect, it, vi } from 'vitest'
import { scopeFromPath } from './runner'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('runner routing', () => {
  it('accepts scoped bookmarks and rejects malformed identities', () => {
    expect(scopeFromPath('/r/windows-dev/chat/same-id')).toBe('windows-dev')
    expect(scopeFromPath('/r/linux_2')).toBe('linux_2')
    for (const value of ['/chat/id', '/r/', '/r/../files', '/r/a%2Fb/', '/runner/a'])
      expect(scopeFromPath(value)).toBe('')
  })

  it('scopes APIs, image URLs and persistent preferences to the current runner', async () => {
    vi.stubGlobal('location', { pathname: '/r/runner-b/chat/same-id' })
    vi.resetModules()
    const scope = await import('./runner')
    const { api, imageUrl } = await import('./api')
    const fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }),
      )
    vi.stubGlobal('fetch', fetch)
    await api.sessions()
    expect(fetch.mock.calls[0][0]).toBe('/r/runner-b/api/sessions')
    await api.runners()
    expect(fetch.mock.calls[1][0]).toBe('/api/runners')
    await api.login('test')
    expect(fetch.mock.calls[2][0]).toBe('/api/auth/login')
    expect(imageUrl('hash.png')).toBe('/r/runner-b/api/images/hash.png')
    expect(scope.runnerPath('/ws/terminal')).toBe('/r/runner-b/ws/terminal')
    expect(scope.runnerStorageKey('vibemobile.terminalId')).toBe('vibemobile.terminalId.runner-b')
  })

  it('keeps auth and runner management calls at the Hub level, not under /r/<id>', async () => {
    vi.stubGlobal('location', { pathname: '/r/runner-b/settings', search: '', hash: '' })
    vi.resetModules()
    const { api } = await import('./api')
    const fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }),
      )
    vi.stubGlobal('fetch', fetch)

    await api.createRunner('机器B')
    await api.refreshRunnerToken('runner-abc')
    await api.deleteRunner('runner-abc')
    await api.logoutAll()

    expect(fetch.mock.calls[0][0]).toBe('/api/runners')
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ name: '机器B' }) })
    expect(fetch.mock.calls[1][0]).toBe('/api/runners/runner-abc/token')
    expect(fetch.mock.calls[2][0]).toBe('/api/runners/runner-abc')
    expect(fetch.mock.calls[3][0]).toBe('/api/auth/logout-all')
  })

  it('keeps the current page, query and hash when switching runners', async () => {
    vi.stubGlobal('location', { pathname: '/r/runner-b/settings', search: '?tab=1', hash: '#log' })
    vi.resetModules()
    const scope = await import('./runner')
    expect(scope.pathAfterScope('/r/runner-b/chat/abc', '?q=1', '#m')).toBe('/chat/abc?q=1#m')
    expect(scope.pathAfterScope('/r/runner-b')).toBe('/')
    expect(scope.pathAfterScope('/settings')).toBe('/settings')
    expect(scope.runnerSwitchUrl('runner-c')).toBe('/r/runner-c/settings?tab=1#log')
  })

  it('reads the path at switch time, not at module load', async () => {
    vi.stubGlobal('location', { pathname: '/r/runner-b/', search: '', hash: '' })
    vi.resetModules()
    const scope = await import('./runner')
    // React Router changes the URL with pushState and never reloads this module.
    vi.stubGlobal('location', { pathname: '/r/runner-b/files', search: '', hash: '' })
    expect(scope.runnerSwitchUrl('runner-c')).toBe('/r/runner-c/files')
  })

  it('preserves original paths and storage keys in standalone mode', async () => {
    vi.stubGlobal('location', { pathname: '/files' })
    vi.resetModules()
    const scope = await import('./runner')
    expect(scope.runnerBase).toBe('')
    expect(scope.runnerPath('/api/files')).toBe('/api/files')
    expect(scope.runnerStorageKey('vibemobile.defaultCwd')).toBe('vibemobile.defaultCwd')
  })
})
