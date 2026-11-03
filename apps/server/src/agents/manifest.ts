import type { AgentRuntimeId } from '@vibemobile/protocol'

export interface AgentRuntimeSpec {
  displayName: string
  /** npm package installed into `<agents>/<id>/<version>`. */
  package: string
  /**
   * Patch-level range (`~x.y.z`) or an exact pin, resolved by npm at install
   * time.
   *
   * A tilde range is the point of this feature: adopting a new patch does not
   * require shipping a new app build. Codex and Claude use one because their
   * protocol wording is stable within a patch line. opencode's HTTP surface is
   * explicitly experimental, so it is pinned exactly; a new patch is a manifest
   * change followed by the contract smoke, not an automatic adoption.
   *
   * Minor/major bumps always stay a manifest change (i.e. an app update).
   */
  range: string
}

/**
 * The agent runtime versions this build supports.
 *
 * This table is also the allow-list: the update route takes only an agent id
 * and reads the range from here, never from the client. "Latest" on npm is not
 * a safe default — Codex's app-server has no protocol version negotiation —
 * but the patch line above is.
 */
export const AGENT_RUNTIMES: Record<AgentRuntimeId, AgentRuntimeSpec> = {
  codex: { displayName: 'Codex', package: '@openai/codex', range: '~0.166.0' },
  claude: { displayName: 'Claude', package: '@anthropic-ai/claude-code', range: '~2.1.316' },
  opencode: { displayName: 'OpenCode', package: '@opencode/cli', range: '2.2.5' },
}

export const AGENT_IDS = ['codex', 'claude', 'opencode'] as const satisfies readonly AgentRuntimeId[]

export function isAgentRuntimeId(value: string): value is AgentRuntimeId {
  return value === 'codex' || value === 'claude' || value === 'opencode'
}
