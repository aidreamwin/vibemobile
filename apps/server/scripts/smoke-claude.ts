/**
 * P0 go/no-go smoke test for the Claude Agent SDK path.
 *
 * This is the Claude counterpart of smoke-codex.ts and exists to answer the
 * same architectural question: can we drive the agent from a phone with
 * *token-by-token* streaming, a real approval round-trip, and a working
 * interrupt?
 *
 * For Codex the answer was "not through the SDK" — `@openai/codex-sdk` wraps
 * `codex exec --json` and structurally discards delta notifications, so the
 * project had to speak app-server JSON-RPC instead. The Agent SDK is expected
 * to be different because of `includePartialMessages`, but that is an
 * assumption until measured, and it is the assumption the whole provider
 * design rests on.
 *
 * Success criteria:
 *   1. `system:init` reports a version + auth source (proves the subprocess
 *      launched and authenticated)
 *   2. Many `stream_event`/`content_block_delta` frames arrive spread over
 *      time (proves token-by-token, not one blob)
 *   3. `canUseTool` fires, and holding it blocks the turn until we answer
 *      (proves the approval sheet can be wired to a real callback)
 *   4. `interrupt()` stops a running turn
 *
 * Usage: npx tsx apps/server/scripts/smoke-claude.ts
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CWD = path.resolve(__dirname, '../../..')

// ------------------------------------------------------------------ plumbing

/**
 * A live user-message stream.
 *
 * Streaming input mode (an AsyncIterable prompt rather than a string) is what
 * makes a session long-lived: the same subprocess serves every turn, which is
 * what lets us interrupt, steer, and answer approvals. The generator parks on
 * `next()` when the queue is empty — that is the mechanism steering will use.
 */
class MessageQueue {
  #queue: SDKUserMessage[] = []
  #waiters: ((m: SDKUserMessage) => void)[] = []
  #closed = false

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    }
    const waiter = this.#waiters.shift()
    if (waiter) waiter(msg)
    else this.#queue.push(msg)
  }

  close(): void {
    this.#closed = true
    for (const w of this.#waiters.splice(0)) void w
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.#closed) {
      const queued = this.#queue.shift()
      if (queued) {
        yield queued
        continue
      }
      const next = await new Promise<SDKUserMessage | null>((resolve) => {
        this.#waiters.push(resolve as (m: SDKUserMessage) => void)
        if (this.#closed) resolve(null)
      })
      if (next) yield next
    }
  }
}

