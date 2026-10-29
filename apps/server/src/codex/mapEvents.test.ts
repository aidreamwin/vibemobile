/**
 * Tests for the Codex -> AgentEvent translation layer.
 *
 * The payload shapes below are the ones actually observed on the wire against
 * codex-cli 0.154.0, not invented — when the upstream shape drifts, these are
 * the assertions that should fail first.
 */
import { describe, expect, it } from 'vitest'
import { answersForQuestions, mapNotification, mapThreadStatus, normalizeApproval, normalizeItem } from './mapEvents.js'

const THREAD = '01a09f56-ca24-7aa2-b5c3-5fd8475e20db'
const TURN = '01a09f56-c8dd-7dc0-97fc-418be09e0d62'

describe('mapNotification', () => {
  it('maps agent message deltas to text-channel deltas', () => {
    const event = mapNotification('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'msg_1',
      delta: 'Hello',
    })
    expect(event).toEqual({
      kind: 'delta',
      threadId: THREAD,
      turnId: TURN,
      itemId: 'msg_1',
      channel: 'text',
      text: 'Hello',
    })
  })

  it('collapses reasoning text and summary deltas onto one channel', () => {
    for (const method of ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta']) {
      const event = mapNotification(method, {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'rs_1',
        delta: 'thinking',
      })
      expect(event).toMatchObject({ kind: 'delta', channel: 'reasoning', text: 'thinking' })
    }
  })

  it('maps a completed item to the authoritative item, not a delta', () => {
    const event = mapNotification('item/completed', {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'agentMessage', id: 'msg_1', text: 'HUB_TEST_OK STEERED' },
    })
    expect(event).toMatchObject({
      kind: 'item.completed',
      item: { kind: 'message', role: 'assistant', text: 'HUB_TEST_OK STEERED' },
    })
  })

  it('carries the four-state turn status straight through', () => {
    for (const status of ['completed', 'interrupted', 'failed', 'inProgress']) {
      const event = mapNotification('turn/completed', {
        threadId: THREAD,
        turn: { id: TURN, status },
      })
      expect(event).toMatchObject({ kind: 'turn.completed', turnId: TURN, status })
    }
  })

  it('treats a missing turn status as completed rather than dropping the event', () => {
    const event = mapNotification('turn/completed', { threadId: THREAD, turn: { id: TURN } })
    expect(event).toMatchObject({ kind: 'turn.completed', status: 'completed' })
  })

  it('passes the turn end through in milliseconds, and omits it when absent', () => {
    // Codex reports Unix seconds on the Turn; the transcript dates the end of
    // a live turn with this, so sending seconds through would say 1970.
    const completed = mapNotification('turn/completed', {
      threadId: THREAD,
      turn: { id: TURN, status: 'completed', completedAt: 1_766_000_042 },
    })
    expect(completed).toMatchObject({ kind: 'turn.completed', at: 1_766_000_042_000 })

    // An absent value must stay absent: the client uses its own arrival time,
    // which a fabricated one would silently override.
    expect(mapNotification('turn/completed', { threadId: THREAD, turn: { id: TURN } })).toMatchObject({
      at: undefined,
    })
  })

  it('reports the waiting-on-approval status that the session list badges on', () => {
    expect(
      mapNotification('thread/status/changed', {
        threadId: THREAD,
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      }),
    ).toMatchObject({ kind: 'session.status', status: 'waitingApproval' })
  })

  it('resolves approvals by request id', () => {
    const event = mapNotification('serverRequest/resolved', { threadId: THREAD, requestId: 42 })
    expect(event).toEqual({ kind: 'approval.resolved', threadId: THREAD, requestId: '42' })
  })

  it('reads the newest request out of the nested tokenUsage payload, not the thread total', () => {
    // The two breakdowns come from a real recorded rollout: `total` grows for
    // the life of the thread, `last` describes the request that just ran.
    const event = mapNotification('thread/tokenUsage/updated', {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: {
        total: { inputTokens: 108133, cachedInputTokens: 77696, outputTokens: 819, totalTokens: 108952 },
        last: { inputTokens: 20181, cachedInputTokens: 14464, outputTokens: 161, totalTokens: 20342 },
        modelContextWindow: 258400,
      },
    })
    expect(event).toMatchObject({
      kind: 'usage.updated',
      usage: {
        // Codex's input already contains the cached part — 20 181 input of
        // which 14 464 cached, so the prompt is 20 181 and not the sum.
        promptTokens: 20181,
        cachedTokens: 14464,
        outputTokens: 161,
        sessionTokens: 108952,
        contextWindow: 258400,
      },
    })
  })

  it('leaves sessionTokens and the window off when the payload has neither', () => {
    const event = mapNotification('thread/tokenUsage/updated', {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, totalTokens: 15 } },
    })
    // Undefined rather than 0: the sheet renders "unknown", and a session total
    // of zero is a claim about a session that just spent tokens.
    expect((event as any).usage.sessionTokens).toBeUndefined()
    expect((event as any).usage.contextWindow).toBeUndefined()
  })

  it('surfaces fileChange progress as an upsert of the same item id', () => {
    const event = mapNotification('item/fileChange/patchUpdated', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'fc_1',
      changes: [{ path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@' }],
    })
    expect(event).toMatchObject({
      kind: 'item.updated',
      item: { kind: 'fileChange', id: 'fc_1', changes: [{ path: 'src/a.ts', kind: 'update' }] },
    })
  })

  it('ignores notifications it does not model instead of guessing', () => {
    expect(mapNotification('thread/settings/updated', { threadId: THREAD })).toBeNull()
  })
})

