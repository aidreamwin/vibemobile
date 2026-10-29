/**
 * The delta/completed reconciliation rule.
 *
 * `item.completed` is authoritative, but codex has been observed completing a
 * command with `exitCode: 0` and an empty `aggregatedOutput` — the text only
 * ever existed as streamed deltas. Getting this wrong silently loses output on
 * screen, which is hard to notice and easy to reintroduce, so it is pinned here.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentItem, ApprovalRequest } from '@vibemobile/protocol'

// The store flushes deltas on `requestAnimationFrame` when it is available and
// otherwise on `window.setTimeout`. A plain Node process has no rAF, so it takes
// the timer branch — and that branch is the only one that touches `window`.
;(globalThis as { window?: unknown }).window ??= globalThis

const { loadTranscript, prependTranscriptItems, resyncTranscript, useChatStore } = await import('./store')

const THREAD = 'thread-1'
const TURN = 'turn-1'

/** Deltas are flushed on a timer, so assertions have to wait one out. */
const settled = () => new Promise((r) => setTimeout(r, 80))

const apply = (event: AgentEvent) => useChatStore.getState().applyEvent(event)

const delta = (itemId: string, channel: 'text' | 'reasoning' | 'commandOutput', text: string): AgentEvent => ({
  kind: 'delta',
  threadId: THREAD,
  turnId: TURN,
  itemId,
  channel,
  text,
})

const command = (id: string, output: string): AgentItem => ({
  kind: 'command',
  id,
  command: 'echo hi',
  status: 'done',
  output,
  exitCode: 0,
})

const message = (id: string, text: string): AgentItem => ({
  kind: 'message',
  id,
  role: 'assistant',
  text,
})

const reasoning = (id: string, summary: string[] = [], content: string[] = []): AgentItem => ({
  kind: 'reasoning',
  id,
  summary,
  content,
})

const itemAt = (id: string) => useChatStore.getState().items.find((i) => i.id === id)

beforeEach(() => {
  useChatStore.getState().reset(THREAD)
})

describe('streamed deltas vs the authoritative completed item', () => {
  it('keeps streamed command output when the completed item carries none', async () => {
    apply({ kind: 'item.started', threadId: THREAD, turnId: TURN, item: command('c1', '') })
    apply(delta('c1', 'commandOutput', 'line 1\n'))
    apply(delta('c1', 'commandOutput', 'line 2\n'))
    await settled()

    apply({ kind: 'item.completed', threadId: THREAD, turnId: TURN, item: command('c1', '') })
    await settled()

    expect(itemAt('c1')).toMatchObject({ kind: 'command', output: 'line 1\nline 2\n' })
    // The buffer must still go away, or the text would render twice.
    expect(useChatStore.getState().streams.c1).toBeUndefined()
  })

  it('keeps streamed reply text when the completed message is empty', async () => {
    apply({ kind: 'item.started', threadId: THREAD, turnId: TURN, item: message('m1', '') })
    apply(delta('m1', 'text', 'the whole reply'))
    await settled()

    apply({ kind: 'item.completed', threadId: THREAD, turnId: TURN, item: message('m1', '') })
    await settled()

    expect(itemAt('m1')).toMatchObject({ kind: 'message', text: 'the whole reply' })
  })

  it('prefers the completed item over the deltas when it has its own text', async () => {
    apply({ kind: 'item.started', threadId: THREAD, turnId: TURN, item: message('m2', '') })
    // Deltas are explicitly not guaranteed to concatenate to the final text.
    apply(delta('m2', 'text', 'draft that differs'))
    await settled()

    apply({
      kind: 'item.completed',
      threadId: THREAD,
      turnId: TURN,
      item: message('m2', 'the final text'),
    })
    await settled()

    expect(itemAt('m2')).toMatchObject({ kind: 'message', text: 'the final text' })
  })

  it('drops the buffer on completion even when there is nothing to fall back to', async () => {
    apply({ kind: 'item.started', threadId: THREAD, turnId: TURN, item: command('c2', '') })
    apply(delta('c2', 'commandOutput', 'partial'))
    await settled()

    apply({ kind: 'item.completed', threadId: THREAD, turnId: TURN, item: command('c2', 'real output') })
    await settled()

    expect(itemAt('c2')).toMatchObject({ output: 'real output' })
    expect(useChatStore.getState().streams.c2).toBeUndefined()
  })

  it('keeps streamed reasoning when the completed item is empty', async () => {
    apply({ kind: 'item.started', threadId: THREAD, turnId: TURN, item: reasoning('r1') })
    apply(delta('r1', 'reasoning', 'A displayable reasoning summary'))
    await settled()

    apply({ kind: 'item.completed', threadId: THREAD, turnId: TURN, item: reasoning('r1') })
    await settled()

    expect(itemAt('r1')).toEqual(reasoning('r1', [], ['A displayable reasoning summary']))
    expect(useChatStore.getState().streams.r1).toBeUndefined()
  })

  it('materializes reasoning deltas when the turn ends without item.completed', async () => {
    apply({ kind: 'item.started', threadId: THREAD, turnId: TURN, item: reasoning('r2') })
    apply(delta('r2', 'reasoning', 'Recovered at turn completion'))
    await settled()

    apply({
      kind: 'turn.completed',
      threadId: THREAD,
      turnId: TURN,
      status: 'completed',
    })
    await settled()

    expect(itemAt('r2')).toEqual(reasoning('r2', [], ['Recovered at turn completion']))
    expect(useChatStore.getState().streams.r2).toBeUndefined()
  })
})

