import { describe, expect, it } from 'vitest'
import { fetchTranscript, formatCursor, messagesToTurns, parseCursor, type MessagePageFetcher } from './transcript.js'
import type { OpencodeMessage } from './types.js'

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value')
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
    expect(page.nextCursor).toBe(formatCursor(2))
    expect(page.hasMore).toBe(true)

    const older = await fetchTranscript(fetcher(threeTurns()), { limit: 2, cursor: page.nextCursor ?? undefined })
    expect(older.turns.map((turn) => turn.id)).toEqual(['oc:turn:u1'])
    expect(older.hasMore).toBe(false)
    expect(older.nextCursor).toBeNull()
  })

  it('uses an item budget and still proves there is an older page', async () => {
    const page = await fetchTranscript(fetcher(threeTurns()), { targetItems: 3 })
    expect(page.turns.map((turn) => turn.id)).toEqual(['oc:turn:u2', 'oc:turn:u3'])
    expect(page.hasMore).toBe(true)
  })

  it('never returns a page for a stale cursor', async () => {
    const page = await fetchTranscript(fetcher(threeTurns()), { limit: 2, cursor: formatCursor(99) })
    expect(page.turns).toEqual([])
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeNull()
  })

  it('parses only its own cursors', () => {
    expect(parseCursor('oc:12')).toBe(12)
    expect(parseCursor('c:12')).toBe(0)
    expect(parseCursor(undefined)).toBe(0)
  })
})