describe('mapThreadStatus', () => {
  it('distinguishes user-blocking activity flags', () => {
    expect(mapThreadStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe('waitingInput')
    expect(mapThreadStatus({ type: 'active', activeFlags: [] })).toBe('working')
    expect(mapThreadStatus({ type: 'systemError' })).toBe('error')
    expect(mapThreadStatus({ type: 'idle' })).toBe('idle')
    expect(mapThreadStatus(undefined)).toBe('idle')
  })
})

describe('normalizeItem', () => {
  it('keeps reasoning text from thread and raw response item shapes', () => {
    expect(
      normalizeItem({
        type: 'reasoning',
        id: 'rs_1',
        summary: ['First summary', '  '],
        content: [{ type: 'reasoning_text', text: 'Details' }],
      }),
    ).toEqual({
      kind: 'reasoning',
      id: 'rs_1',
      summary: ['First summary'],
      content: ['Details'],
    })
  })

  it('flattens a command execution into something a phone can render', () => {
    const item = normalizeItem({
      type: 'commandExecution',
      id: 'cmd_1',
      command: 'npm test',
      cwd: 'D:\\code\\vibemobile',
      status: 'completed',
      aggregatedOutput: 'ok\n',
      exitCode: 0,
      durationMs: 1200,
    })
    expect(item).toEqual({
      kind: 'command',
      id: 'cmd_1',
      command: 'npm test',
      cwd: 'D:\\code\\vibemobile',
      status: 'done',
      output: 'ok\n',
      exitCode: 0,
      durationMs: 1200,
    })
  })

  it('resolves the image of an echoed user message', () => {
    // The WIRE shape, verbatim from a 0.162.1 `item/completed` (captured by
    // `smoke-image.ts`). Note `url` — the same item is written to the rollout
    // file as `image_url`, and an earlier version of this code read only that
    // one, which matched nothing here.
    const seen: string[] = []
    const item = normalizeItem(
      {
        type: 'userMessage',
        id: 'u_1',
        clientId: null,
        content: [
          { type: 'image', url: 'data:image/jpeg;base64,AAAA', detail: null },
          { type: 'text', text: 'look at this', text_elements: [] },
        ],
      },
      {
        onImage: (url) => {
          seen.push(url)
          return 'token-for-the-jpeg'
        },
      },
    )
    expect(item).toEqual({
      kind: 'message',
      id: 'u_1',
      role: 'user',
      text: 'look at this',
      images: ['token-for-the-jpeg'],
    })
    expect(seen).toEqual(['data:image/jpeg;base64,AAAA'])
  })

  it('also resolves the rollout spelling, image_url', () => {
    // What the same item looks like in the session JSONL on disk.
    const item = normalizeItem(
      {
        type: 'userMessage',
        id: 'u_5',
        content: [{ type: 'image', image_url: 'data:image/png;base64,BBBB' }],
      },
      { onImage: () => 'rollout-token' },
    )
    expect(item).toMatchObject({ images: ['rollout-token'] })
  })

  it('omits the images key entirely when the message has none', () => {
    // Not `images: []`. Callers and tests compare these objects by value, and
    // an empty array is a second spelling of "nothing attached".
    const item = normalizeItem(
      { type: 'userMessage', id: 'u_2', content: [{ type: 'text', text: 'hi' }] },
      { onImage: () => 'never-called' },
    )
    expect(item).toEqual({ kind: 'message', id: 'u_2', role: 'user', text: 'hi' })
  })

  it('drops image parts when no resolver is supplied', () => {
    // The default path for a provider with no state directory: the raw data
    // URL must not survive onto the item, where it would be serialized onto
    // the socket.
    const item = normalizeItem({
      type: 'userMessage',
      id: 'u_3',
      content: [
        { type: 'image', url: 'data:image/jpeg;base64,AAAA' },
        { type: 'text', text: 'look' },
      ],
    })
    expect(item).toEqual({ kind: 'message', id: 'u_3', role: 'user', text: 'look' })
  })

  it('skips image parts the store refused', () => {
    const item = normalizeItem(
      {
        type: 'userMessage',
        id: 'u_4',
        content: [
          { type: 'image', url: 'data:image/svg+xml;base64,PHN2Zy8+' },
          { type: 'image', url: 'https://example.com/remote.png' },
          { type: 'image', url: 'data:image/png;base64,BBBB' },
        ],
      },
      { onImage: (url) => (url.includes('BBBB') ? 'png-token' : null) },
    )
    expect(item).toMatchObject({ images: ['png-token'] })
  })

  it('degrades gracefully on a malformed item rather than throwing', () => {
    expect(normalizeItem(null)).toMatchObject({ kind: 'unknown' })
    expect(normalizeItem({ type: 'somethingNew', id: 'x_1' })).toMatchObject({
      kind: 'unknown',
      id: 'x_1',
    })
  })

  it('accepts the object form of a patch change kind', () => {
    const item = normalizeItem({
      type: 'fileChange',
      id: 'fc_1',
      status: 'completed',
      changes: [{ path: 'old.ts', kind: { type: 'update', movePath: 'new.ts' }, diff: '' }],
    })
    expect(item).toMatchObject({
      kind: 'fileChange',
      changes: [{ path: 'old.ts', kind: 'update', movePath: 'new.ts' }],
    })
  })

  /**
   * Was falling through to `default` and becoming `kind: 'unknown'`, which
   * `ItemCard` renders as nothing — so the one item that explains why the agent
   * can no longer see the start of the conversation was invisible.
   */
  it('maps a context compaction to a card', () => {
    // The item really is `{id, type}` and nothing else (generated
    // `ContextCompactionThreadItem`), which is why the card has no counts.
    const item = normalizeItem({ type: 'contextCompaction', id: 'cc_1' })
    expect(item).toMatchObject({ kind: 'compaction', id: 'cc_1', status: 'done' })
  })

  it('carries the search action and only the results that exist', () => {
    const withResults = normalizeItem({
      type: 'webSearch',
      id: 'ws_1',
      query: 'q',
      action: { type: 'search', query: 'q', queries: ['q', 'q2'] },
      results: [{ title: 'T', url: 'https://example.com' }],
    })
    expect(withResults).toMatchObject({
      kind: 'webSearch',
      action: { type: 'search', queries: ['q', 'q2'] },
      results: [{ title: 'T', url: 'https://example.com' }],
    })
  })

  it('omits action and results the backend did not send', () => {
    // Every recorded `WebSearch` item on this machine looks like this one — the
    // search was run by the agent's own tool, so there is no `results` key at
    // all. Absent, not `[]`: the card reads the difference.
    const item = normalizeItem({ type: 'webSearch', id: 'ws_2', query: 'q' })
    expect(item).toEqual({ kind: 'webSearch', id: 'ws_2', query: 'q', status: 'done' })
  })

  it('omits an empty results array rather than passing it through', () => {
    const item = normalizeItem({ type: 'webSearch', id: 'ws_3', query: 'q', results: [] })
    expect(item).not.toHaveProperty('results')
  })
})

describe('normalizeApproval', () => {
  it('keeps the server decision list when it sends one', () => {
    const approval = normalizeApproval('item/commandExecution/requestApproval', {
      threadId: THREAD,
      turnId: TURN,
      command: 'rm -rf build',
      cwd: 'D:\\code\\vibemobile',
      availableDecisions: ['accept', 'decline'],
    })
    expect(approval.availableDecisions).toEqual(['accept', 'decline'])
    expect(approval).toMatchObject({ type: 'command', detail: 'rm -rf build' })
  })

  it('falls back to the full decision set when the server omits it', () => {
    const approval = normalizeApproval('item/commandExecution/requestApproval', {
      threadId: THREAD,
      turnId: TURN,
      command: 'ls',
    })
    expect(approval.availableDecisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel'])
  })

  it('drops decision forms the mobile UI cannot render yet', () => {
    const approval = normalizeApproval('item/commandExecution/requestApproval', {
      threadId: THREAD,
      availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { rule: 'x' } }, 'cancel'],
    })
    expect(approval.availableDecisions).toEqual(['accept', 'cancel'])
  })

  it('still offers a decision when the list is only object forms', () => {
    const approval = normalizeApproval('item/commandExecution/requestApproval', {
      threadId: THREAD,
      availableDecisions: [{ acceptWithExecpolicyAmendment: {} }],
    })
    expect(approval.availableDecisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel'])
  })

  it('describes a file-change approval by the root it grants access to', () => {
    const approval = normalizeApproval('item/fileChange/requestApproval', {
      threadId: THREAD,
      grantRoot: 'D:\\code\\vibemobile',
      reason: 'write access',
    })
    expect(approval).toMatchObject({ type: 'fileChange', cwd: 'D:\\code\\vibemobile' })
  })
})

/**
 * `item/tool/requestUserInput` is a question, not a permission — the same gap
 * `claude/askUser.ts` closes on the other provider. Left as a verdict card it
 * renders buttons that answer nothing (`availableDecisions: []` and no
 * questions), which is the state these tests exist to keep it out of.
 */
describe('normalizeApproval — requestUserInput', () => {
  const params = {
    threadId: THREAD,
    turnId: TURN,
    itemId: 'item_1',
    questions: [
      {
        id: 'colour',
        header: 'Colour',
        question: 'Which colour do you prefer?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Red', description: 'warm' },
          { label: 'Blue', description: 'cool' },
        ],
      },
    ],
  }

  it('carries the questions and switches the sheet to a form', () => {
    const approval = normalizeApproval('item/tool/requestUserInput', params)
    expect(approval.type).toBe('userInput')
    expect(approval.questions).toEqual([
      {
        question: 'Which colour do you prefer?',
        header: 'Colour',
        options: [
          { label: 'Red', description: 'warm' },
          { label: 'Blue', description: 'cool' },
        ],
      },
    ])
    // The form replaces the JSON dump; showing both reads as two questions.
    expect(approval.detail).toBeUndefined()
    expect(approval.availableDecisions).toEqual(['accept', 'decline', 'cancel'])
    // "always allow" is a rule about a tool, and a question installs no rule.
    expect(approval.availableDecisions).not.toContain('acceptForSession')
  })

  it('falls back to the raw text when the payload cannot make a form', () => {
    // One option is not a question: a form whose submit can never be satisfied
    // is worse than a card showing what the agent actually sent.
    const approval = normalizeApproval('item/tool/requestUserInput', {
      ...params,
      questions: [{ id: 'x', question: 'Pick one', options: [{ label: 'Only' }] }],
    })
    expect(approval.questions).toBeUndefined()
    expect(approval.detail).toBe('Pick one')
  })

  it('encodes the picks under the wire ids, positionally', () => {
    const ids = ['colour', 'size']
    expect(answersForQuestions(ids, [['Blue'], ['Large']])).toEqual({
      colour: { answers: ['Blue'] },
      size: { answers: ['Large'] },
    })
  })

  it('returns null rather than guessing at an answer that does not line up', () => {
    const ids = ['colour', 'size']
    // Short, empty, or over-long answers are no answer at all — the caller
    // sends an empty map, which is the honest encoding of "nothing chosen".
    expect(answersForQuestions(ids, [['Blue']])).toBeNull()
    expect(answersForQuestions(ids, [['Blue'], []])).toBeNull()
    expect(answersForQuestions(ids, undefined)).toBeNull()
    // An id we never captured would file the answer under the wrong question.
    expect(answersForQuestions(['', 'size'], [['Blue'], ['Large']])).toBeNull()
  })
})

it('preserves Codex retry scope and final failure reasons', () => {
  expect(
    mapNotification('error', {
      threadId: THREAD,
      turnId: TURN,
      error: { message: '503 unavailable' },
      willRetry: true,
    }),
  ).toMatchObject({ kind: 'error', threadId: THREAD, turnId: TURN, message: '503 unavailable', willRetry: true })
  expect(
    mapNotification('turn/completed', {
      threadId: THREAD,
      turn: { id: TURN, status: 'failed', error: { message: 'exhausted retries' } },
    }),
  ).toMatchObject({ kind: 'turn.completed', status: 'failed', error: { message: 'exhausted retries' } })
})
