/**
 * Install and activate the runtime packs this build supports.
 *
 * Same work as the Settings page's update button, for a headless runner or a
 * scripted upgrade:
 *
 *   npm run agents:update                # both
 *   npm run agents:update -- claude      # one
 *
 * Versions come from `src/agents/manifest.ts`; this script cannot be pointed at
 * an arbitrary package or version.
 */
import type { AgentRuntimeId } from '@vibemobile/protocol'
import { loadConfig } from '../src/config.js'
import { agentStatuses, updateAgent } from '../src/agents/installer.js'
import { AGENT_IDS, isAgentRuntimeId } from '../src/agents/manifest.js'

const config = loadConfig()
const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const ids: AgentRuntimeId[] = []

for (const id of wanted.length ? wanted : AGENT_IDS) {
  if (!isAgentRuntimeId(id)) {
    console.error(`unknown agent: ${id} (expected one of: ${AGENT_IDS.join(', ')})`)
    process.exit(2)
  }
  ids.push(id)
}

let failed = false
for (const id of ids) {
  try {
    await updateAgent(config, id, { onLog: (line) => console.log(line) })
  } catch (err) {
    console.error(`[agents] ${id} failed: ${(err as Error).message}`)
    failed = true
  }
}

for (const status of agentStatuses(config)) {
  console.log(
    `${status.displayName}: active=${status.active ?? 'none'} (${status.source}), supported=${status.supported}`,
  )
}

process.exitCode = failed ? 1 : 0
