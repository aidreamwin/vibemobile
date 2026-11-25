/**
 * opencode messages -> normalized transcript turns.
 *
 * The API returns a flat, message-level list. A turn is not a field there, so
 * the boundary has to be reconstructed: a `user` message opens a turn, an
 * `idle` message closes it, and every assistant/tool/shell/compaction message
 * in between belongs to it. A steered message arrives before the `idle` and is
 * appended to the open turn, exactly like a Codex interjection.
 *
 * Pure on purpose: the fetch loop lives in `fetchTranscript`, which takes the
 * page fetcher as an argument, so grouping and paging can be tested without a
 * server.
 */
import type { AgentItem, ItemStatus, TranscriptTurn, TurnStatus } from '@vibemobile/protocol'
import { transcriptPage, type HistoryEntry, type PageRequest } from '../providers/page.js'
import { toolItem } from './tools.js'
import type {
  OpencodeAssistantMessage,
  OpencodeCompactionMessage,
  OpencodeMessage,
  OpencodeMessageList,
  OpencodeShellMessage,
  OpencodeUserMessage,
} from './types.js'

function retryItem(message: OpencodeAssistantMessage): AgentItem | null {
  if (!message.retry) return null
  const at = Number.isFinite(message.retry.at) ? new Date(message.retry.at).toISOString() : undefined
  return {
    kind: 'retry',
    id: `oc:retry:${message.id}:${message.retry.attempt}`,
    attempts: [
      {
        attempt: message.retry.attempt,
        message: message.retry.error.message,
        ...(at ? { at } : {}),
      },
    ],
  }
}

function assistantItems(message: OpencodeAssistantMessage, cwd: string | undefined): AgentItem[] {
  const items: AgentItem[] = []
  let textOrdinal = 0
  let reasoningOrdinal = 0
  for (const part of message.content) {
    if (part.type === 'text') {
      items.push({ kind: 'message', id: `oc:text:${message.id}:${textOrdinal++}`, role: 'assistant', text: part.text })
    } else if (part.type === 'reasoning') {
      items.push({
        kind: 'reasoning',
        id: `oc:reasoning:${message.id}:${reasoningOrdinal++}`,
        summary: [],
        content: [part.text],
      })
    } else {
      items.push(toolItem(part.id, part.name, part.state, cwd))
    }
  }
  const retry = retryItem(message)
  if (retry) items.push(retry)
  if (message.error) {
    items.push({ kind: 'error', id: `oc:error:${message.id}`, message: message.error.message })
  }
  return items
}

function userItem(message: OpencodeUserMessage): AgentItem {
  return {
    kind: 'message',
    id: `oc:user:${message.id}`,
    role: 'user',
    text: message.text,
    at: message.time.created,
  }
}

function shellItem(message: OpencodeShellMessage): AgentItem {
  const status: ItemStatus =
    message.status === 'exited'
      ? 'done'
      : message.status === 'killed'
        ? 'declined'
        : message.status === 'timeout'
          ? 'failed'
          : 'running'
  return {
    kind: 'command',
    id: `oc:shell:${message.shellID || message.id}`,
    command: message.command,
    status,
    output: message.output?.output ?? '',
    ...(typeof message.exit === 'number' ? { exitCode: message.exit } : {}),
  }
}

function compactionItem(message: OpencodeCompactionMessage): AgentItem {
  return {
    kind: 'compaction',
    id: `oc:compaction:${message.id}`,
    status: message.status === 'completed' ? 'done' : message.status === 'failed' ? 'failed' : 'running',
    trigger: message.reason,
  }
}

interface TurnBuilder {
  turn: TranscriptTurn
  closed: boolean
}

function startTurn(id: string, at: number): TurnBuilder {
  return {
    turn: { id, status: 'inProgress', items: [], startedAt: at },
    closed: false,
  }
}

function finishStatus(message: OpencodeAssistantMessage): TurnStatus | null {
  if (message.error) return 'failed'
  if (message.finish === 'error') return 'failed'
  return null
}

/**
 * Group ascending messages into turns.
 *
 * `messages` MUST be oldest-first. The provider reverses the API's desc pages
 * before calling this.
 */
