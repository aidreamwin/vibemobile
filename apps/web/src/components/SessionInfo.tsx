import { useEffect, useState } from 'react'
import { Download, Info, Loader2 } from 'lucide-react'
import { Popover } from 'radix-ui'
import type { ProviderId } from '@vibemobile/protocol'
import { api } from '../lib/api'
import { runnerId } from '../lib/runner'

export default function SessionInfo({
  provider,
  onDownload,
  downloading,
}: {
  provider?: ProviderId
  onDownload: () => void
  downloading: boolean
}) {
  const [runnerName, setRunnerName] = useState(runnerId || '本机')
  useEffect(() => {
    if (!runnerId) return
    let active = true
    void api
      .runners()
      .then((result) => {
        const runner = result.data.find((item) => item.id === runnerId)
        if (active && runner) setRunnerName(runner.name)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])
  const agent = provider === 'claude' ? 'Claude Code' : provider === 'codex' ? 'Codex' : (provider ?? '未知')
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="会话运行信息"
          className="tap shrink-0 rounded-xl text-muted-foreground/60 active:bg-secondary data-[state=open]:text-primary"
        >
          <Info aria-hidden="true" className="size-[18px]" strokeWidth={1.7} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label="会话运行信息"
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="z-50 w-60 max-w-[calc(100vw-24px)] rounded-xl border border-border bg-popover px-3.5 py-3 text-xs leading-relaxed shadow-xl outline-none [overflow-wrap:anywhere]"
        >
          <dl className="space-y-2">
            <div className="flex items-start gap-3">
              <dt className="w-12 shrink-0 text-muted-foreground">Runner</dt>
              <dd className="min-w-0 flex-1 text-foreground">
                {runnerName}
                {runnerId && <span className="block font-mono text-[11px] text-muted-foreground">{runnerId}</span>}
              </dd>
            </div>
            <div className="flex items-start gap-3">
              <dt className="w-12 shrink-0 text-muted-foreground">Agent</dt>
              <dd className="min-w-0 flex-1 text-foreground">{agent}</dd>
            </div>
          </dl>
          <div className="mt-3 border-t border-border pt-2">
            <button
              type="button"
              onClick={onDownload}
              disabled={downloading}
              title="下载会话 Markdown"
              aria-label="下载会话 Markdown"
              className="tap flex w-full items-center gap-1.5 rounded-lg text-left text-[11px] text-muted-foreground active:bg-secondary disabled:opacity-50"
            >
              {downloading ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              ) : (
                <Download aria-hidden="true" className="size-3.5" strokeWidth={1.7} />
              )}
              <span>{downloading ? '正在导出…' : '下载会话 Markdown'}</span>
            </button>
          </div>
          <Popover.Arrow className="fill-popover" width={10} height={5} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
