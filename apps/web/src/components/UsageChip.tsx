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
}: {
  usage: Usage | null
  contextWindow?: number
  provider?: ProviderId
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
        aria-label="View context usage"
        className="tap shrink-0 rounded-md border-0 bg-transparent px-1.5 py-0.5 font-mono text-[10px] leading-tight text-muted-foreground"
      >
        {usage ? (percent === null ? formatTokens(promptTokens) : `${percent}% · ${formatTokens(promptTokens)}`) : `— / ${formatTokens(window)}`}
      </button>

      {open && (
        <Sheet title="Usage" onClose={() => setOpen(false)}>
          <div className="px-4 pb-6">
            {window ? (
              <>
                <div className="mb-1 flex items-baseline justify-between text-[12px]">
                  <span className="text-muted-foreground">Context used</span>
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
              <Row label="Context" value={usage ? formatTokens(promptTokens) : 'Waiting for usage'} />
            )}

            {usage && (
              <div className="mt-3 divide-y divide-border">
                <Row label="Cached" value={cachedTokens > 0 ? `${formatTokens(cachedTokens)} · ${cachedPercent}%` : '—'} />
                <Row label="Output" value={formatTokens(outputTokens)} />
                {reasoningOutputTokens > 0 && <Row label="Reasoning" value={formatTokens(reasoningOutputTokens)} />}
                {typeof sessionTokens === 'number' && <Row label="Session total" value={formatTokens(sessionTokens)} />}
              </div>
            )}

            <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
              {usage
                ? provider === 'codex'
                  ? 'Reported by Codex for the latest request.'
                  : provider === 'claude'
                    ? 'Reported by Claude for the latest response.'
                    : 'Reported by the backend for the latest request.'
                : 'The model window is known; current usage will appear after the next request.'}
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
