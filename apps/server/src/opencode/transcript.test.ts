import { describe, expect, it } from 'vitest'
import { fetchTranscript, messagesToTurns, type MessagePageFetcher } from './transcript.js'
import type { OpencodeMessage } from './types.js'

function must<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('expected a value')
  return value
}

function user(id: string, at: number, text: string): OpencodeMessage {
  return { id, type: 'user', time: { created: at }, text }
}

function assistant(id: string, at: number, text: string): OpencodeMessage {
  return {
    id,
    type: 'assistant',
    time: { created: at, completed: at + 1 },
    agent: 'build',
    model: { id: 'm', providerID: 'opencode' },
    content: [{ type: 'text', text }],
  }
}

function idle(id: string, at: number, outcome: 'succeeded' | 'failed' | 'interrupted'): OpencodeMessage {
  return { id, type: 'idle', time: { created: at }, outcome }
}

function shellTool(id: string, at: number): OpencodeMessage {
  return {
    id,
    type: 'assistant',
    time: { created: at, completed: at + 1 },
    agent: 'build',
    model: { id: 'm', providerID: 'opencode' },
    content: [
      {
        type: 'tool',
        id: `call_${id}`,
        name: 'shell',
        state: {
          status: 'completed',
          input: { command: 'echo hi' },
          content: [{ type: 'text', text: 'hi' }],
          metadata: { exitCode: 0 },
        },
        time: { created: at },
      },
    ],
  }
}

describe('messagesToTurns', () => {
  it('groups a user message through its idle marker', () => {
    const turns = messagesToTurns([
      user('u1', 1, 'one'),
      assistant('a1', 2, 'first'),
      idle('i1', 4, 'succeeded'),
      user('u2', 5, 'two'),
      shellTool('a2', 6),
      idle('i2', 8, 'failed'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ id: 'oc:turn:u1', status: 'completed', startedAt: 1, completedAt: 4 })
    expect(must(turns[0]).items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'message:oc:user:u1',
      'message:oc:text:a1:0',
    ])
    expect(turns[1]).toMatchObject({ id: 'oc:turn:u2', status: 'failed' })
    expect(must(turns[1]).items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'message:oc:user:u2',
      'command:oc:tool:call_a2',
    ])
  })

  it('keeps a steered user message inside the running turn', () => {
    const turns = messagesToTurns([
      user('u1', 1, 'start'),
      assistant('a1', 2, 'working'),
      user('u2', 3, 'also'),
      idle('i1', 4, 'succeeded'),
    ])
    expect(turns).toHaveLength(1)
    expect(must(turns[0]).items.filter((item) => item.kind === 'message')).toHaveLength(3)
  })

  it('maps edit tool state to a fileChange item with the patch', () => {
    const edit: OpencodeMessage = {
      id: 'a_edit',
      type: 'assistant',
      time: { created: 1, completed: 2 },
      agent: 'build',
      model: { id: 'm', providerID: 'opencode' },
      content: [
        {
          type: 'tool',
          id: 'call_edit',
          name: 'edit',
          state: {
            status: 'completed',
            input: { filePath: 'test.txt', oldString: 'foo', newString: 'bar' },
            content: [{ type: 'text', text: 'Edited test.txt' }],
            metadata: {
              files: [{ file: 'test.txt', patch: 'Index: test.txt\n--- a/test.txt\n+++ b/test.txt\n@@\n-foo\n+bar' }],
            },
          },
          time: { created: 1 },
        },
      ],
    }
    const items =
      messagesToTurns([user('u1', 0, 'q'), edit, idle('i1', 3, 'succeeded')], { cwd: 'D:/w' })[0]?.items ?? []
    expect(items).toEqual([
      expect.objectContaining({ kind: 'message', id: 'oc:user:u1' }),
      expect.objectContaining({
        kind: 'fileChange',
        id: 'oc:tool:call_edit',
        changes: [
          expect.objectContaining({
            path: expect.stringContaining('test.txt'),
            kind: 'update',
            diff: expect.stringContaining('-foo'),
          }),
        ],
      }),
    ])
  })

  it('keeps per-kind ordinals for text and reasoning parts', () => {
    const message: OpencodeMessage = {
      id: 'a1',
      type: 'assistant',
      time: { created: 1, completed: 2 },
      agent: 'build',
      model: { id: 'm', providerID: 'opencode' },
      content: [
        { type: 'text', text: 'a' },
        { type: 'reasoning', text: 'why' },
        { type: 'text', text: 'b' },
      ],
    }
    const items = messagesToTurns([user('u1', 0, 'q'), message, idle('i1', 3, 'succeeded')])[0]?.items ?? []
    expect(items.map((item) => item.id)).toEqual(['oc:user:u1', 'oc:text:a1:0', 'oc:reasoning:a1:0', 'oc:text:a1:1'])
  })
})

function fetcher(messages: OpencodeMessage[]): MessagePageFetcher {
  const desc = messages.slice().reverse()
  return async ({ cursor }) => {
    if (cursor) return { data: [], cursor: { previous: null, next: null } }
    return { data: desc, cursor: { previous: null, next: null } }
  }
}

function threeTurns(): OpencodeMessage[] {
  const messages: OpencodeMessage[] = []
  for (let i = 1; i <= 3; i++) {
    messages.push(
      user(`u${i}`, i * 10, `q${i}`),
      assistant(`a${i}`, i * 10 + 1, `a${i}`),
      idle(`i${i}`, i * 10 + 2, 'succeeded'),
    )
  }
  return messages
}

