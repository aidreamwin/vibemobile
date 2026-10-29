import type { PlanStep, SessionStatus, SessionSummary, TurnStatus, Usage } from '@vibemobile/protocol'
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
  onDownload: () => void
  onBack: () => void
  onShowDiff: () => void
}) {
  // The live plan block behaves like a `plan` item for this preference.
  const hidePlan = useDisplayPrefs((state) => state.prefs.hidePlan)

  return (
    <header className="safe-top shrink-0 border-b border-border bg-card/90 backdrop-blur-md">
      <div className="flex items-center gap-2 px-3 py-2.5">
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

        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-foreground">{session?.title ?? '会话'}</div>
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span
              className={
                readOnly
                  ? 'text-warning font-medium'
                  : status === 'waitingApproval'
                    ? 'text-warning font-medium'
                    : status === 'working'
                      ? 'text-success font-medium'
                      : status === 'error' || (status === 'idle' && turnStatus === 'failed')
                        ? 'text-destructive font-medium'
                        : ''
              }
            >
              {readOnly
                ? '只读'
                : status === 'idle' && turnStatus === 'failed'
                  ? '本轮失败'
                  : (STATUS_LABEL[status] ?? status)}
            </span>
            {session?.cwd && <span className="truncate font-mono">{shortPath(session.cwd, 2)}</span>}
            {/* After the cwd, not before it: the path truncates, this never
                does. It renders nothing until a usage report arrives, which
                is why nothing here reserves space for it. */}
            <UsageChip usage={usage} provider={session?.provider} />
          </div>
        </div>
        <DisplaySettings />
        <SessionInfo provider={session?.provider} onDownload={onDownload} downloading={downloading} />
        {hasDiff && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onShowDiff}
            className="tap shrink-0 rounded-lg text-muted-foreground"
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

      {plan.length > 0 && !hidePlan && (
        <div className="border-t border-border px-3 py-2">
          {plan.map((step, i) => (
            <div key={i} className="flex items-center gap-2 text-[12px]">
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
              <span
                className={step.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground/90'}
              >
                {step.step}
              </span>
            </div>
          ))}
        </div>
      )}
    </header>
  )
}
