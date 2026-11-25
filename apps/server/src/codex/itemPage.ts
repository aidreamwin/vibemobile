import type { AgentItem, TranscriptTurn } from '@vibemobile/protocol'
import { PAGE_ITEM_BYTES } from '../providers/page.js'

type Position = string | number | null
interface Cursor {
  thread: string
  turn: string
  anchor: string | null
  item: Position
  tail: number
}
export interface HistoryTurn {
  id: string
  status: TranscriptTurn['status']
  error?: { message?: string } | null
  startedAt?: number | null
  completedAt?: number | null
  durationMs?: number | null
  items?: unknown[]
}
interface List<T> {
  data: T[]
  nextCursor?: string | null
  backwardsCursor?: string | null
}
type Request = <T>(method: string, params: object) => Promise<T>
const PREFIX = 'ci1.'

export function turnTime(value?: number | null) {
  return value ? Math.round(value < 1e12 ? value * 1000 : value) : null
}

function badCursor() {
  return Object.assign(new Error('invalid transcript cursor; reopen the session'), { statusCode: 400 })
}
function decode(value: string | undefined, thread: string): Cursor | undefined {
  if (!value?.startsWith(PREFIX)) return undefined // Existing native turn cursors remain valid at turn boundaries.
  try {
    if (value.length > 12_000) throw badCursor()
    const c: Cursor = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString())
    if (
      c.thread !== thread ||
      typeof c.turn !== 'string' ||
      !c.turn ||
      !(c.anchor === null || typeof c.anchor === 'string') ||
      !(c.item === null || typeof c.item === 'string' || (Number.isSafeInteger(c.item) && Number(c.item) >= 0)) ||
      !Number.isSafeInteger(c.tail) ||
      c.tail < 0 ||
      c.tail > 2
    )
      throw badCursor()
    return c
  } catch {
    throw badCursor()
  }
}
const encode = (c: Cursor) => PREFIX + Buffer.from(JSON.stringify(c)).toString('base64url')

function noItemPagination(err: unknown) {
  const e = err as { code?: number; message?: string }
  return (
    e.code === -32601 ||
    /(?:item pagination|thread\/items\/list).*(?:not supported|unsupported|unavailable|legacy)|(?:does not support|unsupported|unknown (?:method|variant)).*(?:item pagination|thread\/items\/list)/i.test(
      e.message ?? '',
    )
  )
}

/** Read newest first, but return each fragment in UI (chronological) order. */
export async function codexItemPage(
  rpc: Request,
  thread: string,
  limit: number,
  cursor: string | undefined,
  normalize: (item: unknown) => AgentItem,
  diagnostics: (turn: HistoryTurn) => AgentItem[],
) {
  let part = decode(cursor, thread)
  let turnCursor = part ? part.anchor : (cursor ?? null)
  const turns: TranscriptTurn[] = []
  let slots = limit
  let bytes = 0
  let nextCursor: string | null = null

  // Bound local round trips for histories with many tiny (or empty) turns.
  for (let i = 0; i < 8 && slots > 0 && bytes < PAGE_ITEM_BYTES; i++) {
    const turnParams = {
      threadId: thread,
      limit: 1,
      sortDirection: 'desc',
      ...(turnCursor ? { cursor: turnCursor } : {}),
    }
    const meta = await rpc<List<HistoryTurn>>('thread/turns/list', { ...turnParams, itemsView: 'notLoaded' })
    const turn = meta.data[0]
    if (part && turn?.id !== part.turn) throw badCursor()
    if (!turn) {
      nextCursor = null
      break
    }
    const anchor = meta.backwardsCursor ?? turnCursor
    const tail = diagnostics(turn).slice(0, part?.tail).reverse()
    const pos = part?.item ?? null
    let legacy: unknown[] | undefined
    async function readItems(
      size: number,
      at: Position,
    ): Promise<{ data: unknown[]; next: Position; start: Position }> {
      if (typeof at !== 'number' && !legacy) {
        try {
          const r = await rpc<List<{ item: unknown }>>('thread/items/list', {
            threadId: thread,
            turnId: turn.id,
            sortDirection: 'desc',
            limit: size,
            ...(at ? { cursor: at } : {}),
          })
          return { data: r.data.map((x) => x.item), next: r.nextCursor ?? null, start: r.backwardsCursor ?? at }
        } catch (err) {
          if (at !== null || !noItemPagination(err)) throw err
        }
      }
      // Legacy stores only expose whole turns locally. Slice BEFORE mapping/forwarding.
      if (!legacy) {
        const r = await rpc<List<HistoryTurn>>('thread/turns/list', {
          ...turnParams,
          ...(anchor ? { cursor: anchor } : {}),
          itemsView: 'full',
        })
        if (r.data[0]?.id !== turn.id) throw badCursor()
        legacy = r.data[0].items ?? []
      }
      const end = typeof at === 'number' ? at : legacy.length
      if (end > legacy.length) throw badCursor()
      const start = Math.max(0, end - size)
      return { data: legacy.slice(start, end).reverse(), next: start || null, start: end }
    }
    const raw = await readItems(Math.max(1, slots - tail.length), pos)
    const candidates = [...tail, ...raw.data.map(normalize)]
    let used = 0
    for (const item of candidates) {
      const size = Buffer.byteLength(JSON.stringify(item)) + 1
      if (used === slots || (bytes > 0 && bytes + size > PAGE_ITEM_BYTES)) break
      bytes += size
      used++
    }
    const usedRaw = Math.max(0, used - tail.length)
    let nextItem = raw.next
    if (usedRaw < raw.data.length) {
      // Ask for the exact boundary, anchored so a concurrently appended item cannot shift it.
      nextItem = usedRaw ? (await readItems(usedRaw, raw.start)).next : raw.start
    }
    const moreHere = used < tail.length || usedRaw < raw.data.length || nextItem !== null
    if (used || candidates.length === 0) {
      turns.unshift({
        id: turn.id,
        status: turn.status,
        items: candidates.slice(0, used).reverse(),
        startedAt: turnTime(turn.startedAt),
        completedAt: turnTime(turn.completedAt),
        durationMs: turn.durationMs ?? null,
        ...(moreHere ? { hasEarlierItems: true } : {}),
      })
    }
    slots -= used
    if (moreHere) {
      nextCursor = encode({ thread, turn: turn.id, anchor, item: nextItem, tail: Math.max(0, tail.length - used) })
      break
    }
    nextCursor = meta.nextCursor ?? null
    if (!nextCursor) break
    if (nextCursor === turnCursor) throw badCursor()
    turnCursor = nextCursor
    part = undefined
  }
  if (nextCursor && nextCursor === cursor) throw badCursor()
  return { turns, nextCursor, ...(nextCursor ? { hasMore: true } : {}) }
}
