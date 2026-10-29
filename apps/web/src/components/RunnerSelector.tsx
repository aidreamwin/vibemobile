import { useEffect, useState } from 'react'
import { Monitor } from 'lucide-react'
import { api } from '../lib/api'
import { runnerId, runnerSwitchUrl, type RunnerInfo } from '../lib/runner'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectValue, SelectTrigger } from './ui/select'

export default function RunnerSelector({ compact = false }: { compact?: boolean }) {
  const [runners, setRunners] = useState<RunnerInfo[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!runnerId) return
    let active = true
    const refresh = () =>
      api
        .runners()
        .then((result) => {
          if (active) {
            setRunners(result.data)
            setError(false)
          }
        })
        .catch(() => {
          if (active) setError(true)
        })
    void refresh()
    const timer = setInterval(() => void refresh(), 10_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
  if (!runnerId) return null
  const selected = runners.find((runner) => runner.id === runnerId)
  const choices = runners.length ? runners : [{ id: runnerId, name: runnerId, online: false, lastSeen: null }]
  const status = error ? '状态获取失败' : !selected ? '连接中' : selected.online ? '在线' : '离线'
  const dot = error || !selected ? 'bg-warning' : selected.online ? 'bg-success' : 'bg-muted-foreground'
  return (
    <div
      className={
        compact
          ? 'flex shrink-0 items-center'
          : 'safe-top flex shrink-0 items-center gap-3 border-b border-border bg-background px-4 py-2 text-sm'
      }
    >
      {!compact && <span className="shrink-0 text-muted-foreground">执行机器</span>}
      <Select
        value={runnerId}
        onValueChange={(value) => {
          if (value !== runnerId) window.location.assign(runnerSwitchUrl(value))
        }}
      >
        <SelectTrigger
          id="runner-select"
          aria-label={`执行机器：${selected?.name ?? runnerId}，${status}`}
          title={`${selected?.name ?? runnerId} · ${status}`}
          className={`${compact ? 'w-11 shrink-0 justify-center border-0 bg-transparent text-muted-foreground dark:bg-transparent dark:hover:bg-transparent [&>svg]:hidden' : 'min-w-0 flex-1 border-border/70 bg-secondary/60 dark:bg-secondary/60 dark:hover:bg-secondary'} h-11 gap-1.5 rounded-xl px-2 text-xs font-medium shadow-none focus-visible:ring-2 data-[size=default]:h-11`}
        >
          <SelectValue>
            <span className="relative flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`${compact ? 'absolute -right-1 -top-0.5 ring-2 ring-background' : 'shrink-0'} size-1.5 rounded-full ${dot}`}
              />
              {compact ? (
                <Monitor aria-hidden="true" className="size-[18px]" strokeWidth={1.8} />
              ) : (
                <span className="truncate">{selected?.name ?? runnerId}</span>
              )}
              <span className="sr-only">{status}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent
          position="popper"
          align="start"
          className="min-w-56 max-w-[calc(100vw-24px)] rounded-xl border-border bg-popover p-1 shadow-xl"
        >
          <SelectGroup>
            <SelectLabel className="px-2 pb-2 text-[11px] font-normal">执行机器</SelectLabel>
            {choices.map((runner) => (
              <SelectItem key={runner.id} value={runner.id} className="min-h-11 rounded-lg py-2">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${runner.online ? 'bg-success' : 'bg-muted-foreground'}`}
                />
                <span className="max-w-40 truncate" title={runner.name}>
                  {runner.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {!selected ? '连接中' : runner.online ? '在线' : '离线'}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error && (
        <span role="status" className={compact ? 'sr-only' : 'text-xs text-destructive'}>
          状态获取失败
        </span>
      )}
    </div>
  )
}
