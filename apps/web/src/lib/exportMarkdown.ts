/**
 * Turn a normalized transcript into a Markdown file the user can keep.
 *
 * Everything is rendered from `AgentItem`s, so both providers produce the same
 * document. The output is plain Markdown (no HTML), which keeps it readable in
 * any editor and safe to open in a browser preview.
 */
import type { AgentItem, SessionSummary, TranscriptTurn } from '@vibemobile/protocol'
import type { Stream } from './store'

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

const STATUS: Record<string, string> = {
  running: '进行中',
  done: '完成',
  failed: '失败',
  declined: '已拒绝',
}

export type ExportMode = 'conversation' | 'full'

export function sessionMarkdown(session: SessionSummary, turns: TranscriptTurn[], mode: ExportMode = 'full'): string {
  const lines = [`# ${session.title || '未命名会话'}`, '', ...meta(session)]
  let shown = 0
  for (const turn of turns) {
    const body = itemsMarkdown(turn.items, {}, mode)
    // Conversation mode can leave a turn with only tool cards; an empty
    // numbered heading would look like a lost turn.
    if (body.length === 0) continue
    shown += 1
    lines.push('', '---', '', `## 第 ${shown} 轮`, '', ...body)
  }
  return finish(lines)
}

/**
 * Only the dialogue of a turn — user and assistant messages, no reasoning,
 * commands, tools, diffs or other cards. Used by the copy button, where the
 * user wants the conversation rather than a full export.
 */
export function conversationText(items: AgentItem[], streams: Record<string, Stream> = {}): string {
  const parts: string[] = []
  for (const item of items) {
    if (item.kind !== 'message') continue
    const stream = streams[item.id]
    const streamed = item.text.length === 0 && stream?.channel === 'text' ? stream.text : ''
    const text = (item.text || streamed).trim()
    if (!text) continue
    parts.push(`${item.role === 'user' ? '**用户**' : '**助手**'}\n\n${text}`)
  }
  return parts.length ? `${parts.join('\n\n')}\n` : ''
}

/**
 * A single turn, rendered from the items the phone has loaded. `streams` is
 * only needed when the turn is still running: its text may live in the delta
 * buffer rather than in the item.
 */
export function turnMarkdown(
  session: SessionSummary | null,
  items: AgentItem[],
  label: string,
  streams: Record<string, Stream> = {},
  mode: ExportMode = 'full',
): string {
  const lines = [`# ${session?.title || '会话'} · ${label}`, '']
  if (session) lines.push(...meta(session), '', '---', '')
  lines.push(...itemsMarkdown(items, streams, mode))
  return finish(lines)
}

function meta(session: SessionSummary): string[] {
  const rows = [`- 代理：${PROVIDER_LABEL[session.provider] ?? session.provider}`, `- 会话 ID：\`${session.id}\``]
  if (session.cwd) rows.push(`- 工作目录：\`${session.cwd}\``)
  if (session.updatedAt) rows.push(`- 更新时间：${new Date(session.updatedAt).toLocaleString('zh-CN')}`)
  rows.push(`- 导出时间：${new Date().toLocaleString('zh-CN')}`)
  return rows
}