export function messagesToTurns(messages: readonly OpencodeMessage[], opts: { cwd?: string } = {}): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  let current: TurnBuilder | null = null
  let lastMessage: OpencodeMessage | null = null

  const open = (): TurnBuilder => {
    if (!current) {
      current = startTurn(`oc:turn:${lastMessage?.id ?? 'synthetic'}`, lastMessage?.time.created ?? Date.now())
      turns.push(current.turn)
    }
    return current
  }

  for (const message of messages) {
    lastMessage = message
    if (message.type === 'user') {
      if (!current || current.closed) {
        current = startTurn(`oc:turn:${message.id}`, message.time.created)
        turns.push(current.turn)
      }
      current.turn.items.push(userItem(message))
      continue
    }

    if (message.type === 'idle') {
      const builder = open()
      builder.turn.status = message.outcome === 'succeeded' ? 'completed' : message.outcome
      builder.turn.completedAt = message.time.created
      if (builder.turn.startedAt != null) {
        builder.turn.durationMs = Math.max(0, message.time.created - builder.turn.startedAt)
      }
      builder.closed = true
      current = builder
      continue
    }

    if (message.type === 'assistant') {
      const builder = open()
      for (const item of assistantItems(message, opts.cwd)) builder.turn.items.push(item)
      const status = finishStatus(message)
      if (status) builder.turn.status = status
      builder.turn.completedAt = message.time.completed ?? message.time.created
      if (builder.turn.startedAt != null) {
        builder.turn.durationMs = Math.max(0, (message.time.completed ?? message.time.created) - builder.turn.startedAt)
      }
      continue
    }

    if (message.type === 'shell') {
      open().turn.items.push(shellItem(message))
      continue
    }

    if (message.type === 'compaction') {
      open().turn.items.push(compactionItem(message))
    }

    // system / synthetic / skill / switched-*: nothing renders, and they must
    // not open a turn of their own.
  }

  // A final turn with no `idle`: a closed later turn cannot exist without one,
  // so only the last builder can still be open. Leave it inProgress; the mapper
  // will complete it when the live execution ends, and a stale historical turn
  // is better shown as in-progress than as a lie.
  return turns
}

export type MessagePageFetcher = (opts: {
  order?: 'asc' | 'desc'
  cursor?: string
  limit?: number
}) => Promise<OpencodeMessageList>

const MESSAGE_PAGE_SIZE = 100

/** An idle before the oldest user in the buffer proves that user opened the turn (and wasn't a steer). */
async function* messageHistory(fetchPage: MessagePageFetcher, source?: string): AsyncGenerator<HistoryEntry> {
  const pending: { message: OpencodeMessage; source?: string }[] = []
  const visited = new Set<string>()
  let oldestUser = -1

  function consume(count: number, hasOlder: boolean) {
    const records = pending.splice(0, count)
    const bookmark = records[0]?.source
    const [turn] = messagesToTurns(records.reverse().map((record) => record.message))
    return turn ? { turn, hasOlder, source: bookmark } : undefined
  }

  for (;;) {
    const page = await fetchPage(
      source ? { cursor: source, limit: MESSAGE_PAGE_SIZE } : { order: 'desc', limit: MESSAGE_PAGE_SIZE },
    )
    for (const message of page.data) {
      if (message.type === 'idle' && oldestUser >= 0) {
        const entry = consume(oldestUser + 1, true)
        if (entry) yield entry
        oldestUser = -1
      }
      if (message.type === 'user') oldestUser = pending.length
      pending.push({ message, source })
    }
    const next = page.cursor.next
    if (!next) break
    if (next === source || visited.has(next)) throw new Error('OpenCode repeated a message cursor')
    visited.add(next)
    source = next
  }
  const oldest = consume(pending.length, false)
  if (oldest) yield oldest
}

export function fetchTranscript(
  fetchPage: MessagePageFetcher,
  opts: PageRequest & { sessionId?: string },
  live?: TranscriptTurn,
) {
  return transcriptPage(opts.sessionId ?? '', 'oc:', { limit: 60, ...opts }, async function* (_, source) {
    let pending = source ? undefined : live
    for await (const entry of messageHistory(fetchPage, source)) {
      if (pending) {
        if (pending.id === entry.turn.id) {
          const persisted = new Set(entry.turn.items.map((item) => item.id))
          for (const item of pending.items) if (!persisted.has(item.id)) entry.turn.items.push(item)
        } else yield { turn: pending, hasOlder: true }
        pending = undefined
      }
      yield entry
    }
    if (pending) yield { turn: pending, hasOlder: false }
  })
}