const approval = (requestId: string, turnId: string): ApprovalRequest => ({
  requestId,
  threadId: THREAD,
  turnId,
  itemId: `item-${requestId}`,
  type: 'command',
  title: 'Approve command',
  availableDecisions: ['accept', 'decline'],
})

/**
 * An approval sheet is NOT dismissable — a stray tap cannot close it — so one
 * that outlives its turn blocks the composer until the page is reloaded. The
 * server broadcasts `approval.resolved` when it abandons a request, but that
 * broadcast can be missed by a socket that was down; this is the client's own
 * backstop.
 */
describe('approvals do not outlive their turn', () => {
  it('drops the sheet for a turn that has finished', () => {
    apply({ kind: 'approval.requested', approval: approval('a1', TURN) })
    apply({ kind: 'approval.requested', approval: approval('a2', 'turn-2') })
    expect(useChatStore.getState().approvals.map((a) => a.requestId)).toEqual(['a1', 'a2'])

    apply({ kind: 'turn.completed', threadId: THREAD, turnId: TURN, status: 'completed' })

    // Only the finished turn's sheet — the other turn is untouched.
    expect(useChatStore.getState().approvals.map((a) => a.requestId)).toEqual(['a2'])
  })

  it('keeps the sheet while the turn is still running', () => {
    apply({ kind: 'approval.requested', approval: approval('a1', TURN) })
    apply({ kind: 'turn.completed', threadId: THREAD, turnId: TURN, status: 'inProgress' })
    expect(useChatStore.getState().approvals.map((a) => a.requestId)).toEqual(['a1'])
  })
})

/**
 * Reconnect catch-up. The socket replays subscriptions and live status, but an
 * item that finished while the phone was away only ever existed in the delta
 * stream — the transcript is the only place it survives. Re-fetching is
 * therefore necessary, and doing it the way `loadTranscript` does (clear the
 * store, show the loading screen) is not: a phone that merely locked its screen
 * would flash 加载中… and blank the turn that is still running.
 */
