/**
 * Pure opencode tool-state -> AgentItem mapping.
 *
 * Shared by the live mapper and the transcript reader so a completed live card
 * and the same card after a reload are identical. The important case is
 * `edit`/`write`: opencode reports the unified diff in
 * `metadata.files[].patch`, and without mapping it to `fileChange` the phone
 * shows only a generic "edit" card with no path or diff.
 */
import path from 'node:path'
import type { AgentItem, FileChange, ItemStatus } from '@vibemobile/protocol'
import type { OpencodeToolContent, OpencodeToolState } from './types.js'

export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const value = part as { type?: unknown; text?: unknown; uri?: unknown }
      if (value.type === 'text' && typeof value.text === 'string') return value.text
      if (value.type === 'file' && typeof value.uri === 'string') return value.uri
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function metadataOutput(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return ''
  for (const key of ['output', 'stdout', 'result']) {
    const value = metadata[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function itemStatus(state: OpencodeToolState): ItemStatus {
  if (state.status === 'completed') return 'done'
  if (state.status === 'error') return 'failed'
  return 'running'
}

function stateMetadata(state: OpencodeToolState): Record<string, unknown> | undefined {
  return state.status === 'streaming' ? undefined : state.metadata
}

function commandName(name: string): boolean {
  return /^(bash|shell|execute|terminal)$/i.test(name) || /(^|_)(bash|shell|execute)$/i.test(name)
}

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

function resolvePath(cwd: string | undefined, value: string): string {
  return cwd && !path.isAbsolute(value) ? path.resolve(cwd, value) : value
}

function kindFromPatch(patch: string): FileChange['kind'] {
  if (/^--- \/dev\/null/m.test(patch) || /^new file mode/m.test(patch)) return 'add'
  if (/^\+\+\+ \/dev\/null/m.test(patch) || /^deleted file mode/m.test(patch)) return 'delete'
  return 'update'
}

function constructDiff(name: string, file: string, input: Record<string, unknown>): string {
  const oldText = firstString(input, ['oldString', 'old_str', 'oldText'])
  const newText = firstString(input, ['newString', 'new_str', 'newText'])
  const content = firstString(input, ['content', 'text', 'newText'])
  if (name === 'write' && content !== null && oldText === null) {
    const lines = content.split('\n').map((line) => `+${line}`)
    return `--- /dev/null\n+++ b/${file}\n@@\n${lines.join('\n')}`
  }
  if (oldText !== null || newText !== null) {
    const removed = (oldText ?? '').split('\n').map((line) => `-${line}`)
    const added = (newText ?? '').split('\n').map((line) => `+${line}`)
    return `--- a/${file}\n+++ b/${file}\n@@\n${[...removed, ...added].join('\n')}`
  }
  if (content !== null) {
    const lines = content.split('\n').map((line) => `+${line}`)
    return `--- /dev/null\n+++ b/${file}\n@@\n${lines.join('\n')}`
  }
  return ''
}

function fileChanges(
  name: string,
  input: unknown,
  metadata: Record<string, unknown> | undefined,
  cwd: string | undefined,
): FileChange[] {
  const record = inputRecord(input)
  const changes: FileChange[] = []

  const listed = metadata?.files
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      if (typeof entry !== 'object' || entry === null) continue
      const file = entry as Record<string, unknown>
      const filePath = firstString(file, ['file', 'path', 'filePath'])
      if (!filePath) continue
      const patch = firstString(file, ['patch', 'diff'])
      const resolved = resolvePath(cwd, filePath)
      changes.push({
        path: resolved,
        kind: patch ? kindFromPatch(patch) : name === 'write' ? 'add' : 'update',
        diff: patch ?? constructDiff(name, resolved, record),
      })
    }
  }

  if (changes.length > 0) return changes
  if (!/^(edit|write|patch|multiedit|apply_patch)$/i.test(name)) return []

  const filePath = firstString(record, ['filePath', 'path', 'file'])
  if (!filePath) return []
  const resolved = resolvePath(cwd, filePath)
  return [
    {
      path: resolved,
      kind: name === 'write' && firstString(record, ['oldString', 'old_str', 'oldText']) === null ? 'add' : 'update',
      diff: constructDiff(name, resolved, record),
    },
  ]
}

function titleFor(name: string, input: unknown): string {
  const record = inputRecord(input)
  const filePath = firstString(record, ['path', 'filePath', 'file'])
  if (/^read$/i.test(name) && filePath) return `读取 ${filePath}`
  if (/^(glob|grep|list)$/i.test(name)) {
    const pattern = firstString(record, ['pattern', 'query'])
    if (pattern) return `${name} ${pattern}`
  }
  return name
}

export function toolItem(id: string, name: string, state: OpencodeToolState, cwd: string | undefined): AgentItem {
  if (commandName(name)) {
    const input = inputRecord(state.input)
    const command = firstString(input, ['command', 'cmd', 'script']) ?? ''
    const metadata = stateMetadata(state)
    const exitCandidate = metadata?.exitCode ?? metadata?.exit
    const output =
      state.status === 'completed' || state.status === 'error'
        ? contentText(state.content) || metadataOutput(metadata)
        : ''
    return {
      kind: 'command',
      id: `oc:tool:${id}`,
      command,
      ...(cwd ? { cwd } : {}),
      status: itemStatus(state),
      output,
      ...(typeof exitCandidate === 'number' ? { exitCode: exitCandidate } : {}),
    }
  }

  const changes = fileChanges(name, state.input, stateMetadata(state), cwd)
  if (changes.length > 0) {
    return { kind: 'fileChange', id: `oc:tool:${id}`, status: itemStatus(state), changes }
  }

  return {
    kind: 'tool',
    id: `oc:tool:${id}`,
    name,
    title: titleFor(name, state.input),
    status: itemStatus(state),
    input: state.input,
    ...(state.status === 'completed' || state.status === 'error'
      ? { output: contentText(state.content) || metadataOutput(stateMetadata(state)) }
      : {}),
    ...(state.status === 'error' ? { error: state.error.message } : {}),
  }
}

export type { OpencodeToolContent }
