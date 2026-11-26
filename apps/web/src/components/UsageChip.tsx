import { useState } from 'react'
import type { ProviderId, Usage } from '@vibemobile/protocol'
import { formatTokens } from '../lib/format'
import Sheet from './Sheet'

/** Compact context usage indicator. A known model window is shown even before
 * the first usage event arrives, so reopening a session does not hide it. */
export default function UsageChip({
  usage,
  contextWindow,
  provider,
  compact = false,
}: {
  usage: Usage | null
  contextWindow?: number
  provider?: ProviderId
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!usage && !contextWindow) return null

  const promptTokens = usage?.promptTokens ?? 0
  const cachedTokens = usage?.cachedTokens ?? 0
  const outputTokens = usage?.outputTokens ?? 0
  const reasoningOutputTokens = usage?.reasoningOutputTokens ?? 0
  const sessionTokens = usage?.sessionTokens
  const window = usage?.contextWindow ?? contextWindow
  const percent = usage && window ? Math.min(100, Math.round((promptTokens / window) * 100)) : null
  const cachedPercent = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="查看上下文用量"
        className={`shrink-0 rounded-md border-0 px-1.5 py-0.5 font-mono text-[10px] leading-tight text-muted-foreground ${compact ? 'min-h-6 hover:bg-secondary' : 'tap bg-transparent'}`}
      >
        {usage
          ? percent === null
            ? formatTokens(promptTokens)
            : `${percent}% · ${formatTokens(promptTokens)}`
          : `— / ${formatTokens(window)}`}
      </button>

      {open && (
        <Sheet title="上下文用量" onClose={() => setOpen(false)}>
          <div className="px-4 pb-6">
            {window ? (
              <>
                <div className="mb-1 flex items-baseline justify-between text-[12px]">
                  <span className="text-muted-foreground">已用上下文</span>
                  <span className="font-mono text-foreground">
                    {usage ? `${formatTokens(promptTokens)} / ${formatTokens(window)}` : `— / ${formatTokens(window)}`}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-input" aria-hidden="true">
                  <div
                    className={`h-full rounded-full ${percent !== null && percent >= 80 ? 'bg-warning' : 'bg-primary'}`}
                    style={{ width: `${percent ?? 0}%` }}
                  />
                </div>
              </>
            ) : (
              <Row label="上下文" value={usage ? formatTokens(promptTokens) : '等待用量数据'} />
            )}

            {usage && (
              <div className="mt-3 divide-y divide-border">
                <Row
                  label="缓存命中"
                  value={cachedTokens > 0 ? `${formatTokens(cachedTokens)} · ${cachedPercent}%` : '—'}
                />
                <Row label="输出" value={formatTokens(outputTokens)} />
                {reasoningOutputTokens > 0 && <Row label="推理输出" value={formatTokens(reasoningOutputTokens)} />}
                {typeof sessionTokens === 'number' && <Row label="会话累计" value={formatTokens(sessionTokens)} />}
              </div>
            )}

            <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
              {usage
                ? provider === 'codex'
                  ? 'Codex 当前请求的统计数据。'
                  : provider === 'claude'
                    ? 'Claude 最新回复的统计数据。'
                    : '执行机最新请求的统计数据。'
                : '发送下一条消息后，将显示当前用量。'}
            </p>
          </div>
        </Sheet>
      )}
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-2 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  )
}
