import { Button } from './ui/button'

/**
 * The full-page failure state for opening a session.
 *
 * `sessionInUse` is provider-neutral on purpose: at this point the load threw
 * before returning a summary, so naming an agent would be a guess. In practice
 * only Codex can produce this error; Claude has no writer lock to trip.
 */
export default function ChatLoadError({
  loadError,
  sessionInUse,
  forking,
  forkError,
  onFork,
  onRetry,
  onBack,
}: {
  loadError: string
  sessionInUse: boolean
  forking: boolean
  forkError: string | null
  onFork: () => void
  onRetry: () => void
  onBack: () => void
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="max-w-sm">
        <h1 className="text-base font-semibold text-foreground">
          {sessionInUse ? '会话正在电脑端使用' : '无法打开会话'}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {sessionInUse ? '同一个会话不能被两个客户端同时写入。关闭电脑端的该会话后重试，或创建副本继续。' : loadError}
        </p>
        {forkError && <p className="mt-2 text-xs text-destructive">{forkError}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {sessionInUse && (
          <Button
            type="button"
            size="lg"
            onClick={onFork}
            disabled={forking}
            className="min-h-11 rounded-lg px-4 text-sm"
          >
            {forking ? '正在创建…' : '创建副本继续'}
          </Button>
        )}
        <Button
          type="button"
          size="lg"
          variant="outline"
          onClick={onRetry}
          disabled={forking}
          className="min-h-11 rounded-lg px-4 text-sm"
        >
          重试
        </Button>
        <Button
          type="button"
          size="lg"
          variant="ghost"
          onClick={onBack}
          disabled={forking}
          className="min-h-11 px-3 text-sm text-muted-foreground"
        >
          返回会话列表
        </Button>
      </div>
    </div>
  )
}
