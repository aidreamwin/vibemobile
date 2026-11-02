import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorLabel, jobRunning, phaseLabel, useSystemStore } from '../lib/system'

/**
 * A one-line strip in the app shell. Deliberately plain: it is imported by
 * `App.tsx` (eager), so it must not pull in Settings, Radix or the Sheet chunk.
 * The confirmation is inline for the same reason and because one extra screen
 * between a non-technical user and "upgrade" is one too many.
 */
export default function UpdateBanner() {
  const { current, hub, load, start, currentError, hubError } = useSystemStore()
  const [confirming, setConfirming] = useState(false)
  const [starting, setStarting] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const navigate = useNavigate()

  const shared = current?.sharedInstall === true
  const status = shared ? hub : current
  const job = status?.job
  const running = jobRunning(job)
  const failed = job?.status === 'failed' || job?.status === 'rolled_back'
  const version = status?.latest?.serverVersion ?? ''
  const dismissKey = version ? `vibemobile.update.dismissed.${status?.scope}.${version}` : ''

  useEffect(() => {
    void load()
  }, [load])

  // The Hub's default runner shares the Hub install, so its own status is
  // meaningless; the Hub row is the one that can update.
  useEffect(() => {
    if (shared && !hub) void load({ hub: true })
  }, [shared, hub, load])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(shared ? { hub: true } : undefined)
    }, 60_000)
    return () => clearInterval(timer)
  }, [load, shared])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void load(shared ? { hub: true } : undefined), 1500)
    return () => clearInterval(timer)
  }, [running, load, shared])

  useEffect(() => {
    if (!dismissKey) return
    setDismissed(sessionStorage.getItem(dismissKey))
  }, [dismissKey])

  if (!status || !status.supported) return null
  if (!running && !failed && !status.updateAvailable) return null
  if (!running && dismissed === version) return null

  const error = (shared ? hubError : currentError) ?? (failed ? errorLabel(job?.error) : null)

  async function confirm() {
    setStarting(true)
    try {
      await start(shared)
      setConfirming(false)
    } catch {
      // The store keeps the error; the strip renders it below.
    } finally {
      setStarting(false)
    }
  }

  function dismiss() {
    if (!dismissKey) return
    sessionStorage.setItem(dismissKey, version)
    setDismissed(version)
  }

  return (
    <div role="status" className="shrink-0 border-b border-primary/20 bg-primary/10 px-3 py-1.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {running
            ? `正在升级：${phaseLabel(job?.phase)}`
            : failed
              ? '上次升级失败，已回到原版本'
              : `有新版本 ${version}`}
        </span>
        {running ? (
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="tap shrink-0 rounded-lg px-2 py-1 text-primary"
          >
            查看
          </button>
        ) : confirming ? null : (
          <>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="tap shrink-0 rounded-lg bg-primary px-3 py-1 font-medium text-primary-foreground"
            >
              {failed ? '重试' : '升级'}
            </button>
            <button
              type="button"
              onClick={dismiss}
              aria-label="稍后升级"
              className="tap shrink-0 px-1 text-muted-foreground"
            >
              ×
            </button>
          </>
        )}
      </div>

      {confirming && !running && (
        <div className="mt-1.5 space-y-1.5">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            升级会重启服务，正在执行的任务会中断；失败会自动回到原版本。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={starting}
              onClick={() => void confirm()}
              className="tap flex-1 rounded-lg bg-primary py-1.5 font-medium text-primary-foreground disabled:opacity-50"
            >
              {starting ? '正在启动…' : '确认升级'}
            </button>
            <button
              type="button"
              disabled={starting}
              onClick={() => setConfirming(false)}
              className="tap flex-1 rounded-lg border border-border py-1.5 text-muted-foreground disabled:opacity-50"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-1 truncate text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
