/**
 * Tests for the Claude Agent SDK -> AgentEvent translation layer.
 *
 * The frame shapes and their ORDER are the ones actually observed on the wire
 * in a live run of `scripts/capture-claude.ts` against claude-code 2.1.273 —
 * not invented. Several of them are counter-intuitive enough that they were
 * only discovered by reading the capture, and the comments say which:
 *   - `assistant` frames arrive BEFORE `content_block_stop`, one per content
 *     block, so a single message produces several frames sharing one id
 *   - a `thinking` block arrives in its assistant frame with EMPTY text
 *   - a successful Bash result carries no exit code anywhere
 *   - `result.user_message_uuid` is the uuid we stamped on the pushed message
 */
import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentItem } from '@vibemobile/protocol'
import { ClaudeEventMapper } from './mapClaudeEvents.js'
import {
  fileChangesFromInput,
  mapResultUsage,
  mapTaskStatus,
  mapToolItem,
  parseExitCode,
  parseMcpName,
  planFromTodos,
  renderStructuredPatch,
  toolDisplayTitle,
  toolResultText,
} from './mapUtils.js'

const THREAD = '2fef8d47-5acc-4528-b133-d25aeb7730ee'
const MSG_ID = '71598507-93dd-461c-b8da-cef01aeedf9d'

// ------------------------------------------------------------- harness

function collector() {
  const events: AgentEvent[] = []
  return { events, emit: (e: AgentEvent) => events.push(e) }
}

/** Deterministic ids so turn/item ids are assertable. */
function counter() {
  let n = 0
  return () => `id${++n}`
}

function mapper() {
  const { events, emit } = collector()
  return { m: new ClaudeEventMapper({ threadId: THREAD, emit, newId: counter() }), events }
}

const started = (e: AgentEvent) => e.kind === 'item.started'
const completed = (e: AgentEvent) => e.kind === 'item.completed'
/** Assistant text cards only — the user bubble is also `kind: 'message'`. */
const assistantCards = (events: AgentEvent[]) =>
  events.filter(completed).filter((e: any) => e.item.kind === 'message' && e.item.role === 'assistant')

// -------------------------------------------------------- pure primitives

describe('parseExitCode', () => {
  it('reads the exit code out of the failure text', () => {
    // A failing Bash tool_result is the literal string below; the structured
    // result is "Error: Exit code 3".
    expect(parseExitCode('Exit code 3')).toBe(3)
    expect(parseExitCode('Error: Exit code 3')).toBe(3)
    expect(parseExitCode('some output\nExit code 137')).toBe(137)
  })

  it('returns null rather than guessing when there is no exit code', () => {
    // Success carries none, so callers must not treat null as 0.
    expect(parseExitCode('total 640\ndrwxr-xr-x 1 Administrator')).toBeNull()
    expect(parseExitCode('')).toBeNull()
  })
})

describe('mapResultUsage', () => {
  it('reads the nested thinking-token tally from a captured result frame', () => {
    const usage = mapResultUsage({
      input_tokens: 21810,
      cache_read_input_tokens: 0,
      output_tokens: 24,
      output_tokens_details: { thinking_tokens: 0 },
    })
    expect(usage).toEqual({
      promptTokens: 21810,
      cachedTokens: 0,
      outputTokens: 24,
      reasoningOutputTokens: 0,
    })
  })

  it('counts the cached and cache-write parts into the prompt, not into the output', () => {
    // The real numbers from the probe: a second turn of a 30k session reports
    // 218 new input tokens against 29 952 read from cache. `input + output`
    // would be 220 — the count that used to be reported and that says nothing
    // about a 30k context.
    const usage = mapResultUsage({
      input_tokens: 218,
      cache_read_input_tokens: 29952,
      cache_creation_input_tokens: 0,
      output_tokens: 2,
      output_tokens_details: { thinking_tokens: 12 },
    })
    expect(usage.promptTokens).toBe(30170)
    expect(usage.cachedTokens).toBe(29952)
    expect(usage.outputTokens).toBe(2)
    expect(usage.reasoningOutputTokens).toBe(12)
    // No cumulative figure exists on this backend, and inventing one (from the
    // turns this process happened to see) is exactly what must not happen.
    expect(usage.sessionTokens).toBeUndefined()
  })

  it('takes the widest context window across models, keeping subagents out of it', () => {
    const usage = mapResultUsage(
      { input_tokens: 1, output_tokens: 1 },
      { 'claude-opus-5-5': { contextWindow: 200_000 }, 'claude-haiku-5-5': { contextWindow: 20_000 } },
    )
    expect(usage.contextWindow).toBe(200_000)
  })

  it('omits the window when no model reports one', () => {
    expect(mapResultUsage({ input_tokens: 1, output_tokens: 1 }, {}).contextWindow).toBeUndefined()
    expect(mapResultUsage({ input_tokens: 1, output_tokens: 1 }).contextWindow).toBeUndefined()
  })
})