describe('fetchTranscript', () => {
  it('pages by whole turns, newest first', async () => {
    const page = await fetchTranscript(fetcher(threeTurns()), { limit: 2 })
    expect(page.turns.map((turn) => turn.id)).toEqual(['oc:turn:u2', 'oc:turn:u3'])
    expect(page.nextCursor).toBe('oc:2')
    expect(page.hasMore).toBe(true)

    const older = await fetchTranscript(fetcher(threeTurns()), { limit: 2, cursor: page.nextCursor ?? undefined })
    expect(older.turns.map((turn) => turn.id)).toEqual(['oc:turn:u1'])
    expect(older.hasMore).toBe(false)
    expect(older.nextCursor).toBeNull()
    const resumed = await fetchTranscript(fetcher(threeTurns()), { targetItems: 1, cursor: 'oc:2' })
    expect(resumed.turns).toMatchObject([{ id: 'oc:turn:u1', hasEarlierItems: true, items: [{ id: 'oc:text:a1:0' }] }])
  })

  it('uses an item budget and still proves there is an older page', async () => {
    const page = await fetchTranscript(fetcher(threeTurns()), { targetItems: 3 })
    expect(page.turns.map((turn) => turn.id)).toEqual(['oc:turn:u2', 'oc:turn:u3'])
    expect(page.turns[0]).toMatchObject({ hasEarlierItems: true, items: [{ id: 'oc:text:a2:0' }] })
    expect(page.hasMore).toBe(true)
  })

  it('never returns a page for a stale cursor', async () => {
    const page = await fetchTranscript(fetcher(threeTurns()), { limit: 2, cursor: 'oc:99' })
    expect(page.turns).toEqual([])
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeNull()
  })

  it('keeps steers, tools and assistant parts in their original turn across native pages', async () => {
    const messages = [
      ...threeTurns(),
      user('long', 40, 'start'),
      ...Array.from({ length: 106 }, (_, i) => shellTool(`tool${i}`, 41 + i)),
      user('steer', 150, 'also'),
      assistant('last', 151, 'done'),
      idle('end', 152, 'succeeded'),
    ]
    const desc = messages.slice().reverse()
    const calls: (string | undefined)[] = []
    const fetch: MessagePageFetcher = async ({ cursor }) => {
      calls.push(cursor)
      const start = cursor ? desc.findIndex((m) => m.id === cursor) : 0
      const data = desc.slice(start, start + 2)
      return { data, cursor: { previous: null, next: desc[start + 2]?.id ?? null } }
    }
    const expected = messagesToTurns(messages).flatMap((t) => t.items.map((i) => [t.id, i.id]))
    const got: string[][] = []
    let cursor: string | undefined
    do {
      const page = await fetchTranscript(fetch, { sessionId: 's', targetItems: 7, cursor })
      const items = page.turns.flatMap((t) => t.items.map((i) => [t.id, i.id]))
      expect(items.length).toBeLessThanOrEqual(7)
      expect(items.length).toBeGreaterThan(0)
      got.unshift(...items)
      cursor = page.nextCursor ?? undefined
    } while (cursor && got.length <= expected.length)
    expect(got).toEqual(expected)
    expect(calls.length).toBeGreaterThan(40)
  })

  it('merges live-only items before slicing and keeps them out of older pages', async () => {
    const fetch = fetcher([...threeTurns(), user('live', 35, 'go')])
    const items = Array.from({ length: 75 }, (_, i) => ({
      id: i ? `live${i}` : 'oc:user:live',
      kind: 'message' as const,
      role: 'user' as const,
      text: String(i),
    }))
    const live = { id: 'oc:turn:live', status: 'inProgress' as const, items }
    const first = await fetchTranscript(fetch, { targetItems: 60 }, live)
    expect(first.turns).toMatchObject([
      { id: live.id, status: 'inProgress', items: items.slice(15), hasEarlierItems: true },
    ])
    const older = await fetchTranscript(fetch, { targetItems: 60, cursor: must(first.nextCursor) }, live)
    expect(older.turns.at(-1)?.items.map((i) => i.id)).toEqual(items.slice(0, 15).map((i) => i.id))
    expect(older.nextCursor).toBeNull()
    const onlyLive = await fetchTranscript(fetcher([]), { targetItems: 60 }, live)
    expect(onlyLive.turns[0].items).toEqual(items.slice(15))
  })

  it('resumes a deep page at its native cursor and rejects a cursor from another session', async () => {
    const desc = threeTurns().reverse()
    const calls: (string | undefined)[] = []
    const fetch: MessagePageFetcher = async ({ cursor }) => {
      calls.push(cursor)
      const start = cursor ? Number(cursor) : 0
      return {
        data: desc.slice(start, start + 3),
        cursor: { previous: null, next: start + 3 < desc.length ? String(start + 3) : null },
      }
    }
    const first = await fetchTranscript(fetch, { sessionId: 's', targetItems: 3 })
    calls.length = 0
    const opts = { targetItems: 3, cursor: must(first.nextCursor) }
    const older = await fetchTranscript(fetch, { ...opts, sessionId: 's' })
    expect(calls[0]).toBe('3')
    expect(older.hasMore).toBe(false)
    await expect(fetchTranscript(fetch, { ...opts, sessionId: 'other' })).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})
