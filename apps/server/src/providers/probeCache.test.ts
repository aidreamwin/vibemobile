import { describe, expect, it, vi } from 'vitest'
import { createProbeCache } from './probeCache.js'
import type { AgentProvider, ProviderProbe } from './types.js'

/**
 * A provider stub that counts how often it was actually probed.
 *
 * `probe()` is the expensive call (for Claude it spawns a ~230 MB binary), so
 * every assertion here is really "how many times did we spawn".
 */
function stub(id: string, impl?: () => Promise<ProviderProbe>) {
  const calls = { count: 0 }
  const provider = {
    id,
    displayName: id,
    probe: vi.fn(async (): Promise<ProviderProbe> => {
      calls.count += 1
      if (impl) return impl()
      return { id, displayName: id, available: true }
    }),
  } as unknown as AgentProvider
  return { provider, calls }
}

function clock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('probeCache', () => {
  it('probes once and reuses the result within the TTL', async () => {
    const time = clock()
    const cache = createProbeCache({ ttlMs: 30_000, now: time.now })
    const { provider, calls } = stub('codex')

    const first = await cache.probe(provider)
    time.advance(29_999)
    const second = await cache.probe(provider)

    expect(calls.count).toBe(1)
    expect(second).toBe(first)
  })

  it('probes again once the TTL has passed', async () => {
    const time = clock()
    const cache = createProbeCache({ ttlMs: 30_000, now: time.now })
    const { provider, calls } = stub('codex')

    await cache.probe(provider)
    time.advance(30_001)
    await cache.probe(provider)

    expect(calls.count).toBe(2)
  })

  it('shares one probe between concurrent callers', async () => {
    const cache = createProbeCache({ ttlMs: 30_000 })
    // The gate is held open until both callers are in flight, so the second has
    // to join the first rather than start a spawn of its own. (It is resolved
    // from the test body, not from inside `impl`, which only runs a microtask
    // after `probe()` is called.)
    let release: (value: ProviderProbe) => void = () => {}
    const gate = new Promise<ProviderProbe>((resolve) => (release = resolve))
    const { provider, calls } = stub('claude', () => gate)

    const a = cache.probe(provider)
    const b = cache.probe(provider)
    release({ id: 'claude', displayName: 'claude', available: true })

    await expect(Promise.all([a, b])).resolves.toHaveLength(2)
    expect(calls.count).toBe(1)
    expect(b).toBe(a)
  })

  it('re-probes when forced, ignoring a fresh cache entry', async () => {
    const cache = createProbeCache({ ttlMs: 30_000 })
    const { provider, calls } = stub('codex')

    await cache.probe(provider)
    await cache.probe(provider, { force: true })

    expect(calls.count).toBe(2)
  })

  it('reports a throwing provider as unavailable instead of rejecting', async () => {
    const cache = createProbeCache({ ttlMs: 30_000 })
    const { provider } = stub('claude', () => Promise.reject(new Error('CLI missing')))

    const status = await cache.probe(provider)

    expect(status.available).toBe(false)
    expect(status.detail).toBe('CLI missing')
  })

  it('does not leave a poisoned entry behind when a probe rejects', async () => {
    // A rejection that stayed in the in-flight map would make every later
    // caller await a promise that already settled as rejected.
    const time = clock()
    const cache = createProbeCache({ ttlMs: 30_000, now: time.now })
    const { provider, calls } = stub('claude', () =>
      calls.count === 1
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ id: 'claude', displayName: 'claude', available: true }),
    )

    await cache.probe(provider)
    const second = await cache.probe(provider, { force: true })

    expect(calls.count).toBe(2)
    expect(second.available).toBe(true)
  })

  it('probes every provider for probeAll', async () => {
    const cache = createProbeCache({ ttlMs: 30_000 })
    const codex = stub('codex')
    const claude = stub('claude')

    const statuses = await cache.probeAll([codex.provider, claude.provider])

    expect(statuses.map((s) => s.id)).toEqual(['codex', 'claude'])
    expect(codex.calls.count).toBe(1)
    expect(claude.calls.count).toBe(1)
  })
})
