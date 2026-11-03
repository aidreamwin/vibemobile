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
import { pageTurnsByItems } from '../providers/page.js'
import type {
  OpencodeAssistantMessage,
  OpencodeCompactionMessage,
  OpencodeMessage,
  OpencodeMessageList,
  OpencodeShellMessage,
  OpencodeToolPart,
  OpencodeToolState,
  OpencodeUserMessage,
} from './types.js'

export const CURSOR_PREFIX = 'oc:'

export function parseCursor(cursor: string | undefined): number {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return 0
  const value = Number(cursor.slice(CURSOR_PREFIX.length))
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export function formatCursor(skip: number): string {
  return `${CURSOR_PREFIX}${skip}`
}

function toolStatus(state: OpencodeToolState): ItemStatus {
  if (state.status === 'completed') return 'done'
  if (state.status === 'error') return 'failed'
  return 'running'
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const value = part as { type?: unknown; text?: unknown; uri?: unknown }
      if (value.type === 'text' && typeof value.text === 'string') return value.text
      if (value.type === 'file' && typeof value.uri === 'string') return value.uri
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function inputOf(state: OpencodeToolState): unknown {
  if (state.status === 'streaming') return state.input
  return state.input
}

function shellCommandOf(part: OpencodeToolPart): string {
  const state = part.state
  if (state.status === 'streaming') return state.input
  const input = state.input as Record<string, unknown>
  const value = input.command ?? input.cmd ?? input.script
  return typeof value === 'string' ? value : ''
}

function shellName(name: string): boolean {
  return /(^|_)(bash|shell|execute|terminal|command)$/i.test(name) || /^(bash|shell|execute)$/i.test(name)
}

function commandItem(part: OpencodeToolPart, cwd: string | undefined): AgentItem {
  const state = part.state
  const metadata =
    state.status === 'running' || state.status === 'completed' || state.status === 'error' ? state.metadata : undefined
  const exitCandidate = metadata?.exitCode ?? metadata?.exit
  const exitCode = typeof exitCandidate === 'number' ? exitCandidate : null
  const output = state.status === 'completed' || state.status === 'error' ? textOf(state.content) : ''
  return {
    kind: 'command',
    id: `oc:tool:${part.id}`,
    command: shellCommandOf(part),
    ...(cwd ? { cwd } : {}),
    status: toolStatus(state),
    output,
    exitCode,
  }
}

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

function toolItem(part: OpencodeToolPart, cwd: string | undefined): AgentItem {
  if (shellName(part.name)) return commandItem(part, cwd)
  const state = part.state
  return {
    kind: 'tool',
    id: `oc:tool:${part.id}`,
    name: part.name,
    title: part.name,
    status: toolStatus(state),
    input: inputOf(state),
    ...(state.status === 'completed' || state.status === 'error' ? { output: textOf(state.content) } : {}),
    ...(state.status === 'error' ? { error: state.error.message } : {}),
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
      items.push(toolItem(part, cwd))
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

export interface PageRequest {
  limit?: number
  targetItems?: number
  cursor?: string
}

export interface FetchedTranscript {
  turns: TranscriptTurn[]
  nextCursor: string | null
  hasMore: boolean
}

export type MessagePageFetcher = (opts: {
  order?: 'asc' | 'desc'
  cursor?: string
  limit?: number
}) => Promise<OpencodeMessageList>

const MESSAGE_PAGE_SIZE = 100
const MAX_PAGES = 40

/**
 * Fetch and page a transcript.
 *
 * A cursor is a count of turns skipped from the newest end (`oc:<n>`), not
 * opencode's opaque message cursor. The API's cursors are message-level and a
 * page can cut a turn in half; counting turns lets every returned page end on a
 * turn boundary without guessing the API's anchor semantics. The cost is
 * re-reading the newer turns on a deep page, which is a localhost request.
 */
export async function fetchTranscript(fetchPage: MessagePageFetcher, opts: PageRequest): Promise<FetchedTranscript> {
  const skip = parseCursor(opts.cursor)
  const wanted = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 60
  let desc: OpencodeMessage[] = []
  let cursor: string | undefined
  let exhausted = false
  let pages = 0
  let turns: TranscriptTurn[] = []

  while (pages < MAX_PAGES) {
    const page = await fetchPage(
      cursor ? { cursor, limit: MESSAGE_PAGE_SIZE } : { order: 'desc', limit: MESSAGE_PAGE_SIZE },
    )
    pages++
    if (page.data.length === 0) {
      exhausted = true
      break
    }
    desc = desc.concat(page.data)
    turns = messagesToTurns(desc.slice().reverse())
    if (!page.cursor.next) {
      exhausted = true
      break
    }
    cursor = page.cursor.next
    // The oldest fetched turn may have started mid-turn (the page boundary cut
    // it). Even when the turn count is enough, read one more page so the page
    // we return starts on a user message.
    const leadingComplete =
      turns.length === 0 || turns[0]?.items.some((item) => item.kind === 'message' && item.role === 'user')
    if (pageComplete(turns, skip, opts, wanted) && leadingComplete) break
  }

  const page = pickPage(turns, skip, opts, wanted)
  const pageTurns = turns.slice(page.start, page.end)
  const hasMore = (page.start > 0 || !exhausted) && pageTurns.length > 0
  return {
    turns: pageTurns,
    nextCursor: hasMore ? formatCursor(skip + pageTurns.length) : null,
    hasMore,
  }
}

/**
 * Whether the fetched turns already contain a whole page plus a hint that an
 * older one exists. One extra turn (or the API's next cursor) is what makes
 * `hasMore` truthful without fetching the entire history.
 */
function pageComplete(turns: readonly TranscriptTurn[], skip: number, opts: PageRequest, wanted: number): boolean {
  const available = turns.length - skip
  if (available <= 0) return false
  if (opts.targetItems && opts.targetItems > 0) {
    const page = pageTurnsByItems(turns, opts.targetItems, skip)
    return page.start > 0 || page.items >= opts.targetItems
  }
  return available >= wanted
}

function pickPage(
  turns: readonly TranscriptTurn[],
  skip: number,
  opts: PageRequest,
  wanted: number,
): { start: number; end: number } {
  const end = Math.max(0, Math.min(turns.length, turns.length - skip))
  if (opts.targetItems && opts.targetItems > 0) {
    return pageTurnsByItems(turns, opts.targetItems, skip)
  }
  return { start: Math.max(0, end - wanted), end }
}
