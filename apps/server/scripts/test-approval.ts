/**
 * Focused test for the approval round trip — the single most important
 * integration point of the whole product.
 *
 * Forces an approval by pairing a read-only sandbox with the "untrusted"
 * approval policy, then answers it and checks the turn proceeds.
 *
 * Usage: npx tsx apps/server/scripts/test-approval.ts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexProvider } from '../src/codex/CodexProvider.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

const provider = new CodexProvider({
  // 6812 = 68xx 段里留给一次性脚本的端口（见 scripts/dev.mjs）。
  // 每个脚本各占一个，这样它们之间、以及和 `npm run dev` 都能同时跑。
  port: 6812,
  workspaceRoots: [ROOT],
  onLog: (line) => {
    if (/error|warn/i.test(line)) console.log(`  [codex] ${line}`)
  },
})

async function main() {
  await provider.start()

  console.log('=== creating session: read-only sandbox + untrusted approvals ===')
  const session = await provider.createSession({
    cwd: ROOT,
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
  })
  console.log({ id: session.id })

  const seen: string[] = []
  let approvalsSeen = 0
  let resolvedSeen = false
  let done = false
  let turnId = ''

  provider.subscribe(async (event) => {
    seen.push(event.kind)

    // The approval sheet dismisses on this and nothing else, so it is part of
    // the contract, not an implementation detail.
    if (event.kind === 'approval.resolved') {
      resolvedSeen = true
      console.log(`\n  <<< approval.resolved  requestId=${event.requestId}`)
      return
    }

    if (event.kind === 'approval.requested') {
      approvalsSeen++
      const a = event.approval
      console.log(`\n  >>> APPROVAL #${approvalsSeen} [${a.type}]`)
      console.log(`      title:   ${a.title}`)
      console.log(`      detail:  ${a.detail}`)
      console.log(`      cwd:     ${a.cwd}`)
      console.log(`      choices: ${a.availableDecisions.join(' | ')}`)
      console.log(`      requestId: ${a.requestId}`)

      // A real UI would wait for the user; here we approve immediately.
      await provider.answerApproval(a.requestId, 'accept')
      console.log('      -> answered: accept')
      return
    }

    if (event.kind === 'item.completed' && event.item.kind === 'command') {
      console.log(
        `  [command completed] exit=${event.item.exitCode} out=${JSON.stringify(event.item.output.slice(0, 80))}`,
      )
    }

    if (event.kind === 'turn.completed') {
      console.log(`\n  [turn.completed] status=${event.status}`)
      done = true
    }
  })

  console.log('\n=== turn (should require approval) ===')
  const started = await provider.startTurn(session.id, [
    { type: 'text', text: 'Run the shell command `echo HELLO-FROM-APPROVAL-TEST` and tell me its output.' },
  ])
  turnId = started.turnId
  console.log(`  turnId=${turnId}`)

  const t0 = Date.now()
  while (!done && Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 250))
  }

  // ---- second scenario: interrupt mid-turn ----
  console.log('\n=== interrupt test ===')
  let interrupted = false
  let sawInterruptStatus = ''
  const off = provider.subscribe((event) => {
    if (event.kind === 'turn.completed') {
      sawInterruptStatus = event.status
      interrupted = true
    }
  })

  const second = await provider.startTurn(session.id, [
    { type: 'text', text: 'Count slowly from 1 to 500, one number per line, with a short sentence between each.' },
  ])
  await new Promise((r) => setTimeout(r, 6_000))

  console.log(`  sending turn/interrupt for ${second.turnId}...`)
  await provider.interrupt(session.id, second.turnId)
  const t1 = Date.now()
  while (!interrupted && Date.now() - t1 < 60_000) {
    await new Promise((r) => setTimeout(r, 200))
  }
  off()

  console.log('\n=== results ===')
  console.log(`  approvals triggered: ${approvalsSeen}`)
  console.log(`  approval.resolved seen: ${resolvedSeen}`)
  console.log(`  interrupt turn status: ${sawInterruptStatus || '(none)'}`)

  const failures: string[] = []
  if (approvalsSeen === 0) failures.push('no approval request was triggered')
  if (!resolvedSeen) {
    failures.push('answering an approval never produced approval.resolved')
  }
  if (!done) failures.push('first turn never completed')
  if (sawInterruptStatus !== 'interrupted') {
    failures.push(`interrupt produced status "${sawInterruptStatus}", expected "interrupted"`)
  }

  await provider.stop()

  if (failures.length) {
    console.error(`\n[test-approval] FAILED:\n  - ${failures.join('\n  - ')}`)
    process.exit(1)
  }
  console.log('\n[test-approval] PASSED — approvals and interrupts both work.')
  process.exit(0)
}

main().catch(async (err) => {
  console.error('[test-approval] FATAL:', err)
  await provider.stop().catch(() => {})
  process.exit(1)
})