describe('mapTaskStatus', () => {
  it('maps subagent terminal states onto item statuses', () => {
    expect(mapTaskStatus('completed')).toBe('done')
    expect(mapTaskStatus('failed')).toBe('failed')
    expect(mapTaskStatus('killed')).toBe('declined')
    expect(mapTaskStatus(undefined)).toBe('running')
  })
})

describe('parseMcpName', () => {
  it('splits an mcp tool name into server and tool', () => {
    expect(parseMcpName('mcp__playwright__browser_click')).toEqual({
      server: 'playwright',
      tool: 'browser_click',
    })
  })

  it('ignores non-mcp names and tolerates a missing separator', () => {
    expect(parseMcpName('Bash')).toBeNull()
    expect(parseMcpName('mcp__lonely')).toEqual({ server: 'lonely', tool: '' })
  })
})

describe('toolResultText', () => {
  it('handles the string, block-array and absent shapes', () => {
    expect(toolResultText('Exit code 3')).toBe('Exit code 3')
    expect(
      toolResultText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb')
    expect(toolResultText(undefined)).toBe('')
  })
})

// ---------------------------------------------------------- tool -> item

describe('mapToolItem', () => {
  it('maps Bash onto a command card carrying the command and cwd', () => {
    const item = mapToolItem({
      toolUseId: 'call_1',
      name: 'Bash',
      input: { command: 'ls -la', description: 'List files' },
      status: 'running',
    })
    expect(item).toEqual({
      kind: 'command',
      id: 'claude:tool:call_1',
      command: 'ls -la',
      cwd: null,
      status: 'running',
      output: '',
      exitCode: null,
      durationMs: null,
    })
  })

  it('maps Edit onto a fileChange with a diff synthesized from the input', () => {
    const item = mapToolItem({
      toolUseId: 'call_2',
      name: 'Edit',
      input: {
        file_path: 'C:\\work\\capture-demo.txt',
        old_string: 'hello world',
        new_string: 'goodbye world',
      },
      status: 'running',
    })
    expect(item.kind).toBe('fileChange')
    if (item.kind !== 'fileChange') throw new Error('unreachable')
    expect(item.changes).toHaveLength(1)
    expect(item.changes[0].path).toBe('C:\\work\\capture-demo.txt')
    expect(item.changes[0].kind).toBe('update')
    expect(item.changes[0].diff).toContain('-hello world')
    expect(item.changes[0].diff).toContain('+goodbye world')
  })

  it('maps TodoWrite onto a plan card and derives the structured plan', () => {
    const input = {
      todos: [
        { content: 'Mix dough', status: 'completed', activeForm: 'Mixing dough' },
        { content: 'Knead', status: 'in_progress', activeForm: 'Kneading' },
        { content: 'Bake', status: 'pending', activeForm: 'Baking' },
      ],
    }
    const item = mapToolItem({ toolUseId: 'call_3', name: 'TodoWrite', input, status: 'running' })
    expect(item).toEqual({
      kind: 'plan',
      id: 'claude:tool:call_3',
      text: '[x] Mix dough\n[~] Knead\n[ ] Bake',
    })
    expect(planFromTodos(input)).toEqual([
      { step: 'Mix dough', status: 'completed' },
      { step: 'Knead', status: 'inProgress' },
      { step: 'Bake', status: 'pending' },
    ])
  })

  it('maps WebSearch and mcp tools onto their dedicated cards', () => {
    expect(mapToolItem({ toolUseId: 'c', name: 'WebSearch', input: { query: 'hi' }, status: 'done' })).toEqual({
      kind: 'webSearch',
      id: 'claude:tool:c',
      query: 'hi',
      status: 'done',
    })

    const mcp = mapToolItem({
      toolUseId: 'd',
      name: 'mcp__playwright__click',
      input: { selector: '#go' },
      status: 'running',
    })
    expect(mcp).toMatchObject({ kind: 'mcpTool', server: 'playwright', tool: 'click' })
  })

  it('falls back to the generic tool card, never to unknown', () => {
    // A new tool with no dedicated card must still render. `unknown` renders
    // as nothing at all, which reads to the user as a stalled turn.
    const item = mapToolItem({
      toolUseId: 'call_4',
      name: 'CronCreate',
      input: { cron: '0 9 * * *' },
      status: 'running',
    })
    expect(item.kind).toBe('tool')
    if (item.kind !== 'tool') throw new Error('unreachable')
    expect(item.name).toBe('CronCreate')
    expect(item.title).toBe('CronCreate')
    expect(item.input).toEqual({ cron: '0 9 * * *' })
  })

  it('badges both spellings of the subagent tool', () => {
    // `system:init` advertises `Task`, but the live frames call it `Agent`.
    for (const name of ['Task', 'Agent']) {
      const item = mapToolItem({
        toolUseId: 'call_5',
        name,
        input: { description: 'Count files', subagent_type: 'Explore' },
        status: 'running',
      })
      expect(item).toMatchObject({
        kind: 'tool',
        name,
        title: 'Count files',
        subagentType: 'Explore',
        childCount: 0,
      })
    }
  })
})

describe('toolDisplayTitle', () => {
  it('shortens long paths so the card header stays readable on a phone', () => {
    expect(toolDisplayTitle('Read', { file_path: 'C:\\Users\\me\\deep\\nested\\file.ts' })).toBe(
      '读取 …/nested/file.ts',
    )
    expect(toolDisplayTitle('Write', { file_path: 'a.txt' })).toBe('写入 a.txt')
  })

  it('uses only the first line of a multi-line command', () => {
    expect(toolDisplayTitle('Bash', { command: 'line one\nline two' })).toBe('line one')
  })
})

// ------------------------------------------------------------ diff sources

describe('renderStructuredPatch', () => {
  it('renders a captured Edit structuredPatch as a diff body', () => {
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-hello world', '+goodbye world'] }]
    expect(renderStructuredPatch(patch)).toBe('@@ -1,1 +1,1 @@\n-hello world\n+goodbye world')
  })

  it('returns empty for a Write, whose structuredPatch is an empty array', () => {
    // A captured Write result is {content, originalFile: null, structuredPatch: []}.
    // The body comes from the input instead — see fileChangesFromInput.
    expect(renderStructuredPatch([])).toBe('')
    expect(renderStructuredPatch(undefined)).toBe('')
  })
})

describe('fileChangesFromInput', () => {
  it('builds an all-added diff for a Write', () => {
    const changes = fileChangesFromInput('Write', { file_path: 'a.txt', content: 'one\ntwo' })
    expect(changes).toEqual([{ path: 'a.txt', kind: 'add', diff: '+one\n+two' }])
  })

  it('works for a replayed session, where no structuredPatch exists', () => {
    // Replay persists only prose ("has been updated successfully"), so the
    // input is the only thing that can still produce a real diff.
    const changes = fileChangesFromInput('Edit', {
      file_path: 'a.txt',
      old_string: 'alpha',
      new_string: 'beta',
    })
    expect(changes[0].diff).toContain('-alpha')
    expect(changes[0].diff).toContain('+beta')
  })

  it('returns nothing for tools that do not touch files', () => {
    expect(fileChangesFromInput('Bash', { command: 'ls' })).toEqual([])
  })
})

// -------------------------------------------------------------- the mapper

describe('ClaudeEventMapper — turn lifecycle', () => {
  it('emits the user bubble, turn.started and working before any frame arrives', () => {
    const { m, events } = mapper()
    const { turnId, started: didStart } = m.beginTurn('hello', 'cmd-1')
    expect(didStart).toBe(true)
    expect(events).toEqual([
      {
        kind: 'item.completed',
        threadId: THREAD,
        turnId,
        // `at` is the wall clock; the shape around it is what this test pins.
        item: expect.objectContaining({
          kind: 'message',
          id: 'claude:user:cmd-1',
          role: 'user',
          text: 'hello',
        }),
      },
      { kind: 'turn.started', threadId: THREAD, turnId },
      { kind: 'session.status', threadId: THREAD, status: 'working' },
    ])
  })

  it('puts the tokens of an attached image on the user bubble', () => {
    // The SDK's own `user` frames are not trusted for this (see `beginTurn`),
    // so the tokens have to arrive as an argument — and they are tokens, never
    // data URLs, because this item is retained for the life of the session.
    const { m, events } = mapper()
    m.beginTurn('what is this', 'cmd-2', ['a'.repeat(32) + '.png'])
    expect(events[0]).toMatchObject({
      item: {
        kind: 'message',
        id: 'claude:user:cmd-2',
        role: 'user',
        text: 'what is this',
        images: ['a'.repeat(32) + '.png'],
      },
    })
  })

  it('adds no images key when the turn carried no images', () => {
    // Guards the exact `toEqual` above: `images: []` would be a second
    // spelling of "nothing attached" and would break every existing consumer.
    const { m, events } = mapper()
    m.beginTurn('hello', 'cmd-3', [])
    expect(events[0]).toMatchObject({
      item: { kind: 'message', id: 'claude:user:cmd-3', role: 'user', text: 'hello' },
    })
    expect((events[0] as { item: any }).item).not.toHaveProperty('images')
  })

  it('queues a second push instead of starting it, and promotes it on the first result', () => {
    // Captured: two pushes mid-turn produced two `result` frames, each
    // `num_turns: 1`. The CLI never folds the second into the running turn.
    const { m, events } = mapper()
    m.beginTurn('first', 'cmd-1')
    const second = m.beginTurn('second', 'cmd-2')
    expect(second.started).toBe(false)
    expect(events.filter((e) => e.kind === 'turn.started')).toHaveLength(1)

    m.handle({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'cmd-1' })

    const turns = events.filter((e) => e.kind === 'turn.started')
    expect(turns).toHaveLength(2)
    expect((turns[1] as any).turnId).toBe(second.turnId)
    expect(events.filter((e) => e.kind === 'turn.completed')).toHaveLength(1)
  })

  it('folds a steer into the running turn instead of starting a new one', () => {
    // Measured against CLI 2.1.303 with stdin left open: a second user message
    // pushed mid-turn is delivered inside that turn — one result, one
    // turn.completed. The bubble is filed against the active turn and no
    // second turn.started is emitted.
    const { m, events } = mapper()
    const { turnId } = m.beginTurn('first', 'cmd-1')
    const mark = events.length

    const folded = m.interject('change of plan', 'cmd-2')

    expect(folded).toEqual({ turnId, folded: true })
    expect(events.slice(mark)).toEqual([
      {
        kind: 'item.completed',
        threadId: THREAD,
        turnId,
        item: expect.objectContaining({
          kind: 'message',
          id: 'claude:user:cmd-2',
          role: 'user',
          text: 'change of plan',
        }),
      },
    ])

    m.handle({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'cmd-1' })

    expect(events.filter((e) => e.kind === 'turn.started')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'turn.completed')).toHaveLength(1)
    const bubbles = m.itemsForTurn(turnId).filter((i) => i.kind === 'message' && i.role === 'user')
    expect(bubbles).toHaveLength(2)
  })

  it('dates each user bubble when it was accepted, not when the turn began', () => {
    // A steer is typed minutes into a turn. Showing it with the turn's start
    // would claim it was sent before the answer it is replying to.
    const { m, events } = mapper()
    const t0 = Date.now()
    m.beginTurn('first', 'cmd-1')
    const mid = Date.now()
    m.interject('change of plan', 'cmd-2')
    const t1 = Date.now()

    const bubbles = events.flatMap((e) => (e.kind === 'item.completed' ? [e.item] : []))
    const [first, second] = bubbles.filter(
      (item): item is Extract<AgentItem, { kind: 'message' }> => item.kind === 'message' && item.role === 'user',
    )
    expect(first.at).toBeGreaterThanOrEqual(t0)
    expect(first.at).toBeLessThanOrEqual(mid)
    expect(second.at).toBeGreaterThanOrEqual(mid)
    expect(second.at).toBeLessThanOrEqual(t1)
  })

  it('starts a turn when a steer arrives with nothing running', () => {
    // The heartbeat case: the turn ended a moment before the message landed.
    // Delivering it as a new turn beats rejecting it.
    const { m, events } = mapper()
    const folded = m.interject('late arrival', 'cmd-2')
    expect(folded.folded).toBe(false)
    expect(events.filter((e) => e.kind === 'turn.started')).toHaveLength(1)
    expect(events[0]).toMatchObject({ item: { id: 'claude:user:cmd-2', role: 'user' } })
  })

  it('closes the turn named by result.user_message_uuid, not merely the newest', () => {
    const { m, events } = mapper()
    const first = m.beginTurn('a', 'cmd-1')
    m.handle({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'cmd-1' })
    const closed = events.find((e) => e.kind === 'turn.completed')
    expect((closed as any).turnId).toBe(first.turnId)
  })

  it('never emits more than one turn.completed per turn, however it is called', () => {
    const { m, events } = mapper()
    m.beginTurn('a', 'cmd-1')
    m.handle({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'cmd-1' })
    // A crash backstop may fire after the normal path already closed the turn.
    m.finish('failed', 'subprocess died')
    expect(events.filter((e) => e.kind === 'turn.completed')).toHaveLength(1)
  })

  it('reports a failed result as a failed turn carrying the message', () => {
    const { m, events } = mapper()
    const { turnId } = m.beginTurn('a', 'cmd-1')
    m.handle({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'boom',
      user_message_uuid: 'cmd-1',
    })
    expect(events).toContainEqual({
      kind: 'turn.completed',
      threadId: THREAD,
      turnId,
      status: 'failed',
      error: { message: 'boom' },
    })
  })

  it('files a marked turn as interrupted even though its result says success', () => {
    // Captured verbatim: interrupting a turn produced subtype 'success',
    // terminal_reason 'completed', is_error false. Trusting the frame would
    // record every stopped turn as a success.
    const { m, events } = mapper()
    const { turnId } = m.beginTurn('count to 400', 'cmd-1')
    m.markInterrupted(turnId)
    m.handle({
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      user_message_uuid: 'cmd-1',
    })
    expect(events).toContainEqual({
      kind: 'turn.completed',
      threadId: THREAD,
      turnId,
      status: 'interrupted',
      error: null,
    })
  })

  it('does not let the interrupted mark leak onto a later turn', () => {
    const { m, events } = mapper()
    const first = m.beginTurn('a', 'cmd-1')
    m.markInterrupted(first.turnId)
    m.handle({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'cmd-1' })

    const second = m.beginTurn('b', 'cmd-2')
    m.handle({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'cmd-2' })
    const closes = events.filter((e) => e.kind === 'turn.completed')
    expect(closes[1] as any).toMatchObject({ turnId: second.turnId, status: 'completed' })
    expect(second.turnId).not.toBe(first.turnId)
  })

  it('maps the result usage onto the turn that just ended', () => {
    const { m, events } = mapper()
    const { turnId } = m.beginTurn('a', 'cmd-1')
    m.handle({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: 'cmd-1',
      usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { thinking_tokens: 2 } },
    })
    expect(events).toContainEqual({
      kind: 'usage.updated',
      threadId: THREAD,
      turnId,
      usage: {
        promptTokens: 10,
        cachedTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 2,
      },
    })
  })

  /**
   * Compaction used to land in `#handleSystem`'s fallthrough and produce
   * nothing at all, which left the user with an agent that had silently
   * forgotten the first half of the conversation and no card to explain it.
   */
  it('shows a compaction as a card on the running turn', () => {
    const { m, events } = mapper()
    const { turnId } = m.beginTurn('keep going', 'cmd-1')
    m.handle({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 168_000, post_tokens: 12_000 },
    })
    const card = events.filter(completed).find((e: any) => e.item.kind === 'compaction') as any
    expect(card).toMatchObject({
      kind: 'item.completed',
      threadId: THREAD,
      turnId,
      item: { kind: 'compaction', status: 'done', trigger: 'auto', preTokens: 168000, postTokens: 12000 },
    })
  })

  it('uses the boundary uuid as the item id when the frame carries one', () => {
    // The replay derives `claude:compaction:<uuid>` from the JSONL entry. Using
    // the same id live means a boundary that is both on disk (before the
    // live turn's prompt) and on the stream is one item on the phone.
    const { m, events } = mapper()
    m.beginTurn('keep going', 'cmd-1')
    m.handle({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'boundary-1',
      compact_metadata: { trigger: 'auto' },
    })
    const item: any = events.filter(completed).at(-1)?.item
    expect(item).toMatchObject({ kind: 'compaction', id: 'claude:compaction:boundary-1' })
  })

  it('omits the counts a manual compaction did not report', () => {
    // `post_tokens` is absent on some compactions; a defaulted 0 would render
    // as "everything was dropped".
    const { m, events } = mapper()
    m.beginTurn('compact please', 'cmd-1')
    m.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 900 } })
    const item: any = events.filter(completed).at(-1)?.item
    expect(item).toMatchObject({ kind: 'compaction', trigger: 'manual', preTokens: 900 })
    expect(item.postTokens).toBeUndefined()
  })

  it('records nothing for a compaction with no turn open', () => {
    // An item belongs to a turn; inventing one to hold this card would put a
    // card in a turn the transcript never had.
    const { m, events } = mapper()
    m.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } })
    expect(events).toEqual([])
  })
})

