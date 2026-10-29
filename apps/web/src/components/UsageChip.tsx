import { useState } from 'react'
import type { ProviderId, Usage } from '@vibemobile/protocol'
import { formatTokens } from '../lib/format'
import Sheet from './Sheet'

/**
 * How full the context is, in one chip, with the breakdown behind a tap.
 *
 * Both backends report `promptTokens` as the prompt of the NEWEST request (see
 * the note on `Usage` in the protocol — the two count the cache on opposite
 * sides, which is why the numerator is a mapped field rather than a sum of raw
 * ones). That makes "prompt / window" the one comparison that means the same
 * thing on both, and it is the number that predicts the next compaction — the
 * thing a user watching a phone actually needs to know.
 *
 * Nothing is rendered before the first report: neither backend can reconstruct
 * usage for turns that already happened (Codex's thread record has no token
 * counts, Claude has no thread record), so an idle session that was just opened
 * shows no chip at all until its next turn. A chip reading "0" would be a
 * claim, and a wrong one.
 */
export default function UsageChip({ usage, provider }: { usage: Usage | null; provider?: ProviderId }) {
  const [open, setOpen] = useState(false)
  if (!usage) return null

  const { promptTokens, cachedTokens, outputTokens, reasoningOutputTokens, sessionTokens, contextWindow } = usage
  const percent = contextWindow ? Math.min(100, Math.round((promptTokens / contextWindow) * 100)) : null
  const cachedPercent = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="查看用量"
        className="tap shrink-0 rounded-md border-0 bg-transparent px-1.5 py-0.5 font-mono text-[10px] leading-tight text-muted-foreground"
      >
        {percent === null ? formatTokens(promptTokens) : `${percent}% · ${formatTokens(promptTokens)}`}
      </button>

      {open && (
        <Sheet title="用量" onClose={() => setOpen(false)}>
          <div className="px-4 pb-6">
            {contextWindow ? (
              <>
                <div className="mb-1 flex items-baseline justify-between text-[12px]">
                  <span className="text-muted-foreground">上下文占用</span>
                  <span className="font-mono text-foreground">
                    {formatTokens(promptTokens)} / {formatTokens(contextWindow)}
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
              <Row label="上下文" value={formatTokens(promptTokens)} />
            )}

            <div className="mt-3 divide-y divide-border">
              <Row
                label="其中命中缓存"
                value={cachedTokens > 0 ? `${formatTokens(cachedTokens)}（${cachedPercent}%）` : '无'}
              />
              <Row label="本轮输出" value={formatTokens(outputTokens)} />
              {reasoningOutputTokens > 0 && <Row label="其中思考" value={formatTokens(reasoningOutputTokens)} />}
              {/* Only Codex keeps a running figure; Claude's per-turn
                  subprocess has nothing to add up. Omitted rather than shown
                  as zero — see `Usage.sessionTokens`. */}
              {typeof sessionTokens === 'number' && <Row label="本会话累计" value={formatTokens(sessionTokens)} />}
            </div>

            {/* What the numbers cover differs per backend, and a screen full of
                counts with no stated scope is the kind of thing that gets
                quoted wrongly. Kept to one line. */}
            <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
              {provider === 'codex'
                ? '数字来自 Codex 的线程统计；「本会话累计」包含这次打开之前的回合。'
                : provider === 'claude'
                  ? '数字来自 Claude 每次回答的结果帧，只覆盖本轮；刷新后要等下一轮才会重新出现。'
                  : '数字来自后端最近一次上报，刷新后要等下一轮才会重新出现。'}
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
