import type { AgentItem, FileChange, ItemStatus, PlanStep, Usage } from '@vibemobile/protocol'

export function parseExitCode(text: string): number | null {
  // Bash reports failures as `is_error: true` with the literal text
  // "Exit code 3" (and a structured result of the string "Error: Exit code 3").
  // Success, by contrast, carries NO exit code at all — the structured result
  // is `{stdout, stderr, interrupted, isImage, noOutputExpected}`. So a success
  // is inferred rather than read, and anything unparseable stays null instead
  // of being invented.
  // Deliberately unanchored: the two shapes differ by a prefix ("Exit code 3"
  // vs "Error: Exit code 3"). Callers only reach this when the result is
  // already known to be an error, so a successful command that merely prints
  // the words "Exit code N" can never be misread as a failure.
  const match = /Exit code (\d+)/i.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * The result frame's `usage` → `Usage`, with the window from `modelUsage`.
 *
 * `input_tokens` here EXCLUDES the cache: measured (2026-10-15,
 * `scripts/probe-usage.ts`, two turns in one session) the second turn of a
 * 30k-token session reported 218 input against 29 952 `cache_read_input_tokens`.
 * The prompt that went to the model is the sum of the three input figures —
 * which is why the old `totalTokens: input + output` was reported as 220 for a
 * turn whose context was 30 170. Nothing consumed it, so nothing showed the
 * lie; a counter would have.
 */
export function mapResultUsage(u: any, modelUsage?: Record<string, any>): Usage {
  const input = u?.input_tokens ?? 0
  const cached = u?.cache_read_input_tokens ?? 0
  const cacheWrite = u?.cache_creation_input_tokens ?? 0
  const window = contextWindowOf(modelUsage)
  return {
    // Claude has no cumulative-per-session figure to report — each turn is its
    // own `query()` — so `sessionTokens` stays absent rather than being
    // invented from the turns this process happened to see.
    promptTokens: input + cached + cacheWrite,
    cachedTokens: cached,
    outputTokens: u?.output_tokens ?? 0,
    // The real source is nested here. Counting `system:thinking_tokens`
    // frames would over-report: they are estimates emitted during generation,
    // not the final tally.
    reasoningOutputTokens: u?.output_tokens_details?.thinking_tokens ?? 0,
    ...(window ? { contextWindow: window } : {}),
  }
}

/**
 * The context window of the model the turn actually ran on.
 *
 * `modelUsage` is keyed by model and can hold several entries (a subagent on a
 * different model adds its own), so this takes the largest rather than the
 * first: the frame's `usage` is main-loop-only, and a subagent's smaller window
 * must not shrink what the phone shows for the main thread. Reading the window
 * under a *key* (e.g. the session's model) would need the session's model
 * passed down here, and the session's model is exactly what the user can change
 * between turns.
 */
function contextWindowOf(modelUsage?: Record<string, any>): number | undefined {
  const windows = Object.values(modelUsage ?? {})
    .map((m: any) => m?.contextWindow)
    .filter((n: unknown): n is number => typeof n === 'number' && n > 0)
  return windows.length ? Math.max(...windows) : undefined
}

export function mapTaskStatus(status: unknown): ItemStatus {
  switch (status) {
    case 'completed':
    case 'success':
      return 'done'
    case 'failed':
    case 'error':
      return 'failed'
    case 'killed':
    case 'stopped':
      return 'declined'
    default:
      return 'running'
  }
}

export function mapItemStatusFromResult(isError: unknown, isSuccess = true): ItemStatus {
  if (isError) return 'failed'
  return isSuccess ? 'done' : 'running'
}

// -------------------------------------------------------------- tool mapping

/**
 * Tool names that get a dedicated card, and the name the UI shows. Anything not
 * listed here becomes the generic `tool` item rather than `unknown` — see the
 * note on `AgentItem`'s `tool` variant for why silence is the worse failure.
 */
export function toolDisplayTitle(name: string, input: any): string {
  switch (name) {
    case 'Bash':
      return String(input?.command ?? '命令')
        .split('\n')[0]
        .slice(0, 120)
    case 'Read':
      return `读取 ${shortPath(input?.file_path)}`
    case 'Write':
      return `写入 ${shortPath(input?.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `修改 ${shortPath(input?.file_path)}`
    case 'NotebookEdit':
      return `修改笔记本 ${shortPath(input?.notebook_path)}`
    case 'Glob':
      return `查找文件 ${input?.pattern ?? ''}`.trim()
    case 'Grep':
      return `搜索 ${input?.pattern ?? ''}`.trim()
    case 'WebSearch':
      return `搜索：${input?.query ?? ''}`
    case 'WebFetch':
      return `抓取 ${input?.url ?? ''}`
    case 'TodoWrite':
      return '更新计划'
    case 'Agent':
    case 'Task':
      return String(input?.description ?? '子代理')
    case 'AskUserQuestion':
      return String(input?.questions?.[0]?.question ?? '询问用户')
    default:
      return name
  }
}

/** Both spellings are live: `Task` is advertised in `system:init`, `Agent` is what arrives. */
export function isSubagentTool(name: string): boolean {
  return name === 'Agent' || name === 'Task'
}

function shortPath(p: unknown): string {
  if (typeof p !== 'string' || !p) return ''
  const parts = p.split(/[\\/]/)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

/**
 * Rebuild a unified-diff hunk from the SDK's `structuredPatch`, which is what
 * an Edit result carries on a LIVE frame:
 *   [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
 *      lines: ['-hello world', '+goodbye world'] }]
 * The `+`/`-` prefixes are already present in `lines`, which is exactly what
 * `DiffView` classifies on.
 */
export function renderStructuredPatch(patch: unknown): string {
  if (!Array.isArray(patch) || patch.length === 0) return ''
  return patch
    .map((hunk: any) => {
      const header = `@@ -${hunk?.oldStart ?? 0},${hunk?.oldLines ?? 0} +${hunk?.newStart ?? 0},${hunk?.newLines ?? 0} @@`
      const lines = Array.isArray(hunk?.lines) ? hunk.lines : []
      return [header, ...lines].join('\n')
    })
    .join('\n')
}

function asAddedLines(text: string): string {
  return text
    .split('\n')
    .map((l) => `+${l}`)
    .join('\n')
}

/**
 * Build the file change from the tool's INPUT.
 *
 * This is the path that always works. `tool_use_result` (with its
 * `structuredPatch`) is present on live frames but is NOT persisted into the
 * transcript — a replayed session gives only prose ("File created
 * successfully at …"). The input, however, is in both, so history renders a
 * real diff and the live frame merely upgrades its fidelity.
 */
export function fileChangesFromInput(name: string, input: any): FileChange[] {
  if (name === 'Write') {
    const path = String(input?.file_path ?? '')
    if (!path) return []
    return [{ path, kind: 'add', diff: asAddedLines(String(input?.content ?? '')) }]
  }

  if (name === 'Edit') {
    const path = String(input?.file_path ?? '')
    if (!path) return []
    const oldText = String(input?.old_string ?? '')
    const newText = String(input?.new_string ?? '')
    const removed = oldText
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => `-${l}`)
    const added = newText
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => `+${l}`)
    return [{ path, kind: 'update', diff: ['@@', ...removed, ...added].join('\n') }]
  }

  if (name === 'MultiEdit') {
    const path = String(input?.file_path ?? '')
    const edits = Array.isArray(input?.edits) ? input.edits : []
    return edits.map((e: any) => ({
      path,
      kind: 'update' as const,
      diff: [
        '@@',
        ...String(e?.old_string ?? '')
          .split('\n')
          .filter(Boolean)
          .map((l) => `-${l}`),
        ...String(e?.new_string ?? '')
          .split('\n')
          .filter(Boolean)
          .map((l) => `+${l}`),
      ].join('\n'),
    }))
  }

  return []
}

/** `TodoWrite` input -> the protocol's structured plan. */
export function planFromTodos(input: any): PlanStep[] {
  const todos = Array.isArray(input?.todos) ? input.todos : []
  return todos.map((t: any) => ({
    step: String(t?.content ?? t?.activeForm ?? ''),
    status: t?.status === 'completed' ? 'completed' : t?.status === 'in_progress' ? 'inProgress' : 'pending',
  }))
}

/** Split `mcp__server__tool` into its parts. */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const sep = rest.indexOf('__')
  if (sep === -1) return { server: rest, tool: '' }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/**
 * One tool call -> one card. This is the "smart mapping" half of the design:
 * five tools get rich, purpose-built cards and everything else still renders,
 * with its arguments and output, instead of vanishing.
 */
export function mapToolItem(args: { toolUseId: string; name: string; input: any; status: ItemStatus }): AgentItem {
  const { toolUseId, name, input, status } = args
  const id = `claude:tool:${toolUseId}`

  if (name === 'Bash') {
    return {
      kind: 'command',
      id,
      command: String(input?.command ?? ''),
      cwd: typeof input?.cwd === 'string' ? input.cwd : null,
      status,
      output: '',
      exitCode: null,
      durationMs: null,
    }
  }

  if (name === 'WebSearch') {
    return { kind: 'webSearch', id, query: String(input?.query ?? ''), status }
  }

  const mcp = parseMcpName(name)
  if (mcp) {
    return {
      kind: 'mcpTool',
      id,
      server: mcp.server,
      tool: mcp.tool,
      status,
      args: input,
    }
  }

  if (name === 'TodoWrite') {
    return { kind: 'plan', id, text: planFromTodos(input).map(formatPlanStep).join('\n') }
  }

  const changes = fileChangesFromInput(name, input)
  if (changes.length) {
    return { kind: 'fileChange', id, status, changes }
  }

  return {
    kind: 'tool',
    id,
    name,
    title: toolDisplayTitle(name, input),
    status,
    input,
    subagentType: isSubagentTool(name) ? String(input?.subagent_type ?? '') || null : null,
    childCount: 0,
  }
}

function formatPlanStep(step: PlanStep): string {
  const box = step.status === 'completed' ? '[x]' : step.status === 'inProgress' ? '[~]' : '[ ]'
  return `${box} ${step.step}`
}

/**
 * Fold a tool result into its card, upgrading fidelity where the structured
 * payload allows it.
 *
 * `structured` is the SDK's parsed `tool_use_result`. It is present on live
 * frames and ABSENT in a replayed transcript (the JSONL keeps only prose:
 * "File created successfully at …"), and it is the sole source of a real
 * `structuredPatch` diff. So the input-based diff from `fileChangesFromInput`
 * is always built first and only improved here, never replaced by nothing.
 *
 * Exported because the transcript builder needs exactly this merge for
 * history — two implementations would drift and the phone would show
 * different cards for the same call depending on whether it was replayed.
 */
export function applyToolResult(item: AgentItem, structured: unknown, text: string, isError: boolean): AgentItem {
  if (item.kind === 'command') {
    const stdout = (structured as any)?.stdout
    const stderr = (structured as any)?.stderr
    const output = isError ? text : typeof stdout === 'string' ? [stdout, stderr].filter(Boolean).join('\n') : text
    return {
      ...item,
      status: isError ? 'failed' : 'done',
      output,
      // A success carries no exit code anywhere in the payload, so 0 is
      // inferred; a failure states it as "Exit code N" in its text.
      exitCode: isError ? parseExitCode(text) : 0,
    }
  }

  if (item.kind === 'fileChange') {
    const patch = renderStructuredPatch((structured as any)?.structuredPatch)
    return {
      ...item,
      status: isError ? 'failed' : 'done',
      changes: patch ? item.changes.map((c, i) => (i === 0 ? { ...c, diff: patch } : c)) : item.changes,
    }
  }

  if (item.kind === 'tool') {
    const status = structured as any
    return {
      ...item,
      status: isError ? 'failed' : mapTaskStatus(status?.status ?? 'completed'),
      output: text || undefined,
      error: isError ? text : undefined,
      childCount: status?.tool_uses ?? item.childCount,
    }
  }

  if (item.kind === 'webSearch') {
    return { ...item, status: isError ? 'failed' : 'done' }
  }

  if (item.kind === 'mcpTool') {
    return {
      ...item,
      status: isError ? 'failed' : 'done',
      result: text,
      error: isError ? text : undefined,
    }
  }

  return item
}

// ------------------------------------------------------------------- mapper

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}
