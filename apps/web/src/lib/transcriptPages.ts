import type { Transcript, TranscriptTurn } from '@vibemobile/protocol'

/** Walk opaque cursors, then join fragments of the same turn in chronological order. */
export async function exportTurns(
  read: (cursor?: string) => Promise<Transcript>,
  partial?: { visible: TranscriptTurn; olderCursor: string },
): Promise<TranscriptTurn[]> {
  const pages: TranscriptTurn[][] = partial ? [[partial.visible]] : []
  const visited = new Set<string>()
  let cursor = partial?.olderCursor
  for (;;) {
    if (cursor && visited.has(cursor)) throw new Error('历史分页游标重复，导出已停止。')
    if (cursor) visited.add(cursor)
    const page = await read(cursor)
    const group = partial ? page.turns.filter((t) => t.id === partial.visible.id) : page.turns
    if (partial && !group.length) throw new Error('历史记录已变化，请重新打开会话后导出。')
    pages.push(group)
    if (partial && !group[0].hasEarlierItems) break
    if (!page.hasMore && !partial) break
    if (!page.nextCursor) throw new Error('无法读取更早的历史，导出未完成。')
    cursor = page.nextCursor
  }
  const seen = new Set<string>()
  const turns: TranscriptTurn[] = []
  for (const group of pages.reverse()) {
    for (const turn of group) {
      const items = turn.items.filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
      if (!items.length) continue
      const last = turns.at(-1)
      if (last?.id === turn.id) last.items.push(...items)
      else turns.push({ ...turn, items })
    }
  }
  return turns
}
