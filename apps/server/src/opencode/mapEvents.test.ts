import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@vibemobile/protocol'
import { OpencodeEventMapper } from './mapEvents.js'
import { FORM_REQUEST_PREFIX, PERMISSION_REQUEST_PREFIX } from './permission.js'
import type { OpencodeEventFrame, OpencodeInboxUser } from './types.js'

function harness() {
  const events: AgentEvent[] = []
  const mapper = new OpencodeEventMapper({
    emit: (event) => events.push(event),
    cwdOf: () => 'D:/w',
    contextWindowOf: () => 200_000,
  })
  let created = 0
  const frame = (type: string, data: Record<string, unknown>): OpencodeEventFrame => ({
    id: `e${++created}`,
    created: ++created,
    type,
    data,
  })
  const inbox: OpencodeInboxUser = {
    id: 'msg_u',
    sessionID: 'ses_1',
    time: { created: 1 },
    type: 'user',
    payload: { text: 'hi' },
    delivery: 'steer',
  }
  return { events, mapper, frame, inbox }
}

describe('opencode event mapper', () => {
  it('turns text, tools and execution ends into normalized events', () => {
    const { events, mapper, frame, inbox } = harness()
    mapper.track('ses_1')
    mapper.beginTurn('ses_1', inbox)

    mapper.handle(frame('session.execution.started', { sessionID: 'ses_1' }))
    mapper.handle(frame('session.text.started', { sessionID: 'ses_1', assistantMessageID: 'msg_a', ordinal: 0 }))
    mapper.handle(
      frame('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_a', ordinal: 0, delta: 'po' }),
    )
    mapper.handle(
      frame('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_a', ordinal: 0, delta: 'ng' }),
    )
    mapper.handle(
      frame('session.text.ended', { sessionID: 'ses_1', assistantMessageID: 'msg_a', ordinal: 0, text: 'pong' }),
    )
    mapper.handle(
      frame('session.tool.input.started', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_1',
        name: 'shell',
      }),
    )
    mapper.handle(
      frame('session.tool.called', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_1',
        input: { command: 'echo hi' },
      }),
    )
    mapper.handle(
      frame('session.tool.success', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_1',
        content: [{ type: 'text', text: 'hi' }],
      }),
    )
    mapper.handle(
      frame('session.step.ended', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 20, write: 0 } },
      }),
    )
    mapper.handle(frame('session.execution.succeeded', { sessionID: 'ses_1' }))

    const kinds = events.map((event) => event.kind)
    expect(kinds).toContain('turn.started')
    expect(kinds).toContain('turn.completed')
    expect(kinds).toContain('usage.updated')
    expect(events.filter((event) => event.kind === 'delta').map((event) => event.text)).toEqual(['po', 'ng'])

    const textItem = events.find(
      (event) => event.kind === 'item.completed' && event.item.kind === 'message' && event.item.role === 'assistant',
    )
    expect(textItem?.kind === 'item.completed' && textItem.item.kind === 'message' && textItem.item.text).toBe('pong')

    const command = events.find((event) => event.kind === 'item.completed' && event.item.kind === 'command')
    expect(command?.kind === 'item.completed' && command.item.kind === 'command' && command.item.output).toBe('hi')

    const usage = events.find((event) => event.kind === 'usage.updated')
    expect(usage?.kind === 'usage.updated' && usage.usage.promptTokens).toBe(30)
    expect(mapper.itemsFor('ses_1').map((item) => item.id)).toContain('oc:tool:call_1')
    expect(mapper.isRunning('ses_1')).toBe(false)
  })

  it('keeps tool arguments and command output when the result event omits input', () => {
    const { events, mapper, frame, inbox } = harness()
    mapper.track('ses_1')
    mapper.beginTurn('ses_1', inbox)
    mapper.handle(frame('session.execution.started', { sessionID: 'ses_1' }))

    mapper.handle(
      frame('session.tool.input.started', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_shell',
        name: 'shell',
      }),
    )
    mapper.handle(
      frame('session.tool.called', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_shell',
        input: { command: 'ls -la' },
      }),
    )
    // success carries content/metadata only — no input, no name.
    mapper.handle(
      frame('session.tool.success', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_shell',
        content: [{ type: 'text', text: 'file-a' }],
        metadata: { exitCode: 0 },
      }),
    )
    const command = events.find((event) => event.kind === 'item.completed' && event.item.kind === 'command')
    expect(command?.kind === 'item.completed' && command.item.kind === 'command' ? command.item.command : null).toBe(
      'ls -la',
    )
    expect(command?.kind === 'item.completed' && command.item.kind === 'command' ? command.item.output : null).toBe(
      'file-a',
    )
    expect(command?.kind === 'item.completed' && command.item.kind === 'command' ? command.item.exitCode : null).toBe(0)

    mapper.handle(
      frame('session.tool.input.started', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_edit',
        name: 'edit',
      }),
    )
    mapper.handle(
      frame('session.tool.called', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_edit',
        input: { filePath: 'test.txt', oldString: 'foo', newString: 'bar' },
      }),
    )
    mapper.handle(
      frame('session.tool.success', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_edit',
        content: [{ type: 'text', text: 'Edited test.txt' }],
        metadata: {
          files: [{ file: 'test.txt', patch: 'Index: test.txt\n--- a/test.txt\n+++ b/test.txt\n@@\n-foo\n+bar' }],
        },
      }),
    )
    const edit = events.find(
      (event) =>
        event.kind === 'item.completed' && event.item.kind === 'fileChange' && event.item.id === 'oc:tool:call_edit',
    )
    expect(edit?.kind === 'item.completed' && edit.item.kind === 'fileChange' ? edit.item.changes : null).toEqual([
      expect.objectContaining({
        path: expect.stringContaining('test.txt'),
        kind: 'update',
        diff: expect.stringContaining('-foo'),
      }),
    ])

    mapper.handle(
      frame('session.tool.input.started', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_read',
        name: 'read',
      }),
    )
    mapper.handle(
      frame('session.tool.called', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_read',
        input: { path: 'a.txt' },
      }),
    )
    mapper.handle(
      frame('session.tool.success', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'call_read',
        content: [{ type: 'text', text: 'hello' }],
      }),
    )
    const read = events.find(
      (event) => event.kind === 'item.completed' && event.item.kind === 'tool' && event.item.id === 'oc:tool:call_read',
    )
    expect(read?.kind === 'item.completed' && read.item.kind === 'tool' ? read.item.input : null).toEqual({
      path: 'a.txt',
    })
    expect(read?.kind === 'item.completed' && read.item.kind === 'tool' ? read.item.output : null).toBe('hello')
    expect(read?.kind === 'item.completed' && read.item.kind === 'tool' ? read.item.title : null).toBe('读取 a.txt')
  })

  it('folds a steered message into the running turn and completes on interruption', () => {
    const { events, mapper, frame, inbox } = harness()
    mapper.track('ses_1')
    const turnId = mapper.beginTurn('ses_1', inbox)
    mapper.handle(frame('session.execution.started', { sessionID: 'ses_1' }))
    mapper.handle(
      frame('session.inbox.enqueued', {
        sessionID: 'ses_1',
        inboxID: 'msg_steer',
        item: { type: 'user', payload: { text: 'also' }, delivery: 'steer' },
      }),
    )
    const steerItem = events.find(
      (event) =>
        event.kind === 'item.started' && event.item.kind === 'message' && event.item.id === 'oc:user:msg_steer',
    )
    expect(steerItem?.kind === 'item.started' ? steerItem.turnId : null).toBe(turnId)

    mapper.handle(frame('session.execution.interrupted', { sessionID: 'ses_1' }))
    const completed = events.find((event) => event.kind === 'turn.completed')
    expect(completed?.kind === 'turn.completed' ? completed.status : null).toBe('interrupted')
  })

  it('does not complete a turn on session.idle', () => {
    const { events, mapper, frame, inbox } = harness()
    mapper.track('ses_1')
    mapper.beginTurn('ses_1', inbox)
    mapper.handle(frame('session.execution.started', { sessionID: 'ses_1' }))
    mapper.handle(frame('session.idle', { sessionID: 'ses_1' }))
    expect(events.some((event) => event.kind === 'turn.completed')).toBe(false)
    expect(mapper.isRunning('ses_1')).toBe(true)
  })

  it('maps permissions and forms into pending sheets and back', () => {
    const { events, mapper, frame, inbox } = harness()
    mapper.track('ses_1')
    mapper.beginTurn('ses_1', inbox)

    mapper.handle(
      frame('permission.asked', {
        id: 'per_1',
        sessionID: 'ses_1',
        action: 'shell',
        resources: ['cat .env'],
        source: { type: 'tool', messageID: 'msg_a', id: 'call_1' },
      }),
    )
    const permission = mapper.pending(`${PERMISSION_REQUEST_PREFIX}per_1`)
    expect(permission?.kind).toBe('permission')
    expect(mapper.permissionReply('accept')).toBe('once')
    expect(mapper.permissionReply('acceptForSession')).toBe('always')
    expect(mapper.permissionReply('decline')).toBe('reject')
    expect(events.some((event) => event.kind === 'approval.requested')).toBe(true)

    mapper.handle(frame('permission.replied', { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' }))
    expect(mapper.pending(`${PERMISSION_REQUEST_PREFIX}per_1`)).toBeUndefined()
    expect(events.some((event) => event.kind === 'approval.resolved')).toBe(true)

    mapper.handle(
      frame('form.created', {
        form: {
          id: 'frm_1',
          sessionID: 'ses_1',
          title: 'Questions',
          fields: [
            {
              key: 'q0',
              title: 'Colour',
              type: 'string',
              options: [
                { value: 'red', label: 'Red' },
                { value: 'blue', label: 'Blue' },
              ],
            },
          ],
        },
      }),
    )
    const form = mapper.pending(`${FORM_REQUEST_PREFIX}frm_1`)
    expect(form?.kind).toBe('form')
    expect(form?.approval.questions?.[0]?.options.map((option) => option.label)).toEqual(['Red', 'Blue'])
    expect(mapper.formAnswer(`${FORM_REQUEST_PREFIX}frm_1`, [['Blue']])).toEqual({ q0: 'blue' })
  })

  it('ignores sessions it was never asked to track', () => {
    const { events, mapper, frame } = harness()
    mapper.handle(frame('session.execution.started', { sessionID: 'ses_unknown' }))
    expect(events).toEqual([])
    expect(mapper.tracked('ses_unknown')).toBe(false)
  })

  it('resolves pending approvals when an execution ends', () => {
    const { events, mapper, frame, inbox } = harness()
    mapper.track('ses_1')
    mapper.beginTurn('ses_1', inbox)
    mapper.handle(
      frame('permission.asked', {
        id: 'per_1',
        sessionID: 'ses_1',
        action: 'shell',
        resources: ['x'],
      }),
    )
    mapper.handle(frame('session.execution.failed', { sessionID: 'ses_1', error: { type: 'api', message: 'boom' } }))
    expect(mapper.pending(`${PERMISSION_REQUEST_PREFIX}per_1`)).toBeUndefined()
    expect(events.filter((event) => event.kind === 'approval.resolved')).toHaveLength(1)
  })
})
