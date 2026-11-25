import { describe, expect, it } from 'vitest'
import type { AgentItem } from '@vibemobile/protocol'
import { codexItemPage, type HistoryTurn } from './itemPage.js'

const msg = (id: string, text = id): AgentItem => ({ kind: 'message', role: 'user', id, text })
const turn = (id: string, count: number) => ({
  id,
  status: 'completed' as const,
  completedAt: 1700000000,
  items: Array.from({ length: count }, (_, i) => msg(id + i)),
})
function fixture(turns: ReturnType<typeof turn>[], legacy = false, extras: AgentItem[] = []) {
  let fullReads = 0
  async function rpc<T>(method: string, input: object): Promise<T> {
    const p = input as { turnId?: string; itemsView?: string; cursor?: string; limit: number }
    if (method === 'thread/turns/list') {
      const i = p.cursor ? turns.findIndex((t) => t.id === p.cursor) : turns.length - 1
      const t = turns[i]
      if (p.itemsView === 'full') fullReads++
      return {
        data: t ? [{ ...t, items: p.itemsView === 'full' ? t.items : [] }] : [],
        backwardsCursor: t?.id,
        nextCursor: turns[i - 1]?.id,
      } as T
    }
    if (legacy) throw Object.assign(new Error('Method not found'), { code: -32601 })
    const items = turns.find((t) => t.id === p.turnId)!.items
    const end = p.cursor ? Number(p.cursor.slice(1)) : items.length
    const start = Math.max(0, end - p.limit)
    return {
      data: items
        .slice(start, end)
        .reverse()
        .map((item) => ({ item })),
      nextCursor: start ? 'i' + start : null,
      backwardsCursor: 'i' + end,
    } as T
  }
  const read = (limit: number, cursor?: string, thread = 's') =>
    codexItemPage(
      rpc,
      thread,
      limit,
      cursor,
      (item) => item as AgentItem,
      (_t: HistoryTurn) => extras,
    )
  return { read, fullReads: () => fullReads }
}
describe('Codex item pages', () => {
  it.each([false, true])('covers every item exactly once despite appends (legacy=%s)', async (legacy) => {
    const turns = [turn('older', 3), turn('long', 5274)]
    const f = fixture(turns, legacy)
    const expected = turns.flatMap((t) => t.items.map((i) => i.id))
    let page = await f.read(60)
    expect(page.turns[0]).toMatchObject({ id: 'long', hasEarlierItems: true, completedAt: 1700000000000 })
    expect(page.turns[0].items).toHaveLength(60)
    turns[1].items.push(msg('appended'))
    turns.push(turn('later', 2))
    const actual: string[] = []
    const seen = new Set<string>()
    for (;;) {
      const ids = page.turns.flatMap((t) => t.items.map((i) => i.id))
      expect(ids.length).toBeLessThanOrEqual(60)
      actual.unshift(...ids)
      if (!page.nextCursor) break
      expect(seen.has(page.nextCursor)).toBe(false)
      seen.add(page.nextCursor)
      page = await f.read(60, page.nextCursor)
    }
    expect(actual).toEqual(expected)
    if (!legacy) expect(f.fullReads()).toBe(0)
  })
  it('cuts a page at its byte budget without losing the boundary item or an oversized item', async () => {
    const t = turn('a', 0)
    t.items = [msg('old'), msg('large', 'x'.repeat(600000)), msg('b', 'x'.repeat(300000)), msg('c', 'x'.repeat(300000))]
    const f = fixture([t])
    let p = await f.read(60)
    for (const id of ['c', 'b', 'large', 'old']) {
      expect(p.turns.flatMap((t) => t.items.map((i) => i.id))).toEqual([id])
      if (p.nextCursor) p = await f.read(60, p.nextCursor)
    }
    expect(p.nextCursor).toBeNull()
  })
  it('paginates diagnostics once, even at a one-item boundary', async () => {
    const f = fixture([turn('t', 1)], false, [msg('retry'), msg('err')])
    let p = await f.read(1)
    for (const id of ['err', 'retry', 't0']) {
      expect(p.turns[0].items.map((i) => i.id)).toEqual([id])
      if (p.nextCursor) p = await f.read(1, p.nextCursor)
    }
    expect(p.nextCursor).toBeNull()
  })
  it('preserves empty turns and prior turn cursors and rejects invalid or cross-session partial cursors', async () => {
    const f = fixture([turn('a', 0), turn('b', 3)])
    expect((await f.read(1, 'a')).turns[0].items).toEqual([])
    const p = await f.read(1)
    await expect(f.read(1, p.nextCursor!, 'other')).rejects.toMatchObject({ statusCode: 400 })
    await expect(f.read(1, 'ci1.bad')).rejects.toMatchObject({ statusCode: 400 })
  })
})
