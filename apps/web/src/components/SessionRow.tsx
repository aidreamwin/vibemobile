import type { SessionSummary } from '@vibemobile/protocol'
import { formatDateTime, relativeTime, shortPath } from '../lib/format'

/**
 * The colour of a row's provider chip, by provider id.
 *
 * The list merges providers, so this chip is the one thing on the row that
 * says which agent owns the session — which is what it is coloured for. A
 * provider this build has never heard of falls back to the plain outline chip
 * rather than being mis-coloured.
 */
const PROVIDER_TAG: Record<string, string> = {
  claude: 'border-tag-violet/35 bg-tag-violet/12 text-tag-violet',
  codex: 'border-tag-cyan/35 bg-tag-cyan/12 text-tag-cyan',
}

const STATUS_TEXT: Record<string, string> = {
  working: '执行中',
  waitingApproval: '等待授权',
  waitingInput: '等待输入',
  error: '出错',
}

function StatusPill({ status }: { status: string }) {
  const label = STATUS_TEXT[status]
  if (!label) return null
  return (
    <span
      className={`shrink-0 ${
        status === 'working' ? 'text-success' : status === 'error' ? 'text-destructive' : 'text-warning'
      }`}
    >
      · {label}
    </span>
  )
}

export default function SessionRow({
  session,
  providerName,
  onOpen,
  onActions,
}: {
  session: SessionSummary
  providerName: (id: string) => string
  onOpen: () => void
  onActions: () => void
}) {
  return (
    // data-session-id is how the list remembers the row the user was looking at.
    <li data-session-id={session.id}>
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 px-4 py-3.5 text-left active:bg-card transition-colors"
        >
          <div className="flex items-center gap-2">
            {/* Pinned rows are grouped at the top, but "at the top" is not
                visible on a phone: the badge is what says why the order is not
                by time. */}
            {session.pinned && (
              <svg
                role="img"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-3.5 w-3.5 shrink-0 text-primary"
                aria-label="已置顶"
              >
                <path d="M14.5 2.5l7 7-2 2-1.2-.6-3.3 3.3.4 3.6-1.6 1.6-4-4-4.3 4.3-1.4-1.4 4.3-4.3-4-4 1.6-1.6 3.6.4 3.3-3.3-.6-1.2z" />
              </svg>
            )}
            {session.needsAttention && (
              <span className="shrink-0 animate-pulse rounded-md bg-warning/20 px-2 py-0.5 text-xs font-semibold text-warning">
                等待你
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
              {session.title || '未命名会话'}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(session.updatedAt)}</span>
          </div>

          {session.preview && (
            <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{session.preview}</div>
          )}

          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${
                PROVIDER_TAG[session.provider] ?? 'border-border'
              }`}
            >
              {providerName(session.provider)}
            </span>
            <span className="min-w-0 truncate font-mono">{shortPath(session.cwd)}</span>
            {session.model && <span className="shrink-0">· {session.model}</span>}
            {session.status !== 'idle' && <StatusPill status={session.status} />}
            {/* The top-right time says when the session last moved; this one
                says when it started. Without the label the two dates would
                look like the same fact. */}
            {session.createdAt ? (
              <span
                className="ml-auto shrink-0 whitespace-nowrap tabular-nums"
                title={`创建于 ${new Date(session.createdAt).toLocaleString('zh-CN')}`}
              >
                创建 {formatDateTime(session.createdAt)}
              </span>
            ) : null}
          </div>
        </button>

        <button
          type="button"
          onClick={onActions}
          className="tap w-11 shrink-0 text-muted-foreground active:bg-card"
          aria-label="更多操作"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="mx-auto h-5 w-5">
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        </button>
      </div>
    </li>
  )
}
