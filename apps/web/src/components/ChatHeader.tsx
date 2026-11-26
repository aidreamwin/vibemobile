import type { PlanStep, SessionStatus, SessionSummary, TurnStatus, Usage } from '@vibemobile/protocol'
import { ChevronRight, ListChecks } from 'lucide-react'
import { shortPath } from '../lib/format'
import { useDisplayPrefs } from '../lib/displayPrefs'
import DisplaySettings from './DisplaySettings'
import SessionInfo from './SessionInfo'
import UsageChip from './UsageChip'
import { Button } from './ui/button'

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  working: '执行中',
  waitingApproval: '等待授权',
  waitingInput: '等待输入',
  error: '出错',
}

export default function ChatHeader({
  session,
  readOnly,
  status,
  turnStatus,
  usage,
  plan,
  hasDiff,
  downloading,
  embedded = false,
  showPaneTitle = false,
  onDownload,
  onBack,
  onShowDiff,
}: {
  session: SessionSummary | null
  readOnly: boolean
  status: SessionStatus
  turnStatus: TurnStatus | null
  usage: Usage | null
  plan: PlanStep[]
  hasDiff: boolean
  downloading: boolean
  embedded?: boolean
  showPaneTitle?: boolean
  onDownload: () => void
  onBack: () => void
  onShowDiff: () => void
}) {
  // The live plan block behaves like a `plan` item for this preference.
  const hidePlan = useDisplayPrefs((state) => state.prefs.hidePlan)
  const title = session?.title || '会话'
  const planSteps = plan.map((step, i) => (
    <div key={`${step.step}-${i}`} className="flex items-center gap-2 text-[12px]">
      <span
        className={
          step.status === 'completed'
            ? 'text-success'
            : step.status === 'inProgress'
              ? 'text-warning'
              : 'text-muted-foreground/70'
        }
      >
        {step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '◐' : '○'}
      </span>
      <span className={step.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground/90'}>
        {step.step}
      </span>
    </div>
  ))

  return (
    <header
      className={`shrink-0 border-b border-border ${embedded ? 'bg-card/40' : 'safe-top bg-card/90 backdrop-blur-md'}`}
    >
      <div
        className={
          embedded
            ? 'flex min-h-9 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-0.5'
            : 'flex items-center gap-2 px-3 py-2.5'
        }
      >
        {!embedded && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="tap shrink-0 rounded-xl text-muted-foreground"
            aria-label="返回"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="size-5"
            >
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        )}

        <div className={`min-w-0 flex-1 ${embedded ? 'flex basis-28 items-center gap-2' : ''}`}>
          {(!embedded || showPaneTitle) && (
            <div
              className={`truncate font-semibold text-foreground ${embedded ? 'max-w-[55%] shrink border-r border-border pr-2 text-xs' : 'text-[15px]'}`}
              title={title}
            >
              {title}
            </div>
          )}
          <div
            className={`flex min-w-0 items-center text-[11px] text-muted-foreground ${embedded ? 'flex-1 gap-1.5' : 'gap-2'}`}
          >
            <span
              className={`shrink-0 ${
                readOnly
                  ? 'text-warning font-medium'
                  : status === 'waitingApproval'
                    ? 'text-warning font-medium'
                    : status === 'working'
                      ? 'text-success font-medium'
                      : status === 'error' || (status === 'idle' && turnStatus === 'failed')
                        ? 'text-destructive font-medium'
                        : ''
              }`}
            >
              {readOnly
                ? '只读'
                : status === 'idle' && turnStatus === 'failed'
                  ? '本轮失败'
                  : (STATUS_LABEL[status] ?? status)}
            </span>
            {session?.cwd && (
              <span className="truncate font-mono" title={session.cwd}>
                {shortPath(session.cwd, 2)}
              </span>
            )}
            {!embedded && (
              <UsageChip usage={usage} contextWindow={session?.contextWindow} provider={session?.provider} />
            )}
          </div>
        </div>
        <div className={`ml-auto flex shrink-0 items-center ${embedded ? 'gap-0.5' : 'gap-2'}`}>
          {embedded && (
            <UsageChip compact usage={usage} contextWindow={session?.contextWindow} provider={session?.provider} />
          )}
          <DisplaySettings compact={embedded} />
          <SessionInfo
            compact={embedded}
            provider={session?.provider}
            onDownload={onDownload}
            downloading={downloading}
          />
          {hasDiff && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onShowDiff}
              className={`shrink-0 text-muted-foreground ${embedded ? 'size-6 rounded-md [&_svg]:size-3.5' : 'tap rounded-lg'}`}
              aria-label="查看改动"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="size-5"
              >
                <path
                  d="M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9v3a6 6 0 01-6 6H9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Button>
          )}
        </div>
      </div>

      {planSteps.length > 0 &&
        !hidePlan &&
        (embedded ? (
          <details className="group border-t border-border/70">
            <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 px-3 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="size-3 group-open:rotate-90" />
              <ListChecks aria-hidden="true" className="size-3.5" />
              <span>执行计划</span>
              <span className="tabular-nums">
                {plan.filter((step) => step.status === 'completed').length}/{plan.length}
              </span>
            </summary>
            <div className="scroll-y max-h-32 space-y-1 px-4 py-2">{planSteps}</div>
          </details>
        ) : (
          <div className="border-t border-border px-3 py-2">{planSteps}</div>
        ))}
    </header>
  )
}
