import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../config.js'
import { FeedError, UpdateFeed } from './feed.js'

function config(overrides: Partial<Config['update']> = {}): Config {
  return {
    update: {
      enabled: true,
      apiUrl: 'https://gitlab.example/api/v4',
      projectId: 'dyb%2Fvibemobile',
      packageName: 'vibemobile',
      token: 'secret-token',
      allowHttp: false,
      ttlMs: 0,
      downloadTimeoutMs: 1000,
      ...overrides,
    },
  } as unknown as Config
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    serverVersion: '0.1.32',
    webVersion: '0.1.58',
    commit: 'abc123',
    dirty: false,
    artifacts: {
      hub: {
        file: 'vibemobile-hub.tar.gz',
        sha256: 'a'.repeat(64),
        bytes: 1234,
        contents: 'hub',
      },
      runner: {
        file: 'vibemobile-runner.tar.gz',
        sha256: 'b'.repeat(64),
        bytes: 1200,
        contents: 'runner',
      },
    },
    ...overrides,
  }
}

function mockFetch(manifestBody: unknown, listStatus = 200) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/packages?')) {
      if (listStatus !== 200) return new Response('{}', { status: listStatus })
      return new Response(JSON.stringify([{ version: 'v0.1.32-w0.1.58-abc-1', created_at: '2026-11-02T00:00:00Z' }]))
    }
    return new Response(JSON.stringify(manifestBody))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UpdateFeed', () => {
  it('finds the latest package and selects the artifact for its role', async () => {
    mockFetch(manifest())
    const feed = new UpdateFeed(config(), 'runner')
    const release = await feed.latest()
    expect(release.info.serverVersion).toBe('0.1.32')
    expect(release.info.artifact).toMatchObject({ role: 'runner', file: 'vibemobile-runner.tar.gz' })
    expect(release.url).toContain('/packages/generic/vibemobile/v0.1.32-w0.1.58-abc-1/vibemobile-runner.tar.gz')
    expect(release.createdAt).toBe('2026-11-02T00:00:00Z')
  })

  it('rejects a dirty release and a wrong artifact role', async () => {
    mockFetch(manifest({ dirty: true }))
    await expect(new UpdateFeed(config(), 'hub').latest()).rejects.toMatchObject({ code: 'feed_dirty' })

    mockFetch(manifest({ artifacts: { hub: { ...manifest().artifacts.hub, contents: 'runner' } } }))
    await expect(new UpdateFeed(config(), 'hub').latest()).rejects.toMatchObject({ code: 'feed_invalid' })
  })

  it('reports an unauthorized feed instead of a generic failure', async () => {
    mockFetch(manifest(), 401)
    await expect(new UpdateFeed(config(), 'hub').latest()).rejects.toBeInstanceOf(FeedError)
    await expect(new UpdateFeed(config(), 'hub').latest()).rejects.toMatchObject({ code: 'feed_unauthorized' })
  })

  it('refuses plain HTTP unless explicitly allowed', async () => {
    mockFetch(manifest())
    await expect(
      new UpdateFeed(config({ apiUrl: 'http://gitlab.example/api/v4' }), 'hub').latest(),
    ).rejects.toMatchObject({ code: 'feed_insecure' })

    const allowed = new UpdateFeed(config({ apiUrl: 'http://gitlab.example/api/v4', allowHttp: true }), 'hub')
    await expect(allowed.latest()).resolves.toMatchObject({ version: 'v0.1.32-w0.1.58-abc-1' })
  })

  it('caches the resolved release within the TTL', async () => {
    const fetchMock = mockFetch(manifest())
    const feed = new UpdateFeed(config({ ttlMs: 60_000 }), 'hub')
    await feed.latest()
    await feed.latest()
    expect(fetchMock).toHaveBeenCalledTimes(2) // package list + manifest, then cached
  })

  it('fails closed when the feed is not configured', async () => {
    const feed = new UpdateFeed(config({ enabled: false }), 'hub')
    expect(feed.configured()).toBe(false)
    await expect(feed.latest()).rejects.toMatchObject({ code: 'update_not_configured' })
  })
})
