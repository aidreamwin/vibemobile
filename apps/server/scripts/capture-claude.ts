/**
 * Capture real Claude Agent SDK frames, so the mapper is written against
 * bytes instead of assumptions.
 *
 * This is step 0 of the Claude provider work and a hard gate: several design
 * decisions in mapClaudeEvents.ts cannot be made honestly without knowing
 *   - whether `assistant.message.id` matches the `message_start` message id
 *     (the stream/final join, which decides whether text cards duplicate)
 *   - whether `tool_use_result` (the structured output, with structuredPatch
 *     diffs) is populated on LIVE frames or only on replayed ones
 *   - what a failing Bash tool_result actually looks like (exit code source)
 *   - whether a Task tool_result arrives on the main thread
 *   - whether a mid-turn push folds into the running turn or yields a second
 *     `result`
 *
 * Output: one JSON object per line at $CAPTURE_OUT (default ./claude-capture.jsonl).
 * Each line is { tag, ... }, where tag names the scenario. Raw SDK frames are
 * written verbatim under `msg`; `canUseTool` invocations under `approval`.
 *
 * Usage: npx tsx apps/server/scripts/capture-claude.ts
 */
import { getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A scratch cwd keeps the capture out of the repo. Sessions are stored per
// encoded cwd, so a dedicated directory also keeps `getSessionMessages` clean.
const CWD = path.join(os.tmpdir(), 'vibemobile-claude-capture')
fs.mkdirSync(CWD, { recursive: true })

const OUT = process.env.CAPTURE_OUT ?? path.resolve(process.cwd(), 'claude-capture.jsonl')
const out = fs.createWriteStream(OUT, { flags: 'w' })

let currentTag = 'boot'
function record(obj: Record<string, unknown>): void {
  out.write(`${JSON.stringify({ tag: currentTag, ...obj })}\n`)
}
function tag(name: string): void {
  currentTag = name
  console.log(`\n[capture] ==== ${name} ====`)
}

// ------------------------------------------------------------------ plumbing

/** Live user-message stream; identical in shape to the one the provider uses. */
class MessageQueue {
  #queue: SDKUserMessage[] = []
  #waiters: ((m: SDKUserMessage) => void)[] = []
  #closed = false

  push(text: string): string {
    const uuid = crypto.randomUUID()
    const msg: SDKUserMessage = {
      type: 'user',
      uuid,
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    }
    const waiter = this.#waiters.shift()
    if (waiter) waiter(msg)
    else this.#queue.push(msg)
    return uuid
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

// -------------------------------------------------------------- join probing
//
// Tracks whether the id a block is streamed under matches the id the final
// assistant message is delivered under. This is the single most consequential
// unknown: get it wrong and every text block renders twice on the phone.

const joinReport = {
  messageStartIds: new Set<string>(),
  assistantMessageIds: new Set<string>(),
  streamEventUuids: new Set<string>(),
  assistantUuids: new Set<string>(),
  /** Every streamed block, in order, so we can compare with the assistant copy. */
  streamedBlocks: [] as { messageId: string; index: number; type: string; textLen: number }[],
  assistantBlocks: [] as { messageId: string; uuid: string; types: string[]; textLens: number[] }[],
}

// --------------------------------------------------------------------- main

async function main() {
  const queue = new MessageQueue()
  let sessionId = ''
  let resultCount = 0
  let lastResult: any = null
  /** toolUseID -> the `canUseTool` opts, so we can join approval calls to results. */
  const approvalByToolUse = new Map<string, unknown>()

  const options: Options = {
    cwd: CWD,
    includePartialMessages: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'default',
    // NOTE: `env` is deliberately NOT set. The option REPLACES the subprocess
    // environment wholesale, and this machine authenticates through an
    // ANTHROPIC_BASE_URL proxy configured in ~/.claude/settings.json.
    stderr: (d) => process.stderr.write(`[cli:err] ${d}`),

    canUseTool: async (toolName, input, o) => {
      record({
        kind: 'approval',
        toolName,
        input,
        opts: {
          requestId: o.requestId,
          toolUseID: o.toolUseID,
          title: o.title,
          displayName: o.displayName,
          description: o.description,
          decisionReason: o.decisionReason,
          blockedPath: o.blockedPath,
          agentID: o.agentID,
          defaultToNo: o.defaultToNo,
          suppressAlwaysAllowRule: o.suppressAlwaysAllowRule,
          matchedAskRule: o.matchedAskRule,
          suggestions: o.suggestions,
        },
      })
      approvalByToolUse.set(o.toolUseID, o)
      console.log(`[capture] canUseTool ${toolName} requestId=${o.requestId} title=${o.title}`)
      // Auto-allow so every scenario runs to completion; the approval ROUND TRIP
      // is already proven by smoke-claude.ts and is not what this script is for.
      return { behavior: 'allow', updatedInput: input }
    },
  }

  const q = query({ prompt: queue, options })

  const consume = (async () => {
    for await (const msg of q as AsyncGenerator<SDKMessage>) {
      record({ kind: 'frame', msg })
      if (msg.session_id) sessionId = msg.session_id

      // ---- enrichment for the join question ----
      if (msg.type === 'stream_event') {
        const ev = (msg as any).event
        joinReport.streamEventUuids.add((msg as any).uuid)
        if (ev?.type === 'message_start') joinReport.messageStartIds.add(ev.message?.id)
        if (ev?.type === 'content_block_start' || ev?.type === 'content_block_delta') {
          const messageId = ev.message?.id ?? lastStreamMessageId
          if (messageId) {
            lastStreamMessageId = messageId
            const block = ev.content_block ?? ev.delta
            joinReport.streamedBlocks.push({
              messageId,
              index: ev.index,
              type: ev.content_block?.type ?? ev.delta?.type ?? '?',
              textLen: (ev.delta?.text ?? ev.delta?.thinking ?? '').length,
            })
          }
        }
        if (ev?.type === 'message_start' && ev.message?.id) lastStreamMessageId = ev.message.id
      }

      if (msg.type === 'assistant') {
        const m = msg as any
        joinReport.assistantMessageIds.add(m.message?.id)
        joinReport.assistantUuids.add(m.uuid)
        const content = m.message?.content ?? []
        joinReport.assistantBlocks.push({
          messageId: m.message?.id,
          uuid: m.uuid,
          parentToolUseId: m.parent_tool_use_id,
          types: content.map((c: any) => c.type),
          textLens: content.map((c: any) => (c.text ?? c.thinking ?? '').length),
        } as any)
        console.log(
          `[capture] assistant msgId=${m.message?.id} uuid=${m.uuid} parent=${m.parent_tool_use_id} blocks=[${content
            .map((c: any) => c.type)
            .join(',')}]`,
        )
      }

      if (msg.type === 'user') {
        const m = msg as any
        const content = m.message?.content
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'tool_result') {
              console.log(
                `[capture] tool_result toolUseId=${c.tool_use_id} isError=${c.is_error} ` +
                  `structured=${m.tool_use_result === undefined ? 'ABSENT' : 'PRESENT'} parent=${m.parent_tool_use_id}`,
              )
            }
          }
        }
      }

      if (msg.type === 'result') {
        resultCount++
        lastResult = msg as any
        const r = msg as any
        console.log(
          `[capture] result #${resultCount} subtype=${r.subtype} is_error=${r.is_error} ` +
            `terminal_reason=${r.terminal_reason} queued=${r.queued_turn_count}`,
        )
      }
    }
  })()

  // ------------------------------------------------------------- scenarios

  const turn = async (name: string, prompt: string, waitMs = 180_000) => {
    tag(name)
    const before = resultCount
    const uuid = queue.push(prompt)
    record({ kind: 'push', prompt, uuid })
    const ok = await until(() => resultCount > before, waitMs)
    if (!ok) console.log(`[capture] !! ${name} did not produce a result within ${waitMs}ms`)
    return ok
  }

  // 1. plain text + thinking: every stream_event kind, plus the join question.
  await turn('text', 'Think briefly, then count from 1 to 12, one number per line. Nothing else.')

  // 2. bash success AND failure in one turn: the exit-code source.
  await turn(
    'bash',
    'Run these two shell commands and report both outputs: first `ls -la`, then `exit 3` (or any command that exits non-zero).',
  )

  // 3. write a new file -> does tool_use_result carry structuredPatch?
  await turn('write', 'Create a file named capture-demo.txt containing the single line hello world.')

  // 4. edit it -> FileEditOutput.structuredPatch
  await turn('edit', 'In capture-demo.txt, replace the word hello with goodbye.')

  // 5. TodoWrite -> PlanStep mapping
  await turn('todo', 'Use the todo list to plan three steps for baking bread, then stop. Do not actually do them.')

  // 6. subagent -> parent_tool_use_id population + main-thread Task result
  await turn('subagent', 'Use a subagent to count the files in the current directory, then tell me the number.')

  // 7. steer: two pushes in quick succession. Folds, or two results?
  tag('steer')
  {
    const before = resultCount
    const u1 = queue.push('Count slowly from 1 to 40, one number per line.')
    await until(() => resultCount > before, 5_000) // let it start
    await new Promise((r) => setTimeout(r, 400))
    const u2 = queue.push('Actually, stop counting and just say DONE.')
    record({ kind: 'push', prompt: 'steer second message', uuid: u2, first: u1 })
    await until(() => resultCount > before, 120_000)
    // Give a possible folded second turn a moment to land.
    await new Promise((r) => setTimeout(r, 3_000))
  }

  // 8. interrupt
  tag('interrupt')
  {
    const before = resultCount
    queue.push('Count slowly from 1 to 400, one number per line. Nothing else.')
    await until(() => true, 3_000)
    const receipt = await q.interrupt()
    record({ kind: 'interrupt', receipt })
    console.log(`[capture] interrupt receipt=${JSON.stringify(receipt)}`)
    await until(() => resultCount > before, 60_000)
  }

  // -------------------------------------------------- transcript + join check
  await until(() => true, 1_000)
  queue.close()
  q.close()
  await consume.catch(() => {})

  tag('session-messages')
  try {
    const messages = await getSessionMessages(sessionId, { dir: CWD })
    record({ kind: 'session-messages', sessionId, cwd: CWD, count: messages.length, messages })
    console.log(`[capture] getSessionMessages -> ${messages.length} messages`)
  } catch (err) {
    record({ kind: 'session-messages-error', message: (err as Error).message })
    console.log(`[capture] getSessionMessages FAILED: ${(err as Error).message}`)
  }

  tag('join')
  const joinResult = {
    messageStartIds: [...joinReport.messageStartIds],
    assistantMessageIds: [...joinReport.assistantMessageIds],
    idsIntersect: [...joinReport.messageStartIds].some((id) => joinReport.assistantMessageIds.has(id)),
    streamEventUuidCount: joinReport.streamEventUuids.size,
    assistantUuidCount: joinReport.assistantUuids.size,
    uuidsIntersect: [...joinReport.streamEventUuids].some((u) => joinReport.assistantUuids.has(u)),
    streamedBlocks: joinReport.streamedBlocks.length,
    assistantBlocks: joinReport.assistantBlocks.length,
    sampleAssistantBlocks: joinReport.assistantBlocks.slice(0, 12),
  }
  record({ kind: 'join-report', ...joinResult })
  console.log('\n[capture] ==== JOIN REPORT ====')
  console.log(JSON.stringify(joinResult, null, 2))

  out.end()
  await new Promise<void>((resolve) => out.on('close', () => resolve()))
  console.log(`\n[capture] wrote ${OUT}`)
  process.exit(0)
}

let lastStreamMessageId: string | undefined

async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

main().catch((err) => {
  console.error('\n[capture] FATAL:', err)
  out.end()
  process.exit(1)
})
