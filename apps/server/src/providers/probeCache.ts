/**
 * Probe results, cached and single-flighted.
 *
 * `probe()` is not a cheap status read. For Claude it spawns a ~230 MB native
 * CLI binary and waits for the SDK's init handshake — measured 340 ms warm on
 * this machine, and that number is a *fixed per-spawn cost*: it does not vary
 * with the network, the working directory, or the config directory. For Codex
 * it can spawn and wait up to 30 s for an app-server that is not up.
 *
 * Paying that on every `/api/providers` request meant every visit to the
 * session list started a fresh process. Two separate savings, and both are
 * needed:
 *
 *  - the TTL turns repeat visits into a map lookup;
 *  - single-flight makes concurrent callers share one spawn. Both the session
 *    list and the settings screen probe on mount, and without this they race.
 *
 * The result is still a *point-in-time* answer, so the TTL is deliberately
 * short: a provider that goes down must stop being reported as available
 * within a page refresh or two, not never.
 */
import type { AgentProvider, ProviderProbe } from './types.js'

/** How long a probe result is reused. */
export const PROBE_TTL_MS = 30_000

export interface ProbeCacheOptions {
  ttlMs?: number
  /** Injectable clock, so tests do not have to sleep. */
  now?: () => number
}

export interface ProbeCache {
  probe(provider: AgentProvider, opts?: { force?: boolean }): Promise<ProviderProbe>
  probeAll(providers: AgentProvider[], opts?: { force?: boolean }): Promise<ProviderProbe[]>
  clear(): void
}

export function createProbeCache(opts: ProbeCacheOptions = {}): ProbeCache {
  const ttlMs = opts.ttlMs ?? PROBE_TTL_MS
  const now = opts.now ?? Date.now

  const results = new Map<string, { at: number; value: ProviderProbe }>()
  const inflight = new Map<string, Promise<ProviderProbe>>()

  function probe(provider: AgentProvider, o: { force?: boolean } = {}): Promise<ProviderProbe> {
    const cached = results.get(provider.id)
    if (!o.force && cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value)

    // Someone is already asking. Joining their answer is the whole point of
    // single-flight — a second spawn would cost the same 340 ms again and
    // produce the same result.
    const running = inflight.get(provider.id)
    if (running) return running

    // `probe()` is documented never to throw, but a provider is third-party
    // code behind an interface. A rejection escaping here would leave the
    // in-flight entry in place forever, so every later caller would await a
    // promise that already settled as rejected.
    const pending = Promise.resolve()
      .then(() => provider.probe())
      .catch(
        (err): ProviderProbe => ({
          id: provider.id,
          displayName: provider.displayName,
          available: false,
          detail: (err as Error).message,
        }),
      )
      .then((value) => {
        results.set(provider.id, { at: now(), value })
        inflight.delete(provider.id)
        return value
      })

    inflight.set(provider.id, pending)
    return pending
  }

  return {
    probe,
    probeAll: (providers, o) => Promise.all(providers.map((p) => probe(p, o))),
    clear: () => {
      results.clear()
      inflight.clear()
    },
  }
}

/** The process-wide cache the HTTP routes read. */
export const probeCache = createProbeCache()
