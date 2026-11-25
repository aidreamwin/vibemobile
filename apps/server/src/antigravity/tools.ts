import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk'
import type { AgentItem, FileChange, ItemStatus } from '@vibemobile/protocol'

const kindLabels: Record<ToolKind, string> = {
  read: '读取文件',
  edit: '编辑文件',
  delete: '删除文件',
  move: '移动文件',
  search: '搜索',
  execute: '命令',
  think: '思考',
  fetch: '获取内容',
  switch_mode: '切换模式',
  other: '工具',
}

const toolLabels = new Map([
  ['read_file', '读取文件'],
  ['write_file', '写入文件'],
  ['edit_file', '编辑文件'],
  ['run_workflow', '运行工作流'],
  ['manage_task', '管理任务'],
  ['update_steps', '更新计划'],
  ['send_message', '发送消息'],
  ['schedule', '定时任务'],
  ['invoke_subagent', '调用子代理'],
  ['define_subagent', '定义子代理'],
  ['manage_subagents', '管理子代理'],
  ['swarm', '代理协作'],
  ['ask_question', '询问用户'],
])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function string(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** ACP updates may contain only a new status. Null leaves the previous field in place. */
export function mergeToolCall(previous: ToolCallUpdate | undefined, update: ToolCallUpdate): ToolCallUpdate {
  return {
    toolCallId: update.toolCallId,
    name: update.name ?? previous?.name,
    kind: update.kind ?? previous?.kind,
    title: update.title ?? previous?.title,
    status: update.status ?? previous?.status,
    rawInput: update.rawInput ?? previous?.rawInput,
    rawOutput: update.rawOutput ?? previous?.rawOutput,
    locations: update.locations ?? previous?.locations,
    content: update.content ?? previous?.content,
  }
}

function fileSummary(file: string, start: unknown, end: unknown): string {
  const parsed = path.posix.parse(file.replaceAll('\\', '/'))
  const lines = typeof start === 'number' ? `:${start}${typeof end === 'number' && end > start ? `–${end}` : ''}` : ''
  return [`${parsed.base || file}${lines}`, parsed.dir].filter(Boolean).join(' · ')
}

function toolOutput(call: ToolCallUpdate): string | undefined {
  const parts = call.content?.flatMap((block) => {
    if (block.type === 'content' && block.content.type === 'text') return [block.content.text]
    if (block.type === 'diff') return [`${block.path}\n${block.newText}`]
    return []
  })
  if (parts?.length) return parts.join('\n')
  const raw = call.rawOutput
  if (raw == null || typeof raw === 'string') return raw ?? undefined
  const output = record(raw).output
  return typeof output === 'string' ? output : JSON.stringify(raw)
}

type ToolItem = Extract<AgentItem, { kind: 'command' | 'fileChange' | 'webSearch' | 'tool' }>

export function toolItem(id: string, call: ToolCallUpdate): ToolItem {
  const status: ItemStatus = call.status === 'completed' ? 'done' : call.status === 'failed' ? 'failed' : 'running'
  const input = record(call.rawInput)
  const command = string(input.CommandLine) ?? string(input.command)
  // Some non-shell tools (e.g. invoke_subagent) also report the execute kind.
  if (call.name === 'run_command' || (call.kind === 'execute' && (!call.name || command))) {
    const exitCode = record(call.rawOutput).exit_code
    return {
      id,
      kind: 'command',
      command: command ?? call.title ?? '',
      cwd: string(input.Cwd),
      status: status === 'done' && typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : status,
      output: toolOutput(call) ?? '',
      exitCode: typeof exitCode === 'number' ? exitCode : null,
    }
  }

  if (call.name === 'search_web') {
    return { id, kind: 'webSearch', status, query: string(input.query) ?? call.title ?? '', output: toolOutput(call) }
  }

  const name = call.name || call.kind || 'tool'
  const label =
    toolLabels.get(name) ?? (call.kind && call.kind !== 'other' ? kindLabels[call.kind] : call.name || '工具')
  const diffs = call.content?.filter((block) => block.type === 'diff')
  if (status !== 'failed' && diffs?.length) {
    const changes: FileChange[] = []
    for (const { path, oldText, newText } of diffs) {
      const kind = call.kind === 'delete' ? 'delete' : oldText == null ? 'add' : 'update'
      // Full-file snapshots can be large during replay. Fall back to the native
      // tool details if computing a patch would hold up other runner sessions.
      const diff = createTwoFilesPatch(
        kind === 'add' ? '/dev/null' : path,
        kind === 'delete' ? '/dev/null' : path,
        oldText ?? '',
        newText,
        undefined,
        undefined,
        { timeout: 50 },
      )
      if (diff === undefined) break
      changes.push({ path, kind, diff })
    }
    if (changes.length === diffs.length) return { id, kind: 'fileChange', label, status, changes }
  }

  const location = call.locations?.[0]
  const file = string(input.Path) ?? location?.path
  const title = file
    ? fileSummary(file, input.StartLine ?? location?.line, input.EndLine)
    : (string(input.query) ?? string(input.Description) ?? string(input.Action) ?? call.title ?? name)
  return {
    id,
    kind: 'tool',
    status,
    name,
    label,
    title,
    input: call.rawInput ?? call.locations,
    output: toolOutput(call),
  }
}