function itemsMarkdown(items: AgentItem[], streams: Record<string, Stream> = {}, mode: ExportMode = 'full'): string[] {
  const out: string[] = []
  for (const item of items) {
    // "Conversation" is the same filter the copy button uses: messages only,
    // with no reasoning, commands, tools, diffs or other cards.
    if (mode === 'conversation' && item.kind !== 'message') continue
    switch (item.kind) {
      case 'message': {
        const stream = streams[item.id]
        const streamed = item.text.length === 0 && stream?.channel === 'text' ? stream.text : ''
        const text = (item.text || streamed).trim()
        out.push(item.role === 'user' ? '**用户**' : '**助手**', '')
        if (text) out.push(text, '')
        if (item.images?.length) {
          out.push(item.images.map((token) => `图片：\`${token}\``).join('\n'), '')
        }
        break
      }

      case 'reasoning': {
        const stream = streams[item.id]
        const streamed = stream?.channel === 'reasoning' ? stream.text : ''
        const text = [...item.summary, ...item.content].filter(Boolean).join('\n\n').trim() || streamed.trim()
        if (text) out.push('> **思考**', '', ...quote(text), '')
        break
      }

      case 'command': {
        out.push('### 命令', '', ...fenced(item.command, 'sh'))
        if (item.cwd) out.push(`工作目录：\`${item.cwd}\``, '')
        if (item.output.trim()) out.push(...fenced(item.output.trimEnd(), 'text'), '')
        out.push(statusLine(item.status, item.exitCode, item.durationMs), '')
        break
      }

      case 'fileChange': {
        out.push('### 文件改动', '')
        for (const change of item.changes) {
          const action = change.kind === 'add' ? '新增' : change.kind === 'delete' ? '删除' : '修改'
          const moved = change.movePath ? ` → \`${change.movePath}\`` : ''
          out.push(`- ${action} \`${change.path}\`${moved}`)
          if (change.diff.trim()) out.push('', ...fenced(change.diff.trimEnd(), 'diff'))
        }
        out.push(statusLine(item.status), '')
        break
      }

      case 'mcpTool': {
        out.push(`### MCP：${item.server}.${item.tool}`, '', statusLine(item.status), '')
        appendJson(out, '参数', item.args)
        appendJson(out, '结果', item.result)
        if (item.error !== undefined) appendJson(out, '错误', item.error)
        break
      }

      case 'webSearch': {
        out.push('### 网络搜索', '', `查询：${item.query}`, '')
        if (item.action) appendJson(out, '动作', item.action)
        if (item.results?.length) appendJson(out, '结果', item.results)
        out.push(statusLine(item.status), '')
        break
      }

      case 'compaction': {
        const trigger = item.trigger === 'manual' ? '手动' : item.trigger === 'auto' ? '自动' : ''
        const tokens =
          item.preTokens !== undefined || item.postTokens !== undefined
            ? `（${item.preTokens ?? '?'} → ${item.postTokens ?? '?'} tokens）`
            : ''
        out.push(`> 上下文已压缩${trigger ? `（${trigger}）` : ''}${tokens}`, '')
        break
      }

      case 'plan':
        out.push('### 计划', '', item.text.trim(), '')
        break

      case 'image':
        out.push(`图片：\`${item.url}\``, '')
        break

      case 'error':
        out.push('> **错误**', '', ...quote(item.message), '')
        break

      case 'retry':
        out.push('### 重试', '')
        for (const attempt of item.attempts) {
          const count = attempt.attempt ? `（第 ${attempt.attempt} 次）` : ''
          out.push(`- ${attempt.message}${count}`)
        }
        out.push('')
        break

      case 'tool': {
        out.push(`### 工具：${item.title || item.name}`, '')
        if (item.subagentType) out.push(`子代理：${item.subagentType}`, '')
        appendJson(out, '输入', item.input)
        if (item.output?.trim()) out.push('输出：', '', ...fenced(item.output.trimEnd(), 'text'), '')
        if (item.error?.trim()) out.push(`错误：${item.error.trim()}`, '')
        out.push(statusLine(item.status), '')
        break
      }

      case 'unknown':
        out.push(`> 未知条目：\`${item.type}\``, '')
        break
    }
  }
  return out
}

function statusLine(status: string, exitCode?: number | null, durationMs?: number | null): string {
  const parts = [STATUS[status] ?? status]
  if (exitCode !== undefined && exitCode !== null) parts.push(`退出码 ${exitCode}`)
  if (durationMs !== undefined && durationMs !== null) parts.push(`${durationMs} ms`)
  return parts.join(' · ')
}

function appendJson(out: string[], label: string, value: unknown): void {
  if (value === undefined) return
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text.length > 20_000) text = `${text.slice(0, 20_000)}\n…（已截断）`
  out.push(`${label}：`, '', ...fenced(text, 'json'))
}

/** Fence length must exceed any run of backticks in the content. */
function fenced(text: string, language = ''): string[] {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const marker = '`'.repeat(Math.max(3, longest + 1))
  return [`${marker}${language}`, text, marker]
}

function quote(text: string): string[] {
  return text.split('\n').map((line) => `> ${line}`)
}

function finish(lines: string[]): string {
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}

/** A filesystem-safe, still recognisable name. */
export function markdownFilename(title: string, suffix?: string): string {
  const base =
    (title || 'session')
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'session'
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  return `${base}${suffix ? `-${suffix}` : ''}-${stamp}.md`
}

export function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
