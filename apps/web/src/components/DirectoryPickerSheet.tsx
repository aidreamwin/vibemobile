import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, Folder, HardDrive } from 'lucide-react'
import type { FileEntry, Project } from '@vibemobile/protocol'
import { api } from '../lib/api'
import { parentPath, workspaceRootFor } from '../lib/workspace'
import { Button } from './ui/button'
import Sheet from './Sheet'

export default function DirectoryPickerSheet({
  projects,
  initialPath,
  title = '选择工作目录',
  onClose,
  onSelect,
}: {
  projects: Project[]
  initialPath: string
  title?: string
  onClose: () => void
  onSelect: (path: string) => void
}) {
  const initial = initialPath || projects[0]?.path || ''
  const [current, setCurrent] = useState(initial)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const root = useMemo(() => workspaceRootFor(projects, current), [projects, current])
  const canGoUp = Boolean(root && current !== root.path)

  useEffect(() => {
    if (!current) {
      setEntries([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .files(current, true)
      .then(({ data }) => {
        if (!cancelled) setEntries(data.filter((entry) => entry.type === 'directory'))
      })
      .catch((err) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [current])

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="px-4 pt-2 pb-4">
        {projects.length > 1 && (
          <div className="scroll-x -mx-1 mb-3 flex gap-1.5 px-1 pb-1">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => setCurrent(project.path)}
                className={`shrink-0 rounded-lg border px-3 py-2 text-[12px] whitespace-nowrap ${
                  root?.id === project.id
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-secondary text-muted-foreground'
                }`}
              >
                {project.name}
              </button>
            ))}
          </div>
        )}

        <div className="mb-2 flex min-h-12 items-center gap-2 border-y border-border py-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!canGoUp}
            onClick={() => setCurrent(parentPath(current))}
            className="tap shrink-0 rounded-lg text-muted-foreground"
            aria-label="上一级目录"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <HardDrive className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 break-all font-mono text-[12px] leading-relaxed text-foreground">
            {current || '未配置工作区'}
          </span>
        </div>

        <div className="scroll-y min-h-40 max-h-[45dvh]">
          {error ? (
            <div className="px-3 py-10 text-center text-[12px] text-destructive">{error}</div>
          ) : loading ? (
            <div className="px-3 py-10 text-center text-[12px] text-muted-foreground">读取目录中…</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-10 text-center text-[12px] text-muted-foreground">没有子文件夹</div>
          ) : (
            <ul className="divide-y divide-border">
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => setCurrent(entry.path)}
                    className="flex min-h-12 w-full items-center gap-3 px-2 text-left active:bg-secondary"
                  >
                    <Folder className="size-5 shrink-0 text-primary" fill="currentColor" />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-foreground">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Button
          type="button"
          onClick={() => onSelect(current)}
          disabled={!current || loading || Boolean(error)}
          className="tap mt-3 h-auto min-h-12 w-full gap-2 text-[15px]"
        >
          <Check className="size-4" />
          选择此文件夹
        </Button>
      </div>
    </Sheet>
  )
}
