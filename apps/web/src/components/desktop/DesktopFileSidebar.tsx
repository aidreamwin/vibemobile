import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronRight, Columns2, FileCode2, FileImage, Folder, FolderOpen, GitBranch, RefreshCw } from 'lucide-react'
import { isImageFile } from '../../lib/fileImage'
import type { FileEntry } from '@vibemobile/protocol'
import { api } from '../../lib/api'
import { normalizeFilePath } from '../../lib/fileLink'
import { useWorkspaceStore } from '../../lib/workspace'

interface SidebarProps {
  activeFilePath: string | null
  visible?: boolean
  onOpenFile: (path: string, name: string) => void
  onSplitFile: (path: string, name: string) => void
  onOpenDiff: () => void
}

interface Directory {
  entries?: FileEntry[]
  loading?: boolean
  error?: string
}

interface TreeRow {
  entry: FileEntry
  parent: string
  level: number
  position: number
  siblings: number
}

const toolbarButton =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline focus-visible:outline-primary disabled:opacity-40'

function pathKey(path: string): string {
  // Paths belong to the runner, which may use a different OS than the browser.
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')) {
    return normalizeFilePath(path.replace(/\\/g, '/')).toLowerCase()
  }
  return normalizeFilePath(path)
}

function rowsInDirectory(
  directories: Record<string, Directory>,
  expanded: ReadonlySet<string>,
  parent: string,
  level = 1,
): TreeRow[] {
  const entries = directories[parent]?.entries ?? []
  return entries.flatMap((entry, index) => {
    const row = { entry, parent, level, position: index + 1, siblings: entries.length }
    return entry.type === 'directory' && expanded.has(entry.path)
      ? [row, ...rowsInDirectory(directories, expanded, entry.path, level + 1)]
      : [row]
  })
}

function DirectoryFeedback({
  directory,
  onRetry,
  root = false,
}: {
  directory: Directory | undefined
  onRetry: () => void
  root?: boolean
}) {
  if (directory?.error) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-destructive" title={directory.error}>
        <span className="truncate" role="status">
          无法读取{root ? '工作区' : '目录'}
        </span>
        <button type="button" className="shrink-0 rounded px-1 underline focus-visible:outline" onClick={onRetry}>
          重试
        </button>
      </div>
    )
  }
  if (!directory?.entries) return <span role="status">加载中…</span>
  if (directory.entries.length === 0) return <span>{root ? '工作区为空' : '空目录'}</span>
  return null
}