describe('resyncTranscript', () => {
  it('adds what completed while the socket was down', () => {
    loadTranscript(THREAD, [message('m1', 'first')])
    resyncTranscript(THREAD, [message('m1', 'first'), message('m2', 'arrived while away')])
    expect(useChatStore.getState().items.map((i) => i.id)).toEqual(['m1', 'm2'])
  })

  it('keeps an item the snapshot does not know about yet', () => {
    // Live events issued after the snapshot was cut are the tail of the turn;
    // dropping them would truncate what the user is watching.
    loadTranscript(THREAD, [message('m1', 'first')])
    apply({ kind: 'item.started', threadId: THREAD, turnId: TURN, item: message('m2', '') })
    apply(delta('m2', 'text', 'streaming'))
    return settled().then(() => {
      resyncTranscript(THREAD, [message('m1', 'first')])
      expect(useChatStore.getState().items.map((i) => i.id)).toEqual(['m1', 'm2'])
      // …and its buffer survives, because it is the only copy of that text.
      expect(useChatStore.getState().streams.m2?.text).toBe('streaming')
    })
  })

  it('drops a buffer the snapshot has already superseded', async () => {
    loadTranscript(THREAD, [message('m1', '')])
    apply({ kind: 'item.started', threadId: THREAD, turnId: TURN, item: message('m1', '') })
    apply(delta('m1', 'text', 'a stale prefix'))
    await settled()

    // The snapshot carries this item's text, so the buffer is an older prefix
    // of it and rendering both would double the paragraph.
    resyncTranscript(THREAD, [message('m1', 'a stale prefix and the rest')])
    expect(useChatStore.getState().streams.m1).toBeUndefined()
    expect(itemAt('m1')).toMatchObject({ text: 'a stale prefix and the rest' })
  })

  it('does not blank the transcript or the sheets it is merging into', () => {
    loadTranscript(THREAD, [message('m1', 'first')])
    apply({ kind: 'approval.requested', approval: approval('a1', TURN) })
    resyncTranscript(THREAD, [message('m1', 'first')])
    expect(useChatStore.getState().approvals.map((a) => a.requestId)).toEqual(['a1'])
  })

  it('keeps older pages above the snapshot instead of moving them to the tail', () => {
    // Once "load older" exists, most items on screen are not in the newest-page
    // snapshot at all. Appending those (`[...items, ...leftovers]`, the old
    // shape) would move half the conversation below the newest turn on every
    // reconnect — a reorder with no error and no obvious cause.
    loadTranscript(THREAD, [message('m3', 'newest page'), message('m4', 'newest page')])
    prependTranscriptItems(THREAD, [message('m1', 'older'), message('m2', 'older')])

    resyncTranscript(THREAD, [
      message('m3', 'newest page, re-read'),
      message('m4', 'newest page, re-read'),
      message('m5', 'arrived while away'),
    ])

    expect(useChatStore.getState().items.map((i) => i.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(itemAt('m3')).toMatchObject({ text: 'newest page, re-read' })
  })
})

/**
 * Older pages are fetched over HTTP while the user is reading; by the time one
 * lands they may have switched conversations, and the response must not write
 * into the new one.
 */
describe('prependTranscriptItems', () => {
  it('puts the page at the head', () => {
    loadTranscript(THREAD, [message('m3', 'third')])
    const added = prependTranscriptItems(THREAD, [message('m1', 'first'), message('m2', 'second')])
    expect(added).toBe(2)
    expect(useChatStore.getState().items.map((i) => i.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('keeps the copy already on screen when a page overlaps', () => {
    // Claude's cursor counts from the newest end, so a turn that starts while
    // the reader pages can shift a page by one. The copy already rendered may
    // carry live text that a re-read does not have.
    loadTranscript(THREAD, [message('m2', 'live text'), message('m3', 'third')])
    const added = prependTranscriptItems(THREAD, [message('m1', 'first'), message('m2', 'stale')])
    expect(added).toBe(1)
    expect(itemAt('m2')).toMatchObject({ text: 'live text' })
    expect(useChatStore.getState().items.map((i) => i.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('ignores a page for a session that is no longer open', () => {
    loadTranscript(THREAD, [message('m2', 'second')])
    const added = prependTranscriptItems('thread-2', [message('m1', 'first')])
    expect(added).toBe(0)
    expect(useChatStore.getState().items.map((i) => i.id)).toEqual(['m2'])
  })
})

/**
 * `usage.updated` used to fall through `applyEvent`'s `default` and be dropped,
 * so both providers' token counts were invisible for as long as they have been
 * sent. Pinned because "the event arrives and nothing happens" is exactly the
 * kind of silence a refactor reintroduces without noticing.
 */
describe('usage', () => {
  const report = (promptTokens: number, outputTokens: number): AgentEvent => ({
    kind: 'usage.updated',
    threadId: THREAD,
    turnId: TURN,
    usage: { promptTokens, cachedTokens: 0, outputTokens, reasoningOutputTokens: 0 },
  })

  it('keeps the newest report, not a running sum', () => {
    loadTranscript(THREAD, [])
    apply(report(100, 10))
    apply(report(4000, 20))
    expect(useChatStore.getState().usage?.promptTokens).toBe(4000)
  })

  it('is cleared when a different session is loaded', () => {
    // Neither backend can re-derive usage for turns that already happened, so
    // the chip has to start empty rather than carry the last session's numbers.
    loadTranscript(THREAD, [])
    apply(report(100, 10))
    loadTranscript('thread-2', [])
    expect(useChatStore.getState().usage).toBeNull()
  })

  it('survives an in-place resync', () => {
    // A socket blip re-fetches the transcript, which carries no usage. Blanking
    // the figure there would make a number that is still true disappear.
    loadTranscript(THREAD, [])
    apply(report(100, 10))
    resyncTranscript(THREAD, [])
    expect(useChatStore.getState().usage?.promptTokens).toBe(100)
  })
})

describe('visible provider failures', () => {
  beforeEach(() => useChatStore.getState().reset(THREAD))
  it('keeps retrying work running and exposes the retry details', () => {
    apply({ kind: 'turn.started', threadId: THREAD, turnId: TURN })
    apply({ kind: 'session.status', threadId: THREAD, status: 'working' })
    apply({
      kind: 'error',
      threadId: THREAD,
      turnId: TURN,
      message: '503',
      willRetry: true,
      retryAttempt: 1,
      retryInMs: 1000,
    })
    expect(useChatStore.getState()).toMatchObject({
      status: 'working',
      turnStatus: 'inProgress',
      retryNotice: { message: '503', retryAttempt: 1 },
    })
    apply(delta('answer', 'text', 'recovered'))
    expect(useChatStore.getState().retryNotice).toBeNull()
  })
  it('shows a Codex failure even when only turn.completed supplies the reason, and idle cannot erase it', async () => {
    apply({
      kind: 'turn.completed',
      threadId: THREAD,
      turnId: TURN,
      status: 'failed',
      error: { message: 'upstream unavailable' },
    })
    apply({ kind: 'session.status', threadId: THREAD, status: 'idle' })
    await settled()
    expect(useChatStore.getState().items).toContainEqual({
      kind: 'error',
      id: `turn-error:${TURN}`,
      message: 'upstream unavailable',
    })
  })
  it('deduplicates an error notification and the final failure', async () => {
    apply({ kind: 'error', threadId: THREAD, turnId: TURN, message: 'denied', willRetry: false })
    apply({ kind: 'turn.completed', threadId: THREAD, turnId: TURN, status: 'failed', error: { message: 'denied' } })
    await settled()
    expect(useChatStore.getState().items.filter((i) => i.kind === 'error')).toHaveLength(1)
  })
})
