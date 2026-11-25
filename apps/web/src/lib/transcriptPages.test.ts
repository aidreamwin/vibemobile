import { expect, it } from 'vitest'
import type { SessionSummary, Transcript, TranscriptTurn } from '@vibemobile/protocol'
import { exportTurns } from './transcriptPages'

const turn = (id: string, item: string, more = false): TranscriptTurn => ({
  id,
  status: 'completed',
  hasEarlierItems: more,
  items: [{ kind: 'message', role: 'user', id: item, text: item }],
})
const page = (turns: TranscriptTurn[], nextCursor?: string): Transcript => ({
  session: {} as SessionSummary,
  turns,
  nextCursor,
  hasMore: !!nextCursor,
})
it('exports a single turn over more than 100 pages without truncation', async () => {
  const [result] = await exportTurns(async (cursor) => {
    const n = cursor ? Number(cursor) : 121
    return page([turn('t', String(n), n > 0)], n ? String(n - 1) : undefined)
  })
  expect(result.items.map((i) => i.id)).toEqual(Array.from({ length: 122 }, (_, i) => String(i)))
})
it('exports just the missing fragments of the visible turn and stops before older turns', async () => {
  const turns = await exportTurns(
    async (cursor) => {
      if (cursor === 'a') return page([turn('t', '2', true)], 'b')
      if (cursor === 'b') return page([turn('other', '0'), turn('t', '1')], 'older')
      throw Error('should not read an unrelated turn')
    },
    { visible: turn('t', '3'), olderCursor: 'a' },
  )
  expect(turns[0].items.map((i) => i.id)).toEqual(['1', '2', '3'])
})
it('reports a stuck cursor instead of silently exporting a partial session', async () => {
  await expect(exportTurns(async () => page([turn('t', '1')], 'same'))).rejects.toThrow(/游标/)
})
