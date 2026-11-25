import type { AgentItem, TranscriptTurn } from '@vibemobile/protocol'
import { describe, expect, it } from 'vitest'
import { liveReplayTail, PAGE_ITEM_BYTES, transcriptPage, type PageRequest } from './page.js'

const message = (id: string, text = id): AgentItem => ({ id, kind: 'message', role: 'assistant', text })
const turn = (id: string, n: number): TranscriptTurn => ({
  id,
  status: 'completed',
  items: Array.from({ length: n }, (_, i) => message(`${id}.${i}`)),
})
const ids = (turns: TranscriptTurn[]) => turns.flatMap((t) => t.items.map((i) => i.id))
function next(page: { nextCursor: string | null }): string {
  if (!page.nextCursor) throw new Error('expected an older page')
  return page.nextCursor
}
const read = (turns: TranscriptTurn[], opts: PageRequest, session = 'session') =>
  transcriptPage(session, 'c:', opts, async function* () {
    for (let t = turns.length - 1; t >= 0; t--) yield { turn: turns[t], hasOlder: t > 0 }
  })

describe('transcript pages', () => {
  it('drains 137 items within a turn, then fills the last page with the older turn', async () => {
    const turns = [turn('older', 5), turn('long', 137)]
    const pages: TranscriptTurn[][] = []
    let cursor: string | undefined
    do {
      const page = await read(turns, { targetItems: 60, cursor })
      expect(page.hasMore).toBe(!!page.nextCursor)
      expect(page.turns[0].hasEarlierItems).toBe(page.hasMore ? true : undefined)
      pages.unshift(page.turns)
      cursor = page.nextCursor ?? undefined
    } while (cursor && pages.length < 4)
    expect(pages.map((p) => ids(p).length)).toEqual([22, 60, 60])
    expect(pages.flatMap(ids)).toEqual(ids(turns))
  })

  it('keeps a stable boundary when both new items and a new turn arrive', async () => {
    const turns = [turn('older', 1), turn('live', 5)]
    const first = await read(turns, { targetItems: 2 })
    turns[1].items.push(message('later'))
    turns.push(turn('newer', 2))
    const older = await read(turns, { targetItems: 4, cursor: next(first) })
    expect(ids(older.turns)).toEqual(['older.0', 'live.0', 'live.1', 'live.2'])
    expect(older.hasMore).toBe(false)
  })

  it('budgets UTF-8 bytes across turns and delivers even an oversized item exactly once', async () => {
    const turns = [turn('a', 1), turn('b', 0)]
    turns[1].items.push(message('jumbo', '界'.repeat(PAGE_ITEM_BYTES / 2)), message('small'))
    const first = await read(turns, { targetItems: 60 })
    const middle = await read(turns, { targetItems: 60, cursor: next(first) })
    const oldest = await read(turns, { targetItems: 60, cursor: next(middle) })
    expect([oldest, middle, first].map((p) => ids(p.turns))).toEqual([['a.0'], ['jumbo'], ['small']])
    expect(first.turns[0].hasEarlierItems).toBe(true)
    expect(middle.turns[0].hasEarlierItems).toBeUndefined()
    expect(oldest.nextCursor).toBeNull()
    expect(liveReplayTail(turns[1].items).map((i) => i.id)).toEqual(['small'])
    expect(liveReplayTail(turn('live', 137).items)).toHaveLength(60)
  })

  it('preserves empty turns and old whole-turn cursors', async () => {
    const turns = [turn('older', 4), turn('empty', 0)]
    const first = await read(turns, { targetItems: 1 })
    expect(first.turns).toEqual([turns[1]])
    expect(ids((await read(turns, { cursor: next(first) })).turns)).toEqual(ids([turns[0]]))
    expect(await read(turns, { limit: 1 })).toMatchObject({ turns: [turns[1]], nextCursor: 'c:1' })
    expect(ids((await read(turns, { cursor: 'c:1', targetItems: 2 })).turns)).toEqual(['older.2', 'older.3'])
    expect((await read([], { targetItems: 2 })).nextCursor).toBeNull()
  })

  it('rejects malformed, foreign and missing anchors instead of restarting the newest page', async () => {
    const turns = [turn('long', 4)]
    const first = await read(turns, { targetItems: 2 })
    const opts = { targetItems: 2, cursor: next(first) }
    await expect(read(turns, { ...opts, cursor: 'tp1.eA' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(read(turns, opts, 'other')).rejects.toMatchObject({ statusCode: 400 })
    await expect(read([], opts)).rejects.toMatchObject({ statusCode: 400 })
    turns[0].items.splice(2, 1)
    await expect(read(turns, opts)).rejects.toMatchObject({ statusCode: 400 })
  })
})
