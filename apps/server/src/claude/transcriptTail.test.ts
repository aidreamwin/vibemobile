import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTurns, isUserPrompt, orderTranscript, readTranscriptMessages } from './transcript.js'

/**
 * The tail reader is the cheap replacement for parsing a whole JSONL
 * transcript. What it must preserve is `buildTurns`'s notion of a turn: the
 * returned slice has to start at a user prompt so the first turn is complete,
 * and tool results must not be mistaken for prompts.
 */

let dir: string
let seq = 0

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-tail-'))
  seq = 0
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function uuid(): string {
  seq++
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`
}

/** A stored frame as the CLI writes it: only the fields the user path reads. */
function frame(type: 'user' | 'assistant', content: unknown[], extra: Record<string, unknown> = {}): any {
  return { type, uuid: uuid(), message: { role: type, content }, ...extra }
}

/** A `system`/`compact_boundary` entry: a chain root, with its metadata. */
function boundary(metadata: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): any {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid(),
    parentUuid: null,
    compactMetadata: metadata,
    ...extra,
  }
}

/** One turn: prompt, assistant answer, and the tool result that answers it. */
function turn(text: string, pad = ''): any[] {
  return [
    frame('user', [{ type: 'text', text: `${text}${pad}` }]),
    frame('assistant', [{ type: 'text', text: `answer to ${text}${pad}` }]),
    frame('user', [{ type: 'tool_result', tool_use_id: `tool-${text}`, content: `result${pad}` }]),
  ]
}

/**
 * Write the frames with the parent links the CLI writes (`parentUuid` points
 * at the previous line). `orderTranscript` rebuilds the conversation from
 * those links — without them a file of otherwise valid frames looks like a
 * pile of roots and only the last one is in scope.
 */
function write(frames: any[]): { file: string; size: number } {
  const file = path.join(dir, 'session.jsonl')
  // Explicit `parentUuid` (including a boundary's `null`) wins; the rest are
  // linked the way the CLI links them.
  const linked = frames.map((frame, i) => ({
    ...frame,
    parentUuid: 'parentUuid' in frame ? frame.parentUuid : i === 0 ? null : frames[i - 1].uuid,
  }))
  fs.writeFileSync(file, linked.map((f) => JSON.stringify(f)).join('\n') + '\n')
  return { file, size: fs.statSync(file).size }
}

describe('isUserPrompt', () => {
  it('keeps stored retry frames through the tail reader and turn builder', async () => {
    const { file, size } = write([
      frame('user', [{ type: 'text', text: 'go' }]),
      {
        type: 'system',
        subtype: 'api_error',
        uuid: uuid(),
        retryAttempt: 1,
        maxRetries: 10,
        retryInMs: 500,
        error: { message: '503 unavailable' },
      },
      frame('assistant', [{ type: 'text', text: 'API Error: 500' }], { isApiErrorMessage: true }),
    ])
    const messages = await readTranscriptMessages(file, size, 1)
    const turns = buildTurns(messages.messages)
    expect(turns[0].items.find((item) => item.kind === 'retry')).toMatchObject({
      attempts: [{ attempt: 1, maxRetries: 10, delayMs: 500 }],
    })
    expect(turns[0].status).toBe('failed')
  })
  it('counts a text prompt, but not a tool result or an empty frame', () => {
    expect(isUserPrompt(frame('user', [{ type: 'text', text: 'hi' }]))).toBe(true)
    expect(isUserPrompt(frame('user', [{ type: 'tool_result', tool_use_id: 't', content: 'x' }]))).toBe(false)
    expect(isUserPrompt(frame('user', [{ type: 'text', text: 'nested' }], { parent_tool_use_id: 't' }))).toBe(false)
    expect(isUserPrompt(frame('user', []))).toBe(false)
  })
})

describe('orderTranscript', () => {
  it('follows parent links and splices off-chain fragments after their group', () => {
    const prompt = frame('user', [{ type: 'text', text: 'go' }])
    const thinking = {
      ...frame('assistant', [{ type: 'thinking', thinking: 'hmm' }]),
      parentUuid: prompt.uuid,
      message: { role: 'assistant', id: 'm1', content: [{ type: 'thinking', thinking: 'hmm' }] },
    }
    const callA = {
      ...frame('assistant', [{ type: 'tool_use', id: 'call_a', name: 'Bash', input: {} }]),
      parentUuid: thinking.uuid,
      message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 'call_a', name: 'Bash', input: {} }] },
    }
    const callB = {
      ...frame('assistant', [{ type: 'tool_use', id: 'call_b', name: 'Bash', input: {} }]),
      parentUuid: callA.uuid,
      message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 'call_b', name: 'Bash', input: {} }] },
    }
    // A dead-end fragment of the same response: off the chain that continues.
    const branch = {
      ...frame('assistant', [{ type: 'tool_use', id: 'call_c', name: 'Bash', input: {} }]),
      parentUuid: thinking.uuid,
      message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 'call_c', name: 'Bash', input: {} }] },
    }
    const resultA = frame('user', [{ type: 'tool_result', tool_use_id: 'call_a', content: 'a' }], {
      parentUuid: callA.uuid,
    })
    const resultB = frame('user', [{ type: 'tool_result', tool_use_id: 'call_b', content: 'b' }], {
      parentUuid: callB.uuid,
    })

    // Append order is the order tool calls finished, not the conversation.
    const ordered = orderTranscript([prompt, thinking, callA, resultA, branch, callB, resultB])

    // Chain is prompt -> thinking -> callA -> callB -> resultB. `resultA` and
    // `branch` are off-chain; the SDK puts assistants first, then results,
    // after the LAST on-chain assistant of the same message id.
    expect(ordered.map((m) => m.uuid)).toEqual([
      prompt.uuid,
      thinking.uuid,
      callA.uuid,
      callB.uuid,
      branch.uuid,
      resultA.uuid,
      resultB.uuid,
    ])
  })
})

describe('readTranscriptMessages', () => {
  it('returns the whole file when it holds fewer turns than asked for', async () => {
    const { file, size } = write([...turn('one'), ...turn('two'), ...turn('three')])

    const read = await readTranscriptMessages(file, size, 10)

    expect(read.truncated).toBe(false)
    expect(buildTurns(read.messages)).toHaveLength(3)
  })

  it('returns only the newest turns, starting at a prompt', async () => {
    // Large enough that the first window cannot hold the requested turns, so
    // this also exercises the doubling and the dropped fragment at its start.
    const pad = '汉'.repeat(50_000)
    const frames = Array.from({ length: 8 }, (_, i) => turn(`turn${i}`, pad)).flat()
    const { file, size } = write(frames)

    const read = await readTranscriptMessages(file, size, 3)
    const turns = buildTurns(read.messages)

    expect(read.truncated).toBe(true)
    expect(turns).toHaveLength(3)
    expect(turns.map((t) => t.items[0])).toMatchObject([
      { role: 'user', text: `turn5${pad}` },
      { role: 'user', text: `turn6${pad}` },
      { role: 'user', text: `turn7${pad}` },
    ])
    // The assistant answer of the first kept turn survived.
    expect(turns[0].items.map((i) => i.kind)).toEqual(['message', 'message'])
  })

  it('does not count a tool-result frame as the start of a turn', async () => {
    const { file, size } = write([...turn('one'), ...turn('two'), ...turn('three')])

    const read = await readTranscriptMessages(file, size, 1)

    expect(buildTurns(read.messages)).toHaveLength(1)
    expect(buildTurns(read.messages)[0].items[0]).toMatchObject({ role: 'user', text: 'three' })
  })

  it('skips sidechain and meta entries the way the SDK does', async () => {
    const { file, size } = write([
      ...turn('one'),
      frame('user', [{ type: 'text', text: 'subagent' }], { isSidechain: true }),
      frame('assistant', [{ type: 'text', text: 'meta' }], { isMeta: true }),
      ...turn('two'),
    ])

    const read = await readTranscriptMessages(file, size, 1)
    const turns = buildTurns(read.messages)

    expect(turns).toHaveLength(1)
    expect(turns[0].items.map((i) => (i as any).text)).not.toContain('subagent')
    expect(turns[0].items.map((i) => (i as any).text)).not.toContain('meta')
  })

  it('returns the turns on BOTH sides of a compact boundary, oldest first', async () => {
    // The old reader stopped at the boundary (and reported that as the start of
    // the conversation). This is the whole point of the change.
    const before = [...turn('before1'), ...turn('before2')]
    const after = [...turn('after1'), ...turn('after2')]
    const divider = boundary({ trigger: 'auto', preTokens: 120_000, postTokens: 9_000 })
    const { file, size } = write([...before, divider, ...after])

    const read = await readTranscriptMessages(file, size, 10)
    const turns = buildTurns(read.messages)

    expect(read.truncated).toBe(false)
    expect(turns).toHaveLength(4)
    expect(turns.map((t) => (t.items[0] as any).text)).toEqual(['before1', 'before2', 'after1', 'after2'])
    // The divider is attached to the turn that was open when it happened, the
    // same way the live mapper files it against the running turn.
    expect(turns[1].items).toContainEqual(
      expect.objectContaining({ kind: 'compaction', trigger: 'auto', preTokens: 120_000, postTokens: 9_000 }),
    )
  })

  it('does not duplicate preserved messages and does not need them to bridge segments', async () => {
    const before = [...turn('old1'), ...turn('old2')]
    const after = [...turn('new1')]
    // Both metadata forms appear in real sessions. The preserved uuids live in
    // the segment BEFORE the boundary; splicing them into the next one would
    // render those turns twice.
    const messagesForm = boundary({
      preservedMessages: { anchorUuid: 'anchor', uuids: [before[0].uuid, before[1].uuid] },
    })
    const segmentForm = boundary({
      preservedSegment: { headUuid: before[0].uuid, anchorUuid: 'missing', tailUuid: before[1].uuid },
    })
    const { file, size } = write([...before, messagesForm, ...after, segmentForm, ...turn('new2')])

    const read = await readTranscriptMessages(file, size, 10)
    const turns = buildTurns(read.messages)
    const ids = turns.flatMap((t) => t.items.map((i) => i.id))

    expect(turns.map((t) => (t.items[0] as any).text)).toEqual(['old1', 'old2', 'new1', 'new2'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps paging past boundaries and reports whether older turns exist', async () => {
    const frames = [
      ...turn('old1'),
      ...turn('old2'),
      ...turn('old3'),
      boundary(),
      ...turn('new1'),
      ...turn('new2'),
      ...turn('new3'),
    ]
    const { file, size } = write(frames)

    const newest = await readTranscriptMessages(file, size, 2)
    expect(newest.truncated).toBe(true)
    expect(buildTurns(newest.messages).map((t) => (t.items[0] as any).text)).toEqual(['new2', 'new3'])

    const all = await readTranscriptMessages(file, size, 6)
    expect(all.truncated).toBe(false)
    expect(buildTurns(all.messages)).toHaveLength(6)
    expect((buildTurns(all.messages)[0].items[0] as any).text).toBe('old1')
  })

  it('keeps a tool result that arrives after a mid-turn boundary in the same turn', async () => {
    const prompt = frame('user', [{ type: 'text', text: 'go' }])
    const call = frame('assistant', [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: {} }])
    const divider = boundary()
    const result = frame('user', [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }])
    const { file, size } = write([prompt, call, divider, result])

    const read = await readTranscriptMessages(file, size, 10)
    const turns = buildTurns(read.messages)

    expect(turns).toHaveLength(1)
    expect(turns[0].items.map((i) => i.kind)).toEqual(['message', 'command', 'compaction'])
    expect(turns[0].items[1]).toMatchObject({ status: 'done', output: 'ok' })
  })

  it('handles consecutive boundaries without an empty turn', async () => {
    const { file, size } = write([...turn('one'), boundary(), boundary(), ...turn('two')])

    const read = await readTranscriptMessages(file, size, 10)
    const turns = buildTurns(read.messages)

    expect(turns).toHaveLength(2)
    expect(turns.flatMap((t) => t.items).filter((i) => i.kind === 'compaction')).toHaveLength(2)
  })

  it('reads the whole file when asked for Infinity', async () => {
    const pad = '汉'.repeat(50_000)
    const frames = Array.from({ length: 6 }, (_, i) => turn(`turn${i}`, pad)).flat()
    const { file, size } = write(frames)

    const read = await readTranscriptMessages(file, size, Number.POSITIVE_INFINITY)

    expect(read.truncated).toBe(false)
    expect(buildTurns(read.messages)).toHaveLength(6)
  })

  it('starts a mid-file window at a prompt', async () => {
    const pad = '汉'.repeat(50_000)
    const frames = Array.from({ length: 8 }, (_, i) => turn(`turn${i}`, pad)).flat()
    const { file, size } = write(frames)

    const read = await readTranscriptMessages(file, size, 4)

    expect(isUserPrompt(read.messages[0])).toBe(true)
    expect(read.truncated).toBe(true)
  })
})
