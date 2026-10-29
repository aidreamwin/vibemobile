import { memo, useState } from 'react'
import type { AgentItem, FileChange, ItemStatus } from '@vibemobile/protocol'
import Markdown, { type MarkdownProps } from './Markdown'
import DiffView from './DiffView'
import ImageViewer from './ImageViewer'
import { imageUrl } from '../lib/api'
import { formatClock, formatTokens } from '../lib/format'
import CopyButton from './CopyButton'

const statusDot: Record<ItemStatus, string> = {
  running: 'bg-warning animate-pulse',
  done: 'bg-success',
  failed: 'bg-destructive',
  declined: 'bg-muted-foreground',
}

function StatusDot({ status }: { status: ItemStatus }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDot[status]}`} />
}

/**
 * Everything a message body needs beyond its text: the session cwd (what its
 * relative links are relative to) and where a file reference should open.
 */
type LinkContext = Pick<MarkdownProps, 'cwd' | 'onOpenFile'>

function Collapsible({
  title,
  subtitle,
  status,
  defaultOpen = false,
  children,
}: {
  title: string
  subtitle?: string
  status?: ItemStatus
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="tap flex w-full items-center justify-between gap-2.5 px-3.5 py-2.5 text-left active:bg-secondary"
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {status && <StatusDot status={status} />}
          <div className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[13px] font-medium text-foreground">{title}</span>
            {subtitle && <span className="mt-0.5 block text-xs text-muted-foreground truncate">{subtitle}</span>}
          </div>
        </div>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        >
          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="border-t border-border bg-secondary">{children}</div>}
    </div>
  )
}

function Pre({ text }: { text: string }) {
  if (!text.trim()) return <div className="px-3 py-2 text-[12px] text-muted-foreground/70">（无输出）</div>
  return (
    <pre className="scroll-x max-h-80 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre text-foreground/90">
      {text}
    </pre>
  )
}

/** A row of a `webSearch` result, in whichever of the usual shapes it arrived. */
function searchResultLine(result: unknown): { title: string; url?: string; snippet?: string } | null {
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  const pick = (keys: string[]) =>
    keys.map((key) => record[key]).find((v): v is string => typeof v === 'string' && v.length > 0)
  const title = pick(['title', 'name', 'headline'])
  const url = pick(['url', 'link', 'href'])
  const snippet = pick(['snippet', 'description', 'text', 'summary'])
  // Nothing recognizable means the raw JSON is not worth showing either: the
  // caller falls back to the neutral sentence, which is what this card said
  // before results were mapped at all.
  if (!title && !url) return null
  return { title: title ?? url ?? '', ...(url ? { url } : {}), ...(snippet ? { snippet } : {}) }
}

/** Tool input is JSON-decoded already; a bare string should not get quotes. */
function show(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const ItemCard = memo(function ItemCard({
  item,
  streamText,
  sentAt,
  cwd,
  onOpenFile,
}: {
  item: AgentItem
  streamText?: string
  /** When this turn's prompt was sent, for the clock under a user bubble. */
  sentAt?: number | null
} & LinkContext) {
  switch (item.kind) {
    case 'message':
      return item.role === 'user' ? (
        // A column with `items-end` rather than a right-justified row: the
        // timestamp and copy action sit under the bubble, on its trailing
        // edge, without stretching the bubble to the full width.
        <div className="my-1 flex flex-col items-end">
          <div className="max-w-[85%] rounded-2xl rounded-tr-xs bg-[#22242d] border border-white/10 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-foreground shadow-sm">
            {/* Images above the text, matching the order both agents record
                them in — the picture is what the caption is about. */}
            {item.images?.length ? (
              <div className={item.text ? 'mb-2 flex flex-col gap-2' : 'flex flex-col gap-2'}>
                {item.images.map((token) => (
                  <ImageViewer
                    key={token}
                    src={imageUrl(token)}
                    /* Capped by WIDTH for landscape and by viewport height for
                       portrait. A fixed pixel cap is the wrong shape here: the
                       most likely attachment from a phone is a portrait
                       screenshot, and `max-h-64` renders one 1170x2532 at
                       118px wide — a sliver. Landscape and wide shots are
                       width-bound either way, so this only affects the case
                       that needs it. `dvh` rather than `vh` so the collapsing
                       mobile URL bar does not overflow the cap. */
                    className="max-h-[50dvh] w-auto max-w-full rounded-lg border border-white/10 object-contain"
                  />
                ))}
              </div>
            ) : null}
            {item.text}
          </div>
          <div className="mt-1 flex items-center gap-1 pr-0.5">
            {sentAt ? (
              <span className="text-[10px] leading-none text-muted-foreground/70">{formatClock(sentAt)}</span>
            ) : null}
            {/* Nothing to copy for an image-only prompt; the button would be a
                no-op, so it is not drawn. */}
            {item.text ? (
              // No className override: the default is the same button the
              // turn's copy action uses, so the two read as one control even
              // though one sits under a bubble and the other under a turn.
              <CopyButton getText={() => item.text} label="复制消息" />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="text-foreground">
          <Markdown text={item.text} cwd={cwd} onOpenFile={onOpenFile} />
        </div>
      )

    case 'reasoning': {
      const summaryText = item.summary.join('\n\n')
      const contentText = item.content.join('\n\n')
      const storedText = (summaryText + '\n\n' + contentText).trim()
      // During a live turn the started item is intentionally empty. Put the
      // delta buffer inside this card so expanding it never shows “无输出”.
      const totalText = streamText?.trim() || storedText
      const sectionCount = streamText?.trim() ? 1 : item.summary.length + item.content.length
      // Historical turns created without reasoning summaries cannot be
      // reconstructed. Omit their empty placeholder instead of showing a
      // permanently stuck “思考中” card.
      if (!totalText) return null
      return (
        <Collapsible title="思考过程" subtitle={`${sectionCount} 段 · ${totalText.length} 字`} defaultOpen={false}>
          <Pre text={totalText} />
        </Collapsible>
      )
    }

    case 'command':
      return (
        <Collapsible
          title="命令"
          subtitle={[
            // Status first: the command itself is long enough to be truncated,
            // and the exit code is the part worth keeping visible.
            item.status === 'done' && item.exitCode !== null
              ? `exit ${item.exitCode}${item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''}`
              : item.cwd,
            item.command,
          ]
            .filter(Boolean)
            .join(' · ')}
          status={item.status}
        >
          <Pre text={item.output} />
        </Collapsible>
      )

    case 'fileChange':
      return (
        <Collapsible
          title="修改"
          // Same reason as the command card: the paths are long, the count is
          // the short fact that should survive truncation.
          subtitle={`${item.changes.length} 个文件 · ${item.changes.map((c: FileChange) => c.path).join(', ') || '文件变更'}`}
          status={item.status}
        >
          <DiffView changes={item.changes} />
        </Collapsible>
      )

    case 'mcpTool':
      return (
        <Collapsible title="MCP" subtitle={`${item.server} · ${item.tool}`} status={item.status}>
          <Pre text={JSON.stringify({ arguments: item.args, result: item.result, error: item.error }, null, 2)} />
        </Collapsible>
      )

    case 'webSearch': {
      // The three shapes the item can take, from the action the backend
      // recorded: a search (possibly of several queries), a page it opened, or
      // a find-in-page. All three used to read "搜索：<query>", which for
      // `open_page` meant printing the URL under the word "search".
      const action = item.action
      const title =
        action?.type === 'open_page'
          ? `打开网页：${action.url ?? item.query}`
          : action?.type === 'find_in_page'
            ? `页内查找：${action.pattern ?? ''}`
            : `搜索：${item.query}`
      const rows = (item.results ?? []).map(searchResultLine).filter((row) => row !== null)
      return (
        <Collapsible
          title="搜索"
          subtitle={[
            title,
            action?.type === 'search' && (action.queries?.length ?? 0) > 1 ? action.queries!.join(' · ') : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          status={item.status}
          defaultOpen={rows.length > 0}
        >
          {rows.length > 0 ? (
            <div className="divide-y divide-border">
              {rows.map((row, i) => (
                <div key={i} className="px-3.5 py-2">
                  {row.title && <div className="text-[13px] font-medium text-foreground">{row.title}</div>}
                  {row.url && (
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{row.url}</div>
                  )}
                  {row.snippet && (
                    <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{row.snippet}</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            // Deliberately the sentence that was here before. `results` is
            // opaque JSON at the boundary and this machine's recorded sessions
            // have never carried one, so "we could not read it" and "there is
            // nothing to read" must look the same rather than leave a blank.
            <Pre text="（结果已并入模型上下文）" />
          )}
        </Collapsible>
      )
    }

    case 'plan':
      return (
        <div>
          <div className="text-[13px] font-medium text-foreground">计划</div>
          <div className="mt-0.5 wrap-break-word whitespace-pre-wrap text-[13px] text-muted-foreground">
            {item.text}
          </div>
        </div>
      )

    // One line, not a card with a chevron: there is nothing behind it to open —
    // Codex sends no detail at all and Claude sends two numbers. What matters
    // is that the user can SEE that the conversation was summarized, because
    // everything before it is no longer in the agent's context.
    case 'compaction': {
      const detail = [
        item.trigger === 'manual' ? '手动' : item.trigger === 'auto' ? '自动' : null,
        item.preTokens !== undefined
          ? item.postTokens !== undefined
            ? `${formatTokens(item.preTokens)} → ${formatTokens(item.postTokens)}`
            : `${formatTokens(item.preTokens)}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
      return (
        <div className="flex items-center gap-2.5">
          <span className="h-px flex-1 bg-border" />
          <span className="shrink-0 text-[11px] text-muted-foreground">上下文已压缩{detail && `（${detail}）`}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )
    }

    // An image the AGENT produced (`imageView`), which arrives with its own URL
    // rather than a store token — see `ImageViewer` for why the two are not
    // unified.
    case 'image':
      return <ImageViewer src={item.url} className="max-w-full rounded-lg" />

    case 'retry':
      return (
        <details className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-[13px] text-muted-foreground">
          <summary className="cursor-pointer text-warning">自动重试记录（{item.attempts.length} 次）</summary>
          <ol className="mt-2 space-y-2">
            {item.attempts.map((attempt, i) => (
              <li key={i} className="break-words whitespace-pre-wrap">
                <div>
                  第 {attempt.attempt ?? i + 1} 次{attempt.maxRetries ? ` / 最多 ${attempt.maxRetries} 次` : ''}
                  {typeof attempt.delayMs === 'number' ? ` · 等待 ${Math.ceil(attempt.delayMs / 1000)} 秒` : ''}
                  {attempt.at ? ` · ${new Date(attempt.at).toLocaleTimeString()}` : ''}
                </div>
                <div>{attempt.message}</div>
              </li>
            ))}
          </ol>
        </details>
      )

    case 'error':
      return (
        <div
          role="alert"
          className="break-words whitespace-pre-wrap rounded-lg border border-destructive/60 bg-destructive/15 px-3 py-2 text-[13px] text-destructive"
        >
          <div className="font-medium">执行出错</div>
          <div>{item.message}</div>
        </div>
      )

    // Generic fallback for tools with no dedicated card. Without this case the
    // item falls to `default: return null` and the card silently vanishes —
    // the turn looks stalled with nothing to explain why.
    case 'tool': {
      const sections: string[] = []
      if (item.input !== undefined) sections.push(`参数\n${show(item.input)}`)
      if (item.output) sections.push(`输出\n${item.output}`)
      if (item.error) sections.push(`错误\n${item.error}`)
      const subtitle = [
        item.title && item.title !== item.name ? `${item.title} · ${item.name}` : item.name,
        item.subagentType ? `子代理 ${item.subagentType}` : null,
        item.childCount ? `${item.childCount} 次子调用` : null,
      ]
        .filter(Boolean)
        .join(' · ')
      return (
        <Collapsible title="工具" subtitle={subtitle} status={item.status}>
          <Pre text={sections.join('\n\n')} />
        </Collapsible>
      )
    }

    default:
      return null
  }
})

export default ItemCard
