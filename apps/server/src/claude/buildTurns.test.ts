import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTurns } from './transcript.js'
import { ImageStore } from '../images/store.js'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A stored user frame, exactly as the CLI writes it to the session JSONL. */
const promptFrame = (uuid: string, content: unknown[]) => ({
  type: 'user',
  uuid,
  parent_tool_use_id: null,
  message: { role: 'user', content },
})

const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }

let dir: string
let images: ImageStore

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-buildturns-'))
  images = new ImageStore(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('buildTurns — user prompts', () => {
  it('starts a turn for a message with only an image and no text', () => {
    // A screenshot sent with no caption is a real prompt. The discriminator
    // used to require a text block, so this produced NO turn at all: no bubble,
    // and the image block fell into whatever turn happened to be open.
    const turns = buildTurns([promptFrame('u1', [imageBlock])], { images })

    expect(turns).toHaveLength(1)
    expect(turns[0].items).toHaveLength(1)
    expect(turns[0].items[0]).toMatchObject({ kind: 'message', role: 'user', text: '' })
    expect((turns[0].items[0] as any).images).toHaveLength(1)
    expect((turns[0].items[0] as any).images[0]).toMatch(/^[a-f0-9]{32}\.png$/)
  })

  it('resolves the recorded bytes to the same token a live turn would', () => {
    const turns = buildTurns([promptFrame('u1', [imageBlock])], { images })
    const token = (turns[0].items[0] as any).images[0]
    expect(images.get(token)?.mime).toBe('image/png')
    expect(fs.readFileSync(images.get(token)!.path).toString('base64')).toBe(PNG_B64)
  })

  it('keeps images and text on one bubble, images first', () => {
    const turns = buildTurns([promptFrame('u1', [imageBlock, { type: 'text', text: '描述图片' }])], { images })
    expect(turns).toHaveLength(1)
    expect(turns[0].items[0]).toMatchObject({
      kind: 'message',
      id: 'claude:user:u1',
      role: 'user',
      text: '描述图片',
    })
    expect((turns[0].items[0] as any).images).toHaveLength(1)
  })

  it('does not start a turn for a tool result, which is a user frame too', () => {
    // The reason the discriminator is content type and not role: treating a
    // tool result as a prompt would cut every turn into pieces.
    const turns = buildTurns(
      [
        promptFrame('u1', [{ type: 'text', text: 'run it' }]),
        promptFrame('u2', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      ],
      { images },
    )
    expect(turns).toHaveLength(1)
    expect(turns[0].items).toHaveLength(1)
  })

  it('writes no images key without a store', () => {
    // What a provider with no `stateDir` gets: no `data:` URL may survive onto
    // an item, so the key is simply absent.
    const turns = buildTurns([promptFrame('u1', [imageBlock, { type: 'text', text: 'hi' }])])
    expect(turns[0].items[0]).toEqual({
      kind: 'message',
      id: 'claude:user:u1',
      role: 'user',
      text: 'hi',
    })
  })

  it('still cuts at sliceAt, so a running turn is not rendered twice', () => {
    const turns = buildTurns([promptFrame('u1', [imageBlock]), promptFrame('u2', [imageBlock])], {
      images,
      sliceAt: 'u2',
    })
    expect(turns).toHaveLength(1)
  })
})

describe('buildTurns — turn bounds', () => {
  // The transcript screen stamps each user bubble with the turn's start and
  // the actions row under a finished turn with its end, so these two have to
  // come from the stored frames rather than from the moment the page loaded.
  it('takes startedAt from the prompt and completedAt from the last frame', () => {
    const prompt = {
      ...promptFrame('u1', [{ type: 'text', text: 'hi' }]),
      timestamp: '2026-10-22T09:00:00.000Z',
    }
    const reply = {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-10-22T09:00:07.500Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    }
    const turns = buildTurns([prompt, reply])
    expect(turns[0].startedAt).toBe(Date.parse('2026-10-22T09:00:00.000Z'))
    expect(turns[0].completedAt).toBe(Date.parse('2026-10-22T09:00:07.500Z'))
    // The bubble carries its own time too: a steered prompt has to survive a
    // reload with the moment it was typed, not the turn's start.
    expect(turns[0].items[0]).toMatchObject({ at: Date.parse('2026-10-22T09:00:00.000Z') })
  })

  it('omits the bounds when the frames carry no timestamp', () => {
    const turns = buildTurns([promptFrame('u1', [{ type: 'text', text: 'hi' }])])
    expect(turns[0].startedAt).toBeUndefined()
    expect(turns[0].completedAt).toBeUndefined()
  })
})

describe('buildTurns — compaction dividers', () => {
  const boundaryFrame = (uuid: string, metadata?: Record<string, unknown>) => ({
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    parentUuid: null,
    ...(metadata ? { compactMetadata: metadata } : {}),
  })

  it('turns a boundary into a compaction item with the stable id', () => {
    const turns = buildTurns([
      promptFrame('u1', [{ type: 'text', text: 'before' }]),
      boundaryFrame('b1', { trigger: 'manual', preTokens: 12345, postTokens: 678 }),
      promptFrame('u2', [{ type: 'text', text: 'after' }]),
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0].items).toContainEqual({
      kind: 'compaction',
      id: 'claude:compaction:b1',
      status: 'done',
      trigger: 'manual',
      preTokens: 12345,
      postTokens: 678,
    })
  })

  it('omits a missing postTokens instead of writing zero', () => {
    const turns = buildTurns([
      promptFrame('u1', [{ type: 'text', text: 'hi' }]),
      boundaryFrame('b1', { trigger: 'auto', preTokens: 900 }),
    ])
    const item = turns[0].items.find((i) => i.kind === 'compaction')!
    expect(item).toMatchObject({ trigger: 'auto', preTokens: 900 })
    expect('postTokens' in item).toBe(false)
  })

  it('waits for the first turn when the boundary comes first', () => {
    const turns = buildTurns([
      boundaryFrame('b1', { trigger: 'auto' }),
      promptFrame('u1', [{ type: 'text', text: 'first prompt' }]),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0].items[0]).toMatchObject({ kind: 'compaction', id: 'claude:compaction:b1' })
    expect(turns[0].items[1]).toMatchObject({ kind: 'message', role: 'user', text: 'first prompt' })
  })

  it('never invents a turn for a boundary alone', () => {
    expect(buildTurns([boundaryFrame('b1', { trigger: 'auto' })])).toHaveLength(0)
    expect(buildTurns([boundaryFrame(undefined as unknown as string)])).toHaveLength(0)
  })

  it('drops a boundary after sliceAt along with the rest of the live turn', () => {
    const turns = buildTurns(
      [
        promptFrame('u1', [{ type: 'text', text: 'done' }]),
        promptFrame('u2', [{ type: 'text', text: 'running' }]),
        boundaryFrame('b1', { trigger: 'auto' }),
      ],
      { sliceAt: 'u2' },
    )
    expect(turns).toHaveLength(1)
    expect(turns[0].items.some((i) => i.kind === 'compaction')).toBe(false)
  })
})

it('replays a synthetic API failure as a failed turn and an error card', () => {
  const turns = buildTurns([
    promptFrame('failure-prompt', [{ type: 'text', text: 'task' }]),
    { type: 'system', subtype: 'api_error', error: { message: '503 unavailable' } },
    {
      type: 'assistant',
      uuid: 'failure-uuid',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: 500' }] },
    },
  ])
  expect(turns).toHaveLength(1)
  expect(turns[0].status).toBe('failed')
  expect(turns[0].items.find((i) => i.kind === 'retry')).toMatchObject({
    kind: 'retry',
    attempts: [{ message: '503 unavailable' }],
  })
  expect(turns[0].items.at(-1)).toEqual({ kind: 'error', id: 'claude:error:failure-uuid', message: 'API Error: 500' })
})
