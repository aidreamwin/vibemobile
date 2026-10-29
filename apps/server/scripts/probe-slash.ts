/**
 * Two questions the Composer's command menu depends on.
 *
 *   npx tsx apps/server/scripts/probe-slash.ts [command]
 *
 * 1. **Does the CLI expand a slash command typed as ordinary prompt text?**
 *    The composer only ever sends text (`startTurn` takes `AgentInput[]`), so if
 *    the CLI does not expand it, a menu that inserts `/usage` would be a menu
 *    that inserts a sentence — and the honest design would be to drop the menu
 *    rather than ship a lie.
 * 2. **What is actually in the init frame's `slash_commands`?** That list comes
 *    from the CLI and is meant to be the menu's contents, with
 *    `terminal_slash_commands` subtracted (the SDK says phone/remote UIs must
 *    hide those). Measuring prints both so the subtraction is visible.
 *
 * Cheap by construction: a local command like `/usage` is answered by the CLI
 * itself, with no model request. Cost of the default run is one CLI startup.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CWD = path.resolve(__dirname, '../../..')
// The leading slash is added here rather than taken from argv: on Windows this
// runs under Git Bash, which rewrites a bare `/usage` argument into
// `C:/Program Files/Git/usage` before Node ever sees it — a probe that sent
// that would be asking about a path and would "prove" that the CLI does not
// expand slash commands.
const COMMAND = `/${(process.argv[2] ?? 'usage').replace(/^\/+/, '')}`

const options: Options = {
  cwd: CWD,
  includePartialMessages: false,
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  permissionMode: 'default',
  canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
}

let init: any = null
const seen: Record<string, number> = {}

for await (const msg of query({ prompt: COMMAND, options }) as AsyncGenerator<SDKMessage>) {
  const key = msg.type === 'system' ? `system:${(msg as any).subtype}` : msg.type
  seen[key] = (seen[key] ?? 0) + 1

  if (msg.type === 'system' && (msg as any).subtype === 'init') {
    init = msg
    continue
  }

  // Everything that could carry an expansion, printed in full: these frames are
  // small and the wording is the evidence.
  if (key === 'system:local_command_output') {
    console.log(`\n<<< local_command_output:\n${(msg as any).content}`)
  } else if (msg.type === 'assistant') {
    const content: any[] = (msg as any).message?.content ?? []
    for (const block of content) {
      if (block?.type === 'text') console.log(`\n<<< assistant text:\n${block.text}`)
      if (block?.type === 'tool_use') console.log(`\n<<< tool_use: ${block.name} ${JSON.stringify(block.input)}`)
    }
  } else if (msg.type === 'result') {
    console.log(`\n<<< result subtype=${(msg as any).subtype} is_error=${(msg as any).is_error}`)
    if ((msg as any).is_error) console.log(`    ${String((msg as any).result).slice(0, 400)}`)
  } else if (msg.type === 'user') {
    console.log(`\n<<< user frame: ${JSON.stringify((msg as any).message).slice(0, 300)}`)
  }
}

console.log(`\n--- frame counts for ${JSON.stringify(COMMAND)} ---`)
for (const [k, v] of Object.entries(seen).sort()) console.log(`  ${String(v).padStart(4)}  ${k}`)

if (!init) {
  console.log('\n(no init frame — nothing to read the command list from)')
  process.exit(0)
}

const all: string[] = init.slash_commands ?? []
const terminal: string[] = init.terminal_slash_commands ?? []
const menu = all.filter((c) => !terminal.includes(c))
console.log(`\nslash_commands (${all.length}): ${all.join(' ')}`)
console.log(`terminal_slash_commands (${terminal.length}): ${terminal.join(' ')}`)
console.log(`menu after subtracting terminal ones (${menu.length}): ${menu.join(' ')}`)

process.exit(0)