describe('ClaudeEventMapper — streaming text', () => {
  it('streams deltas and closes the block once, ignoring the assistant echo', () => {
    const { m, events } = mapper()
    const { turnId } = m.beginTurn('count', 'cmd-1')

    m.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: MSG_ID } } })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    })
    for (const text of ['1\n', '2\n', '3']) {
      m.handle({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      })
    }
    // Captured ordering: the assistant frame lands BEFORE content_block_stop.
    m.handle({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: MSG_ID, content: [{ type: 'text', text: '1\n2\n3' }] },
    })
    m.handle({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })

    const deltas = events.filter((e) => e.kind === 'delta')
    expect(deltas.map((d: any) => d.text)).toEqual(['1\n', '2\n', '3'])
    expect(deltas.every((d: any) => d.channel === 'text')).toBe(true)

    // Exactly one card, or the phone shows the text twice: once as the streamed
    // card and once from the assistant frame.
    const cards = assistantCards(events)
    expect(cards).toHaveLength(1)
    expect((cards[0] as any).item).toEqual({
      kind: 'message',
      id: `claude:text:${MSG_ID}:0`,
      role: 'assistant',
      text: '1\n2\n3',
    })
    expect(turnId).toBeTruthy()
  })

  it('keeps the text card when the message also contains a tool call', () => {
    // Pins the captured block ordering, which the mapper depends on. Two facts
    // combine: the CLI emits ONE assistant frame PER BLOCK (so the tool_use
    // frame carries its block at array position 0 even though its live index
    // is 1), and a block's `content_block_stop` always arrives before the next
    // block's assistant frame. If a future CLI batched several blocks into one
    // frame, or reordered these, the text card would vanish silently — this
    // test turns that into a failure.
    const { m, events } = mapper()
    m.beginTurn('write it', 'cmd-1')

    m.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: MSG_ID } } })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'On it.' } },
    })
    m.handle({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_x', name: 'Read', input: {} },
      },
    })

    // Text frame first (position 0 == live index 0, the only coincidence).
    m.handle({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: MSG_ID, content: [{ type: 'text', text: 'On it.' }] },
    })
    m.handle({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })

    // Then the tool frame, whose position 0 must NOT be read as block 0.
    m.handle({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: MSG_ID,
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: 'a.ts' } }],
      },
    })

    const cards = assistantCards(events)
    expect(cards.map((c: any) => c.item.text)).toEqual(['On it.'])
  })

  it('uses the deltas for reasoning, because the assistant frame drops the text', () => {
    const { m, events } = mapper()
    m.beginTurn('think', 'cmd-1')
    m.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: MSG_ID } } })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    })
    // Captured verbatim: a thinking block's assistant frame carries EMPTY text
    // and only its signature. The deltas are the only copy that exists.
    m.handle({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: MSG_ID, content: [{ type: 'thinking', thinking: '', signature: MSG_ID }] },
    })
    m.handle({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })

    const reasoning = events.filter(completed).filter((e: any) => e.item.kind === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect((reasoning[0] as any).item).toEqual({
      kind: 'reasoning',
      id: `claude:reasoning:${MSG_ID}:0`,
      summary: [],
      content: ['hmm'],
    })
  })

  it('keeps the text already streamed when a turn dies mid-block', () => {
    // An interrupt means content_block_stop never arrives. Dropping the buffer
    // would erase text the user was already reading.
    const { m, events } = mapper()
    m.beginTurn('long', 'cmd-1')
    m.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: MSG_ID } } })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    })
    m.finish('interrupted')

    const cards = assistantCards(events)
    expect(cards).toHaveLength(1)
    expect((cards[0] as any).item.text).toBe('partial')
    expect(events).toContainEqual({
      kind: 'turn.completed',
      threadId: THREAD,
      turnId: 'id1',
      status: 'interrupted',
      error: null,
    })
  })

  it('ignores frames from a subagent, which are not expanded into the transcript', () => {
    const { m, events } = mapper()
    m.beginTurn('delegate', 'cmd-1')
    m.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'sub-msg' } } })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    })
    const before = events.length
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    })
    // Subagent text DOES stream on the same socket; only the assistant/user
    // frames are filtered, so this delta is expected to pass through.
    expect(events.length).toBeGreaterThan(before)

    const afterDelta = events.length
    m.handle({
      type: 'assistant',
      parent_tool_use_id: 'call_task',
      message: {
        id: 'sub-msg',
        content: [{ type: 'tool_use', id: 'sub_tool', name: 'Bash', input: { command: 'ls' } }],
      },
    })
    expect(events.length).toBe(afterDelta)
  })

  it('ignores an injected text block on a user frame', () => {
    // The CLI echoes a subagent's prompt onto the main thread. Rendering it
    // would show the user "saying" words they never typed.
    const { m, events } = mapper()
    m.beginTurn('real message', 'cmd-1')
    const before = events.length
    m.handle({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Count the files in the directory…' }] },
    })
    expect(events.length).toBe(before)
  })
})