const log = (...args: unknown[]) => console.log('[smoke]', ...args)
const failures: string[] = []
const check = (ok: boolean, msg: string) => {
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} — ${msg}`)
  if (!ok) failures.push(msg)
}

// ---------------------------------------------------------------------- main

async function main() {
  const queue = new MessageQueue()
  const deltas: { at: number; text: string }[] = []
  let firstDeltaAt = 0

  const approvals: { requestId: string; tool: string; title?: string; input: unknown }[] = []
  /** Resolvers for approvals we are deliberately holding open. */
  const heldApprovals = new Map<string, (decision: 'allow' | 'deny') => void>()

  let initInfo: any = null
  let sessionId = ''
  let resultCount = 0
  let lastResult: any = null
  const messageCounts: Record<string, number> = {}

  const options: Options = {
    cwd: CWD,
    // The whole design depends on this. Without it there are no deltas.
    includePartialMessages: true,
    // Claude Code's real system prompt + tool set; the phone should drive the
    // same agent the desktop does.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    // `default` = ask before anything dangerous, which is what surfaces a
    // canUseTool call for us to render as an approval sheet.
    permissionMode: 'default',
    stderr: (data) => process.stderr.write(`[cli:err] ${data}`),

    canUseTool: async (toolName, input, opts) => {
      const decision = await new Promise<'allow' | 'deny'>((resolve) => {
        heldApprovals.set(opts.requestId, resolve)
        approvals.push({
          requestId: opts.requestId,
          tool: toolName,
          title: opts.title,
          input,
        })
      })
      heldApprovals.delete(opts.requestId)
      log(`      <<< approval ${opts.requestId} answered: ${decision}`)
      if (decision === 'allow') {
        return { behavior: 'allow', updatedInput: input }
      }
      return { behavior: 'deny', message: 'Denied from the smoke test.' }
    },
  }

  const q = query({ prompt: queue, options })

  const consume = (async () => {
    for await (const msg of q as AsyncGenerator<SDKMessage>) {
      messageCounts[msg.type === 'system' ? `system:${(msg as any).subtype}` : msg.type] =
        (messageCounts[msg.type === 'system' ? `system:${(msg as any).subtype}` : msg.type] ?? 0) + 1

      if (msg.session_id) sessionId = msg.session_id

      switch (msg.type) {
        case 'system': {
          const sub = (msg as any).subtype
          if (sub === 'init') {
            initInfo = msg
            log(`<<< system:init version=${(msg as any).claude_code_version}`)
            log(`      model=${(msg as any).model} permissionMode=${(msg as any).permissionMode}`)
            log(`      apiKeySource=${(msg as any).apiKeySource}`)
            log(`      capabilities=${JSON.stringify((msg as any).capabilities)}`)
            log(`      tools=${(msg as any).tools?.length} mcp=${JSON.stringify((msg as any).mcp_servers)}`)
          } else if (sub === 'thinking_tokens') {
            // Emitted once per estimated thinking token — 618 of them in one
            // turn. Noise here; a provider has to decide whether to map it.
          } else {
            log(`<<< system:${sub} ${JSON.stringify(msg).slice(0, 160)}`)
          }
          break
        }

        case 'stream_event': {
          const ev = (msg as any).event
          if (ev?.type === 'content_block_delta') {
            const d = ev.delta
            if (d?.type === 'text_delta') {
              const now = Date.now()
              if (!firstDeltaAt) {
                firstDeltaAt = now
                log(`<<< FIRST text_delta`)
              }
              deltas.push({ at: now, text: d.text })
              process.stdout.write(d.text)
            } else if (d?.type === 'thinking_delta') {
              const now = Date.now()
              deltas.push({ at: now, text: d.thinking })
            }
          }
          break
        }

        case 'assistant': {
          const content = (msg as any).message?.content ?? []
          const kinds = content.map((c: any) => c.type).join(',')
          log(`\n<<< assistant (blocks: ${kinds})${(msg as any).parent_tool_use_id ? ' [subagent]' : ''}`)
          break
        }

        case 'user': {
          const content = (msg as any).message?.content
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === 'tool_result') {
                const preview = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
                log(`\n<<< tool_result${c.is_error ? ' (ERROR)' : ''}: ${String(preview).slice(0, 200)}`)
              }
            }
          }
          break
        }

        case 'result': {
          resultCount++
          const m = msg as any
          lastResult = m
          log(
            `\n<<< result #${resultCount} subtype=${m.subtype} is_error=${m.is_error} turns=${m.num_turns} cost=$${m.total_cost_usd} terminal_reason=${m.terminal_reason}`,
          )
          log(`      usage=${JSON.stringify(m.usage)}`)
          log(`      denials=${JSON.stringify(m.permission_denials)}`)
          if (m.is_error) log(`      errors=${JSON.stringify(m.errors)} result=${String(m.result).slice(0, 300)}`)
          break
        }

        default:
          log(`<<< ${msg.type} ${JSON.stringify(msg).slice(0, 140)}`)
      }
    }
  })()

  // ---------------------------------------------------------------- phase 1
  console.log('\n=== PHASE 1: streaming (no tools expected) ===')
  const t1 = Date.now()
  queue.push('Count from 1 to 15, one number per line. Nothing else.')
  const done1 = await waitForResults(() => resultCount >= 1, 120_000)
  log(`phase 1 finished=${done1} in ${Date.now() - t1}ms`)

  if (deltas.length) {
    const span = deltas[deltas.length - 1].at - deltas[0].at
    log(`streaming: ${deltas.length} deltas over ${span}ms`)
  }

  // ---------------------------------------------------------------- phase 2
  console.log('\n=== PHASE 2: tool approval round-trip ===')
  const before = approvals.length
  // A write is used deliberately: `echo` is classified as a safe read-only
  // command and runs without ever consulting canUseTool, which produced a
  // false negative the first time this test was run.
  queue.push(
    'Create a file named vibemobile-approval-probe.txt in the current directory containing exactly the text hello. Then tell me you are done.',
  )
  const gotApproval = await waitForResults(() => approvals.length > before, 90_000)

  if (gotApproval) {
    const a = approvals[approvals.length - 1]
    log(`approval requested for tool="${a.tool}" title="${a.title}"`)
    log(`  input=${JSON.stringify(a.input).slice(0, 200)}`)
    // Hold it briefly to prove the turn is genuinely blocked on us.
    const blocked = await waitForResults(() => resultCount < 2, 2000)
    check(blocked, 'turn stayed blocked while the approval was unanswered')
    log('  answering allow...')
    heldApprovals.get(a.requestId)?.('allow')
    const finished = await waitForResults(() => resultCount >= 2, 120_000)
    check(finished, 'turn completed after the approval was answered')
  } else {
    check(false, 'canUseTool never fired — the approval sheet would have nothing to show')
  }

  // ---------------------------------------------------------------- phase 3
  console.log('\n=== PHASE 3: interrupt ===')
  const resultsBefore = resultCount
  const deltasBefore = deltas.length
  const t3 = Date.now()
  queue.push('Count slowly from 1 to 300, one number per line. Nothing else.')
  // Let it get properly under way so the interrupt lands mid-stream.
  await waitForResults(() => deltas.length > deltasBefore + 20, 60_000)
  log(`interrupting ${Date.now() - t3}ms in, after ${deltas.length - deltasBefore} deltas...`)
  try {
    const receipt = await q.interrupt()
    log(`interrupt() resolved in ${Date.now() - t3}ms -> ${JSON.stringify(receipt)}`)
    const stopped = await waitForResults(() => resultCount > resultsBefore, 60_000)
    check(stopped, 'a result arrived after interrupt()')
    check(
      Date.now() - t3 < 60_000,
      `turn stopped promptly: ${Date.now() - t3}ms (a full count to 300 takes far longer)`,
    )
    log(`terminal_reason after interrupt = ${lastResult?.terminal_reason}`)
  } catch (err) {
    check(false, `interrupt() threw: ${(err as Error).message}`)
  }

  // ------------------------------------------------------------- assertions
  console.log('\n=== SUMMARY ===')
  console.log('  message counts:')
  for (const [k, v] of Object.entries(messageCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(6)}  ${k}`)
  }

  check(!!initInfo, 'system:init arrived')
  check(!!sessionId, `session_id present (${sessionId})`)
  check(deltas.length >= 10, `token-by-token streaming: ${deltas.length} content deltas (need >=10)`)
  if (deltas.length > 1) {
    const span = deltas[deltas.length - 1].at - deltas[0].at
    check(span >= 20, `deltas spread over time: ${span}ms (need >=20ms, else it is one blob)`)
  }

  queue.close()
  // `Query.close()` is declared `(): void`, not a promise — chaining `.catch`
  // onto it was what crashed this script on the previous run.
  q.close()

  if (failures.length) {
    console.error(`\n[smoke] FAILED:\n  - ${failures.join('\n  - ')}`)
    process.exit(1)
  }
  console.log('\n[smoke] PASSED — the Claude Agent SDK path streams, gates tools, and interrupts.')
  process.exit(0)
}

/** Poll until `cond()` is true. Returns whether it became true before the deadline. */
async function waitForResults(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

main().catch((err) => {
  console.error('\n[smoke] FATAL:', err)
  process.exit(1)
})
