import type { AgentItem, TranscriptTurn } from '@vibemobile/protocol'

export const DEFAULT_PAGE_ITEMS = 60
export const PAGE_ITEM_BYTES = 512 * 1024
const PREFIX = 'tp1.'
const MAX_DEPTH_HINT = 10_000

export interface PageRequest {
  limit?: number
  targetItems?: number
  cursor?: string
}

interface Anchor {
  scope: string
  turn: string
  /** Exclusive item ID, or null to continue before this whole turn. */
  before: string | null
  depth: number
  source?: string
}

export interface HistoryEntry {
  turn: TranscriptTurn
  hasOlder: boolean
  /** Provider bookmark for replaying this turn (native message page or live mapper). */
  source?: string
}

function invalidCursor() {
  return Object.assign(new Error('invalid transcript cursor; reopen the session'), { statusCode: 400 })
}

function decode(value: string | undefined, scope: string): Anchor | undefined {
  if (!value?.startsWith(PREFIX)) return undefined
  try {
    if (value.length > 12_000) throw invalidCursor()
    const anchor: Anchor = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString())
    if (
      anchor.scope !== scope ||
      typeof anchor.turn !== 'string' ||
      !anchor.turn ||
      !(anchor.before === null || typeof anchor.before === 'string') ||
      !Number.isSafeInteger(anchor.depth) ||
      anchor.depth < 0 ||
      anchor.depth > MAX_DEPTH_HINT ||
      !(anchor.source === undefined || typeof anchor.source === 'string')
    )
      throw invalidCursor()
    return anchor
  } catch {
    throw invalidCursor()
  }
}

function takeTail(items: AgentItem[], end: number, budget: { slots: number; bytes: number }): number {
  let start = end
  while (start > 0 && budget.slots > 0) {
    const size = Buffer.byteLength(JSON.stringify(items[start - 1])) + 1
    if (budget.bytes > 0 && budget.bytes + size > PAGE_ITEM_BYTES) break
    budget.bytes += size
    budget.slots--
    start--
  }
  return start
}

/** HTTP history provides older items. Replaying them all on subscribe would bypass paging. */
export function liveReplayTail(items: AgentItem[]): AgentItem[] {
  return items.slice(takeTail(items, items.length, { slots: DEFAULT_PAGE_ITEMS, bytes: 0 }))
}

/** Consume complete turns newest first, returning fragments in display order. */
export async function transcriptPage(
  sessionId: string,
  legacyPrefix: string,
  opts: PageRequest,
  history: (depthHint: number, source?: string, anchorTurn?: string) => AsyncIterable<HistoryEntry>,
) {
  const scope = legacyPrefix + sessionId
  const anchor = decode(opts.cursor, scope)
  const legacy = opts.cursor?.startsWith(legacyPrefix) ? Number(opts.cursor.slice(legacyPrefix.length)) : 0
  const skip = Number.isSafeInteger(legacy) && legacy >= 0 && legacy <= MAX_DEPTH_HINT ? legacy : 0
  const target = opts.targetItems ?? (anchor ? DEFAULT_PAGE_ITEMS : 0)
  const budget = { slots: target, bytes: 0 }
  const turns: TranscriptTurn[] = []
  let nextCursor: string | null = null
  let seeking = !!anchor
  let depth = -1

  for await (const { turn, source, hasOlder } of history(anchor?.depth ?? skip, anchor?.source, anchor?.turn)) {
    depth++
    let end = turn.items.length
    if (seeking && anchor) {
      if (turn.id !== anchor.turn) continue
      seeking = false
      if (anchor.before === null) continue
      end = turn.items.findIndex((item) => item.id === anchor.before)
      if (end < 0) throw invalidCursor()
      if (!end) continue
    } else if (depth < skip) continue

    if (!target) {
      turns.push(turn)
      nextCursor = hasOlder ? legacyPrefix + (depth + 1) : null
      if (turns.length >= (opts.limit ?? Infinity)) break
      continue
    }

    const start = takeTail(turn.items, end, budget)
    if (start === end && end > 0) break // The previous turn used the remaining byte budget.
    if (end === 0) budget.slots-- // Bound pages of empty turns as well.
    turns.push({ ...turn, items: turn.items.slice(start, end), ...(start > 0 ? { hasEarlierItems: true } : {}) })
    if (start > 0 || hasOlder) {
      const next: Anchor = {
        scope,
        turn: turn.id,
        before: start > 0 ? turn.items[start].id : null,
        depth: Math.min(depth, MAX_DEPTH_HINT),
        source,
      }
      nextCursor = PREFIX + Buffer.from(JSON.stringify(next)).toString('base64url')
    } else nextCursor = null
    if (start > 0 || !hasOlder || budget.slots <= 0 || budget.bytes >= PAGE_ITEM_BYTES) break
  }
  if (seeking) throw invalidCursor()
  return { turns: turns.reverse(), nextCursor, hasMore: !!nextCursor }
}