function WorkspaceFileTree({
  rootPath,
  activeFilePath,
  visible = true,
  onOpenFile,
  onSplitFile,
  onOpenDiff,
}: SidebarProps & { rootPath: string }) {
  const [directories, setDirectories] = useState<Record<string, Directory>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const pending = useRef(new Set<string>())
  const rowElements = useRef(new Map<string, HTMLDivElement>())
  const reveal = useRef<{ path: string | null; completed: boolean }>({ path: null, completed: false })

  const loadDirectory = useCallback(async (path: string) => {
    if (pending.current.has(path)) return
    pending.current.add(path)
    setDirectories((previous) => ({
      ...previous,
      [path]: { entries: previous[path]?.entries, loading: true },
    }))
    try {
      const { data } = await api.files(path)
      const entries = data.sort(
        (a, b) =>
          Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN'),
      )
      setDirectories((previous) => ({ ...previous, [path]: { entries } }))
    } catch (error) {
      setDirectories((previous) => ({
        ...previous,
        [path]: { entries: previous[path]?.entries, error: (error as Error).message },
      }))
    } finally {
      pending.current.delete(path)
    }
  }, [])

  useEffect(() => {
    void loadDirectory(rootPath)
  }, [rootPath, loadDirectory])

  const activeKey = activeFilePath ? pathKey(activeFilePath) : null
  useEffect(() => {
    if (reveal.current.path !== activeKey) reveal.current = { path: activeKey, completed: false }
    if (!visible || !activeKey || reveal.current.completed) return

    // Walk the runner's directory entries so requests use the displayed paths
    // even if the file link uses a different slash style or drive-letter case.
    let parent = rootPath
    const ancestors: string[] = []
    while (true) {
      const entry = directories[parent]?.entries?.find((item) => {
        const key = pathKey(item.path)
        return key === activeKey || (item.type === 'directory' && activeKey.startsWith(`${key}/`))
      })
      if (!entry) break
      if (entry.type === 'file') {
        reveal.current.completed = true
        break
      }
      ancestors.push(entry.path)
      parent = entry.path
      if (!directories[parent]) {
        void loadDirectory(parent)
        break
      }
    }
    if (ancestors.length) {
      setExpanded((previous) =>
        ancestors.every((path) => previous.has(path)) ? previous : new Set([...previous, ...ancestors]),
      )
    }
  }, [activeKey, visible, rootPath, directories, loadDirectory])

  const rows = useMemo(() => rowsInDirectory(directories, expanded, rootPath), [directories, expanded, rootPath])
  const selectedPath = activeKey
    ? rows.find(({ entry }) => entry.type === 'file' && pathKey(entry.path) === activeKey)?.entry.path
    : undefined
  const tabbablePath = rows.some(({ entry }) => entry.path === focusedPath)
    ? focusedPath
    : (selectedPath ?? rows[0]?.entry.path)

  useEffect(() => {
    if (visible && selectedPath) rowElements.current.get(selectedPath)?.scrollIntoView({ block: 'nearest' })
  }, [selectedPath, visible])

  function setDirectoryOpen(path: string, open: boolean) {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (open) next.add(path)
      else next.delete(path)
      return next
    })
    if (open) void loadDirectory(path)
    else if (activeKey?.startsWith(`${pathKey(path)}/`)) reveal.current = { path: activeKey, completed: true }
  }

  function activateRow(entry: FileEntry, split = false) {
    if (entry.type === 'directory') setDirectoryOpen(entry.path, !expanded.has(entry.path))
    else if (split) onSplitFile(entry.path, entry.name)
    else onOpenFile(entry.path, entry.name)
  }

  function handleRowKey(event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
    const { entry, parent } = row
    let target: string | undefined
    switch (event.key) {
      case 'ArrowUp':
        target = rows[index - 1]?.entry.path
        break
      case 'ArrowDown':
        target = rows[index + 1]?.entry.path
        break
      case 'Home':
        target = rows[0]?.entry.path
        break
      case 'End':
        target = rows.at(-1)?.entry.path
        break
      case 'ArrowRight':
        if (entry.type === 'directory') {
          if (!expanded.has(entry.path)) setDirectoryOpen(entry.path, true)
          else if (rows[index + 1]?.parent === entry.path) target = rows[index + 1].entry.path
        }
        break
      case 'ArrowLeft':
        if (expanded.has(entry.path)) setDirectoryOpen(entry.path, false)
        else target = parent
        break
      case 'Enter':
      case ' ':
        activateRow(entry, event.key === 'Enter' && event.shiftKey)
        break
      default:
        return
    }
    event.preventDefault()
    if (target) rowElements.current.get(target)?.focus()
  }

  function refreshTree() {
    void loadDirectory(rootPath)
    for (const { entry } of rows) {
      if (expanded.has(entry.path)) void loadDirectory(entry.path)
    }
  }

  const root = directories[rootPath]
  const workspaceName =
    rootPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || rootPath
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-2.5">
        <span title={rootPath} className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {workspaceName}
        </span>
        <button
          type="button"
          onClick={onOpenDiff}
          title="查看工作区改动"
          aria-label="查看工作区改动"
          className={toolbarButton}
        >
          <GitBranch className="size-3.5" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={refreshTree}
          title="刷新文件树"
          aria-label="刷新文件树"
          className={toolbarButton}
        >
          <RefreshCw className={`size-3.5 ${root?.loading ? 'motion-safe:animate-spin' : ''}`} strokeWidth={1.5} />
        </button>
      </div>

      <div className="scroll-y min-h-0 flex-1 px-1.5 pb-3">
        {(!root?.entries?.length || root.error) && (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            <DirectoryFeedback root directory={root} onRetry={() => void loadDirectory(rootPath)} />
          </div>
        )}
        <div role="tree" aria-label="工作区文件">
          {rows.map((row, index) => {
            const { entry, level, position, siblings } = row
            const directory = directories[entry.path]
            const isDirectory = entry.type === 'directory'
            const isOpen = isDirectory && expanded.has(entry.path)
            const isSelected = entry.path === selectedPath
            const Icon = isDirectory ? (isOpen ? FolderOpen : Folder) : isImageFile(entry.path) ? FileImage : FileCode2
            const indent = `min(${(level - 1) * 12 + 8}px, 40%)`

            return (
              <div key={entry.path} role="none">
                <div
                  ref={(element) => {
                    if (element) rowElements.current.set(entry.path, element)
                    else rowElements.current.delete(entry.path)
                  }}
                  role="treeitem"
                  aria-label={entry.name}
                  aria-level={level}
                  aria-posinset={position}
                  aria-setsize={siblings}
                  aria-expanded={isDirectory ? isOpen : undefined}
                  aria-selected={isSelected}
                  aria-keyshortcuts={isDirectory ? undefined : 'Shift+Enter'}
                  tabIndex={tabbablePath === entry.path ? 0 : -1}
                  style={{ paddingLeft: indent }}
                  onFocus={() => setFocusedPath(entry.path)}
                  onClick={() => activateRow(entry)}
                  onKeyDown={(event) => handleRowKey(event, row, index)}
                  className={`group flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md pr-1.5 text-[12.5px] transition-colors focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-primary ${
                    isSelected
                      ? 'bg-primary/12 font-medium text-foreground'
                      : 'text-foreground/85 hover:bg-secondary/60 hover:text-foreground'
                  }`}
                >
                  {isDirectory ? (
                    <ChevronRight
                      className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      strokeWidth={1.6}
                    />
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  <span className="min-w-0 truncate" title={entry.name}>
                    {entry.name}
                  </span>
                  {!isDirectory && (
                    <button
                      type="button"
                      tabIndex={-1}
                      title="分屏打开 (Shift+Enter)"
                      aria-label={`分屏打开 ${entry.name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onSplitFile(entry.path, entry.name)
                      }}
                      className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-raised hover:text-foreground focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Columns2 className="size-3" strokeWidth={1.6} />
                    </button>
                  )}
                </div>
                {isOpen && (!directory?.entries?.length || directory.error) && (
                  <div
                    role="none"
                    style={{ paddingLeft: `min(${level * 12 + 26}px, 50%)` }}
                    className="py-1 text-[11px] text-muted-foreground"
                  >
                    <DirectoryFeedback directory={directory} onRetry={() => void loadDirectory(entry.path)} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default function DesktopFileSidebar(props: SidebarProps) {
  const defaultCwd = useWorkspaceStore((state) => state.defaultCwd)
  const workspaceLoaded = useWorkspaceStore((state) => state.loaded)
  const workspaceError = useWorkspaceStore((state) => state.error)
  const loadWorkspace = useWorkspaceStore((state) => state.load)

  if (workspaceLoaded && defaultCwd) {
    return <WorkspaceFileTree key={defaultCwd} rootPath={defaultCwd} {...props} />
  }

  return (
    <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
      <span role="status">
        {workspaceError ? '无法加载工作区' : workspaceLoaded ? '没有可用的工作区' : '正在加载工作区…'}
      </span>
      {workspaceError && (
        <button
          type="button"
          title={workspaceError}
          className="rounded px-1 text-destructive underline focus-visible:outline"
          onClick={() => void loadWorkspace()}
        >
          重试
        </button>
      )}
    </div>
  )
}
