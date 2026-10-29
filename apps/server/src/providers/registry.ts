/**
 * Provider registry.
 *
 * Registering a new agent backend here is the only server-side step needed to
 * make it selectable from the web UI.
 */
import type { AgentProvider } from './types.js'

class Registry {
  #providers = new Map<string, AgentProvider>()
  /**
   * sessionId -> providerId.
   *
   * `default` is only "the first provider registered", which was a safe way to
   * resolve a session while exactly one existed. With two it is a coin flip:
   * opening a Claude session would hand its id to Codex, which would report
   * that the session does not exist. Every path that learns a session id —
   * listing, creating, and each event a provider emits — records the owner
   * here, so a bare id can be routed without the client naming a provider.
   */
  #byThread = new Map<string, string>()

  /**
   * Where the routing layer reports its own diagnostics. Set by `index.ts` so
   * they land in the service log rather than on a console nobody reads.
   */
  log?: (message: string, detail?: unknown) => void

  register(provider: AgentProvider): void {
    this.#providers.set(provider.id, provider)
  }

  get(id: string): AgentProvider | undefined {
    return this.#providers.get(id)
  }

  /** Resolve a provider, throwing a client-safe error when unknown. */
  require(id: string): AgentProvider {
    const provider = this.#providers.get(id)
    if (!provider) {
      const known = [...this.#providers.keys()].join(', ') || 'none'
      throw Object.assign(new Error(`unknown provider "${id}" (available: ${known})`), {
        statusCode: 404,
      })
    }
    return provider
  }

  /** The provider used when a request does not name one. */
  get default(): AgentProvider | undefined {
    return this.#providers.values().next().value
  }

  list(): AgentProvider[] {
    return [...this.#providers.values()]
  }

  // ------------------------------------------------------------ session routing

  /** Record which provider owns a session, so a bare id can be routed later. */
  bind(providerId: string, threadId: string): void {
    if (threadId) this.#byThread.set(threadId, providerId)
  }

  /** Drop a deleted session. A stale binding would route to a 404 instead. */
  forget(threadId: string): void {
    this.#byThread.delete(threadId)
  }

  /** The provider that owns a session, if it has been seen. */
  forThread(threadId: string): AgentProvider | undefined {
    const id = this.#byThread.get(threadId)
    return id ? this.#providers.get(id) : undefined
  }

  /**
   * The provider that owns a session, asking around when the id is new.
   *
   * The lookup only happens on a miss — a client that opened a session before
   * any list finished loading, say. It is worth the wait: guessing here means
   * showing an empty transcript for a session that exists, which looks like
   * data loss rather than a routing mistake.
   *
   * Falls back to `default` when nobody recognises the id, so an unknown
   * session still produces that provider's own not-found error rather than a
   * surprising 503.
   */
  async forSession(threadId: string): Promise<AgentProvider | undefined> {
    const known = this.forThread(threadId)
    if (known) return known

    for (const provider of this.#providers.values()) {
      let found: Awaited<ReturnType<AgentProvider['getSession']>>
      try {
        found = await provider.getSession(threadId)
      } catch (err) {
        // `getSession` answers `null` for an id it does not own, so a throw is
        // a real failure — a backend that is down, most likely. Swallowing it
        // would send this id to the *next* provider and end at `default`,
        // which reports a session that exists as missing. The fallback stays
        // (an unknown id still has to produce a not-found, not a 503), but it
        // is no longer silent about why it got there.
        this.log?.(`session lookup failed on ${provider.id}: ${(err as Error).message}`, err)
        continue
      }
      if (found) {
        this.bind(provider.id, threadId)
        return provider
      }
    }
    return this.default
  }
}

export const registry = new Registry()
