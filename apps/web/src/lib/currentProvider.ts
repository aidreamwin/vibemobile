import type { AgentProfilesResponse, ProviderId } from '@vibemobile/protocol'

/** Resolve the runner's active configuration, rather than a saved turn's provider. */
export function currentProvider(
  agent: ProviderId | undefined,
  profiles: AgentProfilesResponse,
): { name: string; id?: string } | null {
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'opencode') return null
  // An attached external service owns its configuration; local files cannot describe it.
  if (profiles.limitations?.[agent]) return null
  const activeId = profiles.active[agent]
  if (activeId !== null) {
    const profile = profiles.data[agent].find((item) => item.id === activeId)
    return profile ? { name: profile.name } : null
  }
  const native = profiles.native?.[agent]
  if (!native || native.error) return null
  if (native.providerId) {
    const selected = native.providers.find((item) => item.id === native.providerId)
    const name = selected?.name || native.providerId
    return { name, ...(name !== native.providerId ? { id: native.providerId } : {}) }
  }
  if (native.baseUrl) {
    try {
      // Do not show credentials, query strings or paths from a custom endpoint.
      return { name: new URL(native.baseUrl).hostname }
    } catch {
      return null
    }
  }
  return { name: native.name }
}
