import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { AgentEvent } from '@vibemobile/protocol'
import { expect, it } from 'vitest'
import { AgyTranscript } from './transcript.js'

const read = {
  sessionUpdate: 'tool_call',
  toolCallId: 'r',
  kind: 'read',
  name: 'read_file',
  title: 'File src/kernel.cpp',
  rawInput: { Path: 'src/kernel.cpp', StartLine: 8, EndLine: 12 },
} satisfies SessionUpdate
const command = {
  sessionUpdate: 'tool_call',
  toolCallId: 'c',
  name: 'run_command',
  kind: 'execute',
  title: 'Run command',
  rawInput: { CommandLine: 'ls -la build; grep -n clock build/log' },
} satisfies SessionUpdate
const edit = {
  sessionUpdate: 'tool_call',
  toolCallId: 'e',
  name: 'edit_file',
  kind: 'edit',
  title: 'File src/kernel.cpp',
  rawInput: { Path: 'src/kernel.cpp', Target: 'old', Replacement: 'new' },
} satisfies SessionUpdate
const patch = { type: 'diff', path: 'src/kernel.cpp', oldText: 'old\ncontext\n', newText: 'new\ncontext\n' } as const

it('produces the same ordered cards from sparse live updates and completed ACP replay', () => {
  const thread = 'agy:tools'
  const events: AgentEvent[] = []
  const live = new AgyTranscript(thread, (event) => events.push(structuredClone(event)))
  live.live = true
  for (const frame of [read, command, edit]) live.update(frame)
  live.update({ sessionUpdate: 'tool_call_update', toolCallId: 'r', name: null, status: 'completed' })
  live.update({ sessionUpdate: 'tool_call_update', toolCallId: 'e', content: [patch] })
  live.update({ sessionUpdate: 'tool_call_update', toolCallId: 'e', status: 'completed' })
  const rawOutput = { exit_code: 0, output: 'clock' }
  live.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c', rawOutput, status: 'completed' })
  live.finish('completed')
  const history = new AgyTranscript(thread, () => {
    throw new Error('history emitted a live event')
  })
  history.update({ ...read, status: 'completed' })
  history.update({ ...command, rawOutput, status: 'completed' })
  history.update({ ...edit, content: [patch], status: 'completed' })
  expect(live.turn?.items).toEqual(history.turn?.items)
  expect(live.turn?.items).toMatchObject([
    { kind: 'tool', label: '读取文件', title: 'kernel.cpp:8–12 · src', status: 'done', input: read.rawInput },
    { kind: 'command', command: command.rawInput.CommandLine, exitCode: 0, output: 'clock' },
    {
      kind: 'fileChange',
      label: '编辑文件',
      changes: [{ path: patch.path, kind: 'update', diff: expect.stringContaining('-old\n+new\n context') }],
    },
  ])
  const editEvents = events.filter((event) => 'item' in event && event.item.id.endsWith(':tool:e'))
  expect(editEvents.map((event) => event.kind)).toEqual(['item.started', 'item.updated', 'item.completed'])
  expect(live.page({ targetItems: 1 }).turns[0].items).toEqual(history.turn?.items.slice(-1))
})

it('distinguishes writes, web queries and other named actions and keeps failed tool details', () => {
  const history = new AgyTranscript('agy:tools', () => {})
  history.update({
    ...edit,
    name: 'write_file',
    status: 'completed',
    content: [{ type: 'diff', path: 'new.txt', newText: 'hello' }],
  })
  history.update({ ...command, status: 'completed', rawOutput: { exit_code: 2, output: 'bad flag' } })
  history.update({
    ...read,
    name: 'search_web',
    kind: 'search',
    rawInput: { query: 'example' },
    rawOutput: 'one result',
    status: 'completed',
  })
  history.update({ ...edit, toolCallId: 'err', status: 'failed', rawOutput: 'File is locked' })
  history.update({
    sessionUpdate: 'tool_call',
    toolCallId: 's',
    name: 'invoke_subagent',
    kind: 'execute',
    title: 'Review changes',
  })
  history.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'x',
    name: 'plugin_custom',
    kind: 'other',
    title: 'Preview data',
  })
  history.finish('interrupted')
  expect(history.turn?.items).toMatchObject([
    {
      kind: 'fileChange',
      label: '写入文件',
      changes: [{ path: 'new.txt', kind: 'add', diff: expect.stringContaining('+hello') }],
    },
    { kind: 'command', status: 'failed', exitCode: 2, output: 'bad flag' },
    { kind: 'webSearch', query: 'example', output: 'one result' },
    { kind: 'tool', label: '编辑文件', status: 'failed', output: 'File is locked' },
    { kind: 'tool', label: '调用子代理', status: 'declined' },
    { kind: 'tool', label: 'plugin_custom', title: 'Preview data', status: 'declined' },
  ])
})
