/**
 * Integration test for CodexProvider — exercises the full P1 stack:
 * supervisor -> AppServerClient -> mapEvents -> normalized AgentEvent.
 *
 * Usage: npx tsx apps/server/scripts/test-provider.ts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionSummary } from '@vibemobile/protocol'
import { CodexProvider } from '../src/codex/CodexProvider.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

const provider = new CodexProvider({
  // 6811 = 68xx 段里留给一次性脚本的端口（见 scripts/dev.mjs）。
  // 刻意不等于开发模式的 6800，好让这个脚本能和 `npm run dev` 同时跑。
  port: 6811,
  workspaceRoots: [ROOT],
  onLog: (line) => console.log(`  [codex] ${line}`),
})

function fmt(event: any): string {
  switch (event.kind) {
    case 'delta':
      return `delta(${event.channel}) ${JSON.stringify(event.text).slice(0, 60)}`
    case 'item.started':
    case 'item.completed':
    case 'item.updated':
      return `${event.kind} ${event.item.kind}${event.item.command ? ` cmd=${JSON.stringify(event.item.command).slice(0, 40)}` : ''}${event.item.text ? ` text=${JSON.stringify(event.item.text.slice(0, 40))}` : ''}`
    case 'approval.requested':
      return `APPROVAL ${event.approval.type} :: ${event.approval.detail?.slice(0, 80)}`
    case 'session.status':
      return `session.status=${event.status}`
    case 'turn.completed':
      return `turn.completed status=${event.status}`
    default:
      return `${event.kind} ${JSON.stringify(event).slice(0, 100)}`
  }
}

async function main() {
  console.log('=== probe ===')
  await provider.start()
  console.log(await provider.probe())

  console.log('\n=== models ===')
  const models = await provider.listModels()
  console.log(models.slice(0, 6))

  console.log('\n=== projects ===')
  console.log(await provider.listProjects())

  console.log('\n=== creating session ===')
  const session = await provider.createSession({ cwd: ROOT, sandbox: 'read-only' })
  console.log({ id: session.id, cwd: session.cwd, model: session.model })

  const counts: Record<string, number> = {}
  let done = false
  provider.subscribe((event) => {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1
    if (event.kind === 'delta') {
      // too noisy to print each one
      return
    }
    console.log(`  ${fmt(event)}`)
    if (event.kind === 'turn.completed') done = true
  })

  console.log('\n=== turn ===')
  const t0 = Date.now()
  await provider.startTurn(session.id, [
    { type: 'text', text: 'List the files in the current directory using a shell command, then say DONE.' },
  ])

  while (!done && Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 200))
  }

  console.log('\n=== event counts ===')
  console.log(counts)

  console.log('\n=== pending approvals ===', provider.pendingApprovalCount)

  console.log('\n=== transcript ===')
  const transcript = await provider.getTranscript(session.id)
  for (const turn of transcript?.turns ?? []) {
    console.log(` turn ${turn.id} [${turn.status}] ${turn.items.length} items`)
    for (const item of turn.items) {
      const summary =
        item.kind === 'message'
          ? item.text.slice(0, 70)
          : item.kind === 'command'
            ? `${item.command} -> exit ${item.exitCode} (${item.output.length} bytes out)`
            : item.kind === 'reasoning'
              ? `${item.summary.length} summary parts`
              : JSON.stringify(item).slice(0, 70)
      console.log(`    - ${item.kind}: ${summary}`)
    }
  }

  console.log('\n=== session list ===')
  const sessions = await provider.listSessions({ limit: 5 })
  console.log(sessions.map((s: SessionSummary) => ({ title: s.title.slice(0, 40), status: s.status, cwd: s.cwd })))

  await provider.stop()
  console.log('\n[test-provider] OK')
  process.exit(0)
}

main().catch(async (err) => {
  console.error('[test-provider] FATAL:', err)
  await provider.stop().catch(() => {})
  process.exit(1)
})