describe('ClaudeEventMapper — tools', () => {
  /** Drive a tool call through to its result the way the wire does. */
  function runTool(m: ClaudeEventMapper, toolUseId: string, name: string, input: unknown) {
    m.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: MSG_ID } } })
    m.handle({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: toolUseId, name, input: {} },
      },
    })
    m.handle({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: MSG_ID, content: [{ type: 'tool_use', id: toolUseId, name, input }] },
    })
  }

  it('opens the card at content_block_start and completes it with the output', () => {
    const { m, events } = mapper()
    m.beginTurn('list', 'cmd-1')
    runTool(m, 'call_1', 'Bash', { command: 'ls -la' })

    const opened = events.filter(started)
    expect(opened).toHaveLength(1)
    expect((opened[0] as any).item).toMatchObject({ kind: 'command', id: 'claude:tool:call_1' })

    // Captured success shape: structured stdout/stderr, is_error absent.
    m.handle({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'total 640' }] },
      tool_use_result: {
        stdout: 'total 640',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    })

    const done = events.filter(completed).filter((e: any) => e.item.kind === 'command')
    expect(done).toHaveLength(1)
    expect((done[0] as any).item).toMatchObject({
      status: 'done',
      output: 'total 640',
      // No exit code exists in a success payload, so 0 is inferred.
      exitCode: 0,
    })
  })

  it('parses the exit code out of a failed command', () => {
    const { m, events } = mapper()
    m.beginTurn('fail', 'cmd-1')
    runTool(m, 'call_2', 'Bash', { command: 'exit 3' })
    m.handle({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_2', is_error: true, content: 'Exit code 3' }] },
      tool_use_result: 'Error: Exit code 3',
    })

    const done = events.filter(completed).filter((e: any) => e.item.kind === 'command')
    expect((done[0] as any).item).toMatchObject({ status: 'failed', output: 'Exit code 3', exitCode: 3 })
  })

  it('upgrades an Edit diff with the real structuredPatch when the frame has one', () => {
    const { m, events } = mapper()
    m.beginTurn('edit', 'cmd-1')
    runTool(m, 'call_3', 'Edit', {
      file_path: 'demo.txt',
      old_string: 'hello world',
      new_string: 'goodbye world',
    })
    m.handle({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_3', content: 'updated successfully' }] },
      tool_use_result: {
        filePath: 'demo.txt',
        oldString: 'hello world',
        newString: 'goodbye world',
        originalFile: 'hello world\n',
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-hello world', '+goodbye world'] },
        ],
      },
    })

    const done = events.filter(completed).filter((e: any) => e.item.kind === 'fileChange')
    expect((done[0] as any).item.changes[0].diff).toBe('@@ -1,1 +1,1 @@\n-hello world\n+goodbye world')
  })

  it('keeps the synthesized diff when the result has no structuredPatch', () => {
    // This is the replayed-session case: prose only, no structured output.
    const { m, events } = mapper()
    m.beginTurn('edit', 'cmd-1')
    runTool(m, 'call_4', 'Write', { file_path: 'demo.txt', content: 'hello' })
    m.handle({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_4', content: 'File created successfully' }] },
    })

    const done = events.filter(completed).filter((e: any) => e.item.kind === 'fileChange')
    expect((done[0] as any).item.changes[0].diff).toBe('+hello')
  })

  it('emits the structured plan alongside the TodoWrite card', () => {
    const { m, events } = mapper()
    const { turnId } = m.beginTurn('plan', 'cmd-1')
    runTool(m, 'call_5', 'TodoWrite', {
      todos: [{ content: 'Bake', status: 'in_progress', activeForm: 'Baking' }],
    })
    expect(events).toContainEqual({
      kind: 'plan.updated',
      threadId: THREAD,
      turnId,
      plan: [{ step: 'Bake', status: 'inProgress' }],
    })
  })

  it('feeds the subagent child count from task_progress rather than counting', () => {
    const { m, events } = mapper()
    m.beginTurn('delegate', 'cmd-1')
    runTool(m, 'call_6', 'Agent', { description: 'Count files', subagent_type: 'Explore' })
    m.handle({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'a651',
      tool_use_id: 'call_6',
      usage: { total_tokens: 13463, tool_uses: 1, duration_ms: 1252 },
      last_tool_name: 'Bash',
    })
    const updated = events.filter((e) => e.kind === 'item.updated').map((e: any) => e.item)
    expect(updated.at(-1)).toMatchObject({ kind: 'tool', childCount: 1 })
  })

  it('completes a subagent card with the status inside its structured result', () => {
    const { m, events } = mapper()
    m.beginTurn('delegate', 'cmd-1')
    runTool(m, 'call_7', 'Agent', { description: 'Count files', subagent_type: 'Explore' })
    m.handle({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_7', content: '1. Number of files: 1' }] },
      tool_use_result: { status: 'completed', prompt: 'Count the files…' },
    })
    const done = events.filter(completed).filter((e: any) => e.item.kind === 'tool')
    expect((done[0] as any).item).toMatchObject({ status: 'done', output: '1. Number of files: 1' })
  })

  it('drops the noisy per-token system frames', () => {
    const { m, events } = mapper()
    m.beginTurn('a', 'cmd-1')
    const before = events.length
    // 618 of these arrived in a single captured turn.
    m.handle({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1 })
    m.handle({ type: 'system', subtype: 'status', status: 'requesting' })
    m.handle({ type: 'command_lifecycle', state: 'queued', command_uuid: 'cmd-1' })
    expect(events.length).toBe(before)
  })
})

