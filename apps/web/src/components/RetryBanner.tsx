import type { AgentEvent } from '@vibemobile/protocol'

export function RetryBanner({ notice }: { notice: Extract<AgentEvent, { kind: 'error' }> | null }) {
  if (!notice) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="shrink-0 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[13px] text-warning"
    >
      <div className="font-medium">
        请求失败，正在自动重试
        {notice.retryAttempt ? `（${notice.retryAttempt}${notice.maxRetries ? `/${notice.maxRetries}` : ''}）` : ''}
        {typeof notice.retryInMs === 'number' ? `，约 ${Math.ceil(notice.retryInMs / 1000)} 秒后再次尝试` : ''}
      </div>
      <div className="break-words whitespace-pre-wrap">{notice.message}</div>
    </div>
  )
}