describe('ClaudeEventMapper — snapshots', () => {
  it('exposes the live items so a resumed session can replay them', () => {
    const { m } = mapper()
    const { turnId } = m.beginTurn('hi', 'cmd-1')
    m.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: MSG_ID } } })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    })
    m.handle({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    })
    m.handle({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })

    const items: AgentItem[] = m.items
    expect(items.map((i) => i.kind)).toEqual(['message', 'message'])
    expect(m.activeTurnId).toBe(turnId)
    expect(m.hasPendingWork).toBe(true)
  })
})

describe('API failure visibility', () => {
  it('accepts the actual SDK api_retry frame with snake_case fields', () => {
    const { m, events } = mapper()
    const { turnId } = m.beginTurn('task', 'sdk-retry')
    m.handle({
      type: 'system',
      subtype: 'api_retry',
      uuid: 'sdk-retry-uuid',
      attempt: 3,
      max_retries: 10,
      retry_delay_ms: 2300,
      error_status: 503,
      error: 'server_error',
    })
    expect(events.at(-1)).toMatchObject({
      kind: 'error',
      willRetry: true,
      retryAttempt: 3,
      maxRetries: 10,
      retryInMs: 2300,
      message: 'HTTP 503 · server_error',
    })
    expect(m.itemsForTurn(turnId).find((i) => i.kind === 'retry')).toMatchObject({
      kind: 'retry',
      attempts: [{ attempt: 3, delayMs: 2300 }],
    })
  })
  it('reports retry details without ending the turn, then retains a synthetic error without deltas', () => {
    const { m, events } = mapper()
    const { turnId } = m.beginTurn('task', 'failure-cmd')
    m.handle({
      type: 'system',
      subtype: 'api_error',
      error: { formatted: '503 unavailable' },
      retryAttempt: 2,
      maxRetries: 10,
      retryInMs: 1200,
    })
    expect(events.at(-1)).toMatchObject({
      kind: 'error',
      message: '503 unavailable',
      willRetry: true,
      retryAttempt: 2,
      maxRetries: 10,
      retryInMs: 1200,
    })
    expect(events.some((e) => e.kind === 'turn.completed')).toBe(false)
    m.handle({
      type: 'assistant',
      uuid: 'failure-uuid',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: 500 failed to validate API key' }] },
    })
    m.handle({ type: 'result', is_error: true, errors: ['API Error: 500 failed to validate API key'] })
    expect(m.itemsForTurn(turnId).filter((i) => i.kind === 'error')).toEqual([
      { kind: 'error', id: 'claude:error:failure-uuid', message: 'API Error: 500 failed to validate API key' },
    ])
    expect(events.find((e) => e.kind === 'turn.completed')).toMatchObject({
      status: 'failed',
      error: { message: 'API Error: 500 failed to validate API key' },
    })
  })
  it('renders crash failures without an assistant message', () => {
    const { m, events } = mapper()
    m.beginTurn('task', 'crash-cmd')
    m.finish('failed', 'process exited')
    m.finish('failed', 'process exited')
    expect(events.filter((e) => e.kind === 'item.completed' && e.item.kind === 'error')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'turn.completed')).toHaveLength(1)
  })
})
