import {
  FolderOpen,
  Eye,
  Code,
  Ellipsis,
  Pencil,
  GitBranch,
  RefreshCw,
  Search,
  ArrowUpDown,
  FileImage,
  FileVideo,
  FileCode2,
  FileText,
  ChevronRight,
  ChevronLeft,
  Folder,
  LoaderCircle,
  FileWarning,
  WrapText,
  Download,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog'
import ToolbarRow from '../components/ToolbarRow'
import RunnerSelector from '../components/RunnerSelector'
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileContent, FileEntry } from '@vibemobile/protocol'
import { api, ApiError, fileDownloadUrl } from '../lib/api'
import { formatBytes, shortPath } from '../lib/format'
import {
  getDirectorySnapshot,
  getFileSnapshot,
  invalidateDirectorySnapshot,
  readDirectorySnapshot,
  readFileSnapshot,
  rememberFileSnapshot,
  fileDrafts as drafts,
  savingFiles,
} from '../lib/fileSnapshots'
import { isPathInside, parentPath, useWorkspaceStore } from '../lib/workspace'
import { UnifiedDiff } from '../components/DiffView'
import FileBody, { isRenderable } from '../components/FileBody'
import MediaFilePreview from '../components/MediaFilePreview'
import FileActions from '../components/FileActions'
import { isImageFile, isNativeMedia, isVideoFile } from '../lib/fileImage'
import { fileReadError } from '../lib/fileErrors'
import FileEditor, { MAX_EDIT_LINES } from '../components/FileEditor'
import { useDocumentTitle } from '../lib/title'
import DesktopFilePane, { type FilePaneView } from '../components/desktop/DesktopFilePane'

type View = { kind: 'list'; path: string } | FilePaneView
const EMPTY_ENTRIES: FileEntry[] = []

/**
 * Where the file browser was left, remembered across a trip to another tab.
 *
 * In memory rather than in storage, and module scope rather than component
 * state, for the same reason the session list does it (see Sessions.tsx):
 * switching to 会话 unmounts this page, so the browser's own scroll
 * restoration — which only ever knew about the window — cannot help here.
 *
 * The *whole* view is remembered, not just an offset: coming back to the
 * workspace root when you had been reading a file two directories down is the
 * same complaint as coming back to the top of a list.
 */
let lastView: View | null = null

/** The scroll offset, per screen. A file and a directory are different places. */
const offsets = new Map<string, number>()

/**
 * An unsaved draft, kept across a trip to another bottom-nav tab.
 *
 * Switching tabs unmounts this page outright, so there is nothing to warn: the
 * component is gone before any handler could run. Same philosophy as `lastView`
 * above — state this page owns has to live outside React if it is to survive
 * being unmounted — and the same reason the draft is a string here rather than
 * being pushed into `localStorage`: it belongs to this browsing session, not to
 * the device, and a stale draft restored a week later would be a trap.
 */

/** Which screen a scroll offset belongs to. */
function viewKey(view: View): string {
  if (view.kind === 'list') return `list:${view.path}`
  if (view.kind === 'file') return `file:${view.path}`
  return `diff:${view.path ?? ''}`
}

/**
 * Whether a view is somewhere this page can still be — every path it can open
 * lives under the workspace root (the server enforces the same roots). A
 * remembered view from another project, or the empty path the first render
 * starts on, is dropped for the root rather than fetched into an error.
 */
function inWorkspace(view: View, root: string): boolean {
  if (view.kind === 'diff') return view.path === undefined || isPathInside(view.path, root)
  return Boolean(view.path) && isPathInside(view.path, root)
}

export interface FilesProps {
  embedded?: boolean
  visible?: boolean
  fixedView?: FilePaneView
  line?: number
  onOpenFileTab?: (path: string, name: string, line?: number) => void
  onOpenDiffTab?: (path?: string) => void
}

export default function Files({
  embedded = false,
  visible = true,
  fixedView,
  line,
  onOpenFileTab,
  onOpenDiffTab,
}: FilesProps = {}) {
  const defaultCwd = useWorkspaceStore((state) => state.defaultCwd)
  const workspaceLoaded = useWorkspaceStore((state) => state.loaded)
  // Picked up from the last visit to this page, if there was one — which is the
  // whole point: the root of the workspace is the fallback, not the default.
  const [browserView, setView] = useState<View>(() =>
    lastView && (!defaultCwd || inWorkspace(lastView, defaultCwd)) ? lastView : { kind: 'list', path: defaultCwd },
  )
  const view = fixedView ?? browserView
  const nativeMedia = view.kind === 'file' && isNativeMedia(view.path)
  useDocumentTitle(
    embedded || !visible
      ? ''
      : view.kind === 'file'
        ? view.name
        : view.kind === 'list'
          ? view.path.split(/[\\/]/).filter(Boolean).pop() || '文件'
          : '改动',
  )

  const [entries, setEntries] = useState(() =>
    view.kind === 'list' ? (getDirectorySnapshot(view.path) ?? EMPTY_ENTRIES) : EMPTY_ENTRIES,
  )
  const [content, setContent] = useState(() =>
    view.kind === 'file' && !nativeMedia ? getFileSnapshot(view.path) : null,
  )
  const [diff, setDiff] = useState('')
  // Markdown opens rendered; the header's code/eye button flips it back.
  const [preview, setPreview] = useState(!line)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchDirectory = useRef<string | null>(null)
  const [sortByName, setSortByName] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [discardOpen, setDiscardOpen] = useState(false)

  const [loading, setLoading] = useState(() =>
    view.kind === 'list' ? !getDirectorySnapshot(view.path) : !content && !nativeMedia,
  )
  const [error, setError] = useState<string | null>(null)
  /** Bumped by 刷新, so re-reading the same view is one more fetch. */
  const [reload, setReload] = useState(0)
  const refresh = useCallback(() => setReload((n) => n + 1), [])
  const lastReload = useRef(reload)

  // Editing state lives here rather than inside `FileEditor`, because three
  // things outside it need to know: the header (which buttons to draw), the
  // scroll memory (below), and the draft that survives a tab switch.
  const [editing, setEditing] = useState(() => view.kind === 'file' && drafts.has(view.path))
  const [draft, setDraft] = useState(() => (view.kind === 'file' ? (drafts.get(view.path)?.text ?? '') : ''))
  const [editBase, setEditBase] = useState(() => (view.kind === 'file' ? drafts.get(view.path)?.base : undefined))
  const [saving, setSaving] = useState(false)
  /**
   * Kept apart from `error` on purpose. `error` is the page-level fetch banner,
   * and a failed SAVE landing there would also satisfy `firstLoad`'s fallback
   * logic and bounce the user back to the directory listing — losing the draft
   * that just failed to save, which is the one thing that must not happen.
   */
  const [saveError, setSaveError] = useState<string | null>(null)

  const deferredQuery = useDeferredValue(query)
  const searchQuery = query ? deferredQuery : ''
  const sortedEntries = useMemo(() => {
    if (!sortByName) return entries
    return [...entries].sort(
      (a, b) =>
        Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN'),
    )
  }, [entries, sortByName])
  const visibleEntries = useMemo(() => {
    const needle = searchQuery.trim().toLocaleLowerCase()
    return needle ? sortedEntries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle)) : sortedEntries
  }, [sortedEntries, searchQuery])
  const filtering = view.kind === 'list' && Boolean(query)

  const scrollRef = useRef<HTMLDivElement>(null)
  const key = viewKey(view)

  useEffect(() => {
    if (!visible) setDiscardOpen(false)
  }, [visible])

  useEffect(() => {
    if (line) setPreview(false)
  }, [line])

  useEffect(() => {
    if (!fixedView) lastView = view
  }, [view, fixedView])

  const dirty = editing && editBase !== undefined && draft !== editBase.text

  /** Files the editor will not open, with the reason to show instead of a button. */
  const editBlockedBy = useMemo(() => {
    if (!content) return null
    if (content.truncated) return embedded ? '文件过大，仅可预览' : '文件太大，无法在手机上编辑'
    if (content.text.split('\n').length > MAX_EDIT_LINES) {
      return embedded ? `文件超过 ${MAX_EDIT_LINES} 行，仅可预览` : `超过 ${MAX_EDIT_LINES} 行，请在电脑上编辑`
    }
    return null
  }, [content, embedded])

  useEffect(() => {
    if (view.kind !== 'file') return
    if (dirty && editBase) drafts.set(view.path, { text: draft, base: editBase })
    else drafts.delete(view.path)
  }, [dirty, draft, editBase, view])

  // Closing the tab or pulling to refresh is the one exit that cannot be
  // captured; this at least makes the browser ask.
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Legacy browsers require a truthy returnValue; the string is ignored.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const go = useCallback((next: View) => {
    // `loading` moves in the same tick as the view on purpose: the fetch below
    // only starts after the render that shows the new screen, and without this
    // that render would carry the *previous* screen's rows or file body.
    const image = next.kind === 'file' && isNativeMedia(next.path)
    const cached = next.kind === 'file' && !image ? getFileSnapshot(next.path) : null
    const cachedEntries = next.kind === 'list' ? getDirectorySnapshot(next.path) : null
    const restoredDraft = next.kind === 'file' ? drafts.get(next.path) : undefined
    setLoading(!image && !cached && !cachedEntries)
    setEntries(cachedEntries ?? EMPTY_ENTRIES)
    setContent(cached)
    setEditing(Boolean(restoredDraft))
    setDraft(restoredDraft?.text ?? '')
    setEditBase(restoredDraft?.base)
    setSaveError(null)
    setError(null)
    if (next.kind === 'list' && next.path !== searchDirectory.current) {
      setQuery('')
      setSearchOpen(false)
      searchDirectory.current = null
    }
    setView(next)
  }, [])

  const openEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.type === 'directory') {
        go({ kind: 'list', path: entry.path })
      } else if (onOpenFileTab) {
        onOpenFileTab(entry.path, entry.name)
      } else {
        go({ kind: 'file', path: entry.path, name: entry.name })
      }
    },
    [go, onOpenFileTab],
  )

  function beginEdit() {
    if (!content) return
    setSaveError(null)
    setDraft(content.text)
    setEditBase(content)
    setEditing(true)
  }

  function cancelEdit() {
    if (dirty) {
      setDiscardOpen(true)
      return
    }
    discardEdit()
  }

  function discardEdit() {
    setDiscardOpen(false)
    setSaveError(null)
    setDraft(content?.text ?? '')
    setEditBase(undefined)
    setEditing(false)
  }

  async function save() {
    if (!editBase || view.kind !== 'file' || !dirty || saving) return
    setSaving(true)
    savingFiles.add(view.path)
    setSaveError(null)
    try {
      const saved = await api.saveFile(view.path, draft, editBase.rev)
      // The server's copy is authoritative and is not byte-identical to what was
      // sent — it restored the file's line endings — so the draft is rebased on
      // it rather than kept as typed.
      setContent(saved)
      setDraft(saved.text)
      setEditBase(undefined)
      rememberFileSnapshot(view.path, saved)
      invalidateDirectorySnapshot(parentPath(view.path))
      drafts.delete(view.path)
      setEditing(false)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone else wrote the file while this draft was open. Re-reading is
        // the only correct move; the draft is deliberately left alone, because
        // the user's edit is the one thing the app cannot reconstruct, and
        // discarding it to match the disk would be choosing the agent's work
        // over theirs without asking.
        const fresh = await api.fileContent(view.path).catch(() => null)
        if (fresh) {
          setContent(fresh)
          setEditBase(fresh)
          rememberFileSnapshot(view.path, fresh)
        }
        setSaveError('文件在磁盘上已被改动。你的草稿还在，再点一次保存会覆盖磁盘上的版本。')
      } else {
        setSaveError((err as Error).message)
      }
    } finally {
      savingFiles.delete(view.path)
      setSaving(false)
    }
  }

  // The root arrives asynchronously, and a remembered path only means anything
  // inside it. Changing the app-wide default in 设置 lands here too, and it is
  // deliberately still a reset to the root: that is a different workspace, not
  // a return to this one.
  useEffect(() => {
    if (fixedView) return
    if (!defaultCwd) {
      if (workspaceLoaded) setLoading(false)
      return
    }
    if (inWorkspace(view, defaultCwd)) return
    setContent(null)
    go({ kind: 'list', path: defaultCwd })
  }, [defaultCwd, fixedView, go, workspaceLoaded, view])

  // One fetcher, keyed on the view itself, so entering a directory, opening a
  // file and landing back on a remembered one are all the same path through
  // here — and 刷新 is just one more turn of `reload`.
  useEffect(() => {
    if (!visible || editing) return
    if (view.kind === 'list' && !view.path) return
    if (view.kind === 'diff' && !defaultCwd) return
    if (nativeMedia) {
      lastReload.current = reload
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    const force = reload !== lastReload.current
    lastReload.current = reload
    const cached = view.kind === 'file' ? getFileSnapshot(view.path) : null
    const cachedEntries = view.kind === 'list' ? getDirectorySnapshot(view.path) : null
    if (cached) setContent(cached)
    if (cachedEntries) setEntries(cachedEntries)
    setLoading(!cached && !cachedEntries)
    setError(null)

    void (async () => {
      try {
        if (view.kind === 'list') {
          const res = await readDirectorySnapshot(view.path, force)
          if (!cancelled) setEntries(res)
        } else if (view.kind === 'file') {
          const res = await readFileSnapshot(view.path, force)
          if (!cancelled) setContent(res)
        } else {
          const res = await api.fileDiff(defaultCwd, view.path)
          if (!cancelled) setDiff(res.diff)
        }
      } catch (err) {
        if (cancelled) return
        setError(fileReadError(err))
        if (view.kind === 'file' && !getFileSnapshot(view.path)) setContent(null)
        if (view.kind === 'list' && !getDirectorySnapshot(view.path)) setEntries(EMPTY_ENTRIES)
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [view, defaultCwd, fixedView, reload, visible, nativeMedia, editing])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    // Not while loading: the only thing on screen then is a short 加载中 block,
    // which clamps `scrollTop` to 0 and would overwrite the position this exists
    // to keep, every time a page is opened or refreshed.
    //
    // Not while editing either, and for exactly the same reason: entering the
    // editor replaces the whole document with a `h-full` textarea, so the outer
    // container's content shrinks, the browser clamps `scrollTop`, and the
    // resulting scroll event would write the clamped value over the position the
    // reader had. Same shape as the 加载中 frame, one layer further in.
    if (!el || !visible || loading || editing || filtering) return
    offsets.set(key, el.scrollTop)
  }, [key, loading, editing, visible, filtering])

  // Laid out, not painted: restoring in a plain effect shows the top of the
  // page for one frame first.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !visible || loading || editing || filtering) return
    // Absent means "never seen" — a directory opened for the first time starts
    // at the top, which is what `0` here does.
    el.scrollTop = offsets.get(key) ?? 0
    // `editing` is a dependency so that leaving the editor puts the reader back
    // where they were, rather than at the top the clamp left behind.
  }, [key, loading, editing, visible, filtering])

  const discardDialog = (
    <AlertDialog open={visible && discardOpen} onOpenChange={setDiscardOpen}>
      <AlertDialogContent size="sm" className="w-[calc(100%-2rem)] rounded-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
          <AlertDialogDescription className="break-all">
            {view.kind === 'file' ? view.name : '文件'} 的修改尚未保存。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">继续编辑</AlertDialogCancel>
          <AlertDialogAction variant="destructive" className="min-h-11" onClick={discardEdit}>
            放弃修改
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  if (embedded && fixedView) {
    return (
      <>
        <DesktopFilePane
          visible={visible}
          view={fixedView}
          root={defaultCwd}
          line={line}
          content={editing ? (content ?? editBase ?? null) : content}
          diff={diff}
          preview={preview}
          loading={loading && !editing}
          error={error}
          scrollRef={scrollRef}
          onScroll={onScroll}
          onPreview={setPreview}
          onOpenFile={
            onOpenFileTab &&
            ((ref) => onOpenFileTab(ref.path, ref.path.split(/[\\/]/).at(-1) || ref.path, ref.line ?? undefined))
          }
          onOpenDiff={onOpenDiffTab}
          onRefresh={() => setReload((n) => n + 1)}
          onEdit={beginEdit}
          editBlockedBy={editBlockedBy}
          imageRevision={reload}
          editor={
            editing
              ? {
                  value: draft,
                  dirty,
                  saving,
                  error: saveError,
                  onChange: setDraft,
                  onCancel: cancelEdit,
                  onSave: () => void save(),
                }
              : undefined
          }
        />
        {discardDialog}
      </>
    )
  }

  const backDirectory = view.kind === 'list' ? parentPath(view.path) : view.path ? parentPath(view.path) : defaultCwd
  const canGoBack =
    !fixedView && (view.kind !== 'list' || (view.path !== defaultCwd && isPathInside(backDirectory, defaultCwd)))
  const fileTool = 'tap shrink-0 rounded-xl text-muted-foreground active:bg-secondary'
  const viewTitle =
    view.kind === 'file'
      ? view.name
      : view.kind === 'list'
        ? view.path.split(/[\\/]/).filter(Boolean).at(-1) || '文件'
        : '工作区改动'
  const directoryCount = loading ? '' : filtering ? `${visibleEntries.length} 个结果` : `${entries.length} 项`
  const fileDetail =
    view.kind === 'file'
      ? [shortPath(parentPath(view.path), 1), content && formatBytes(content.bytes)].filter(Boolean).join(' · ')
      : ''
  const viewDetail =
    view.kind === 'list'
      ? [canGoBack ? shortPath(backDirectory, 1) : '工作区', directoryCount].filter(Boolean).join(' · ')
      : fileDetail
  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    searchDirectory.current = null
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="safe-top shrink-0 border-b border-border bg-background/95 backdrop-blur-xl">
        <ToolbarRow compact={embedded}>
          {view.kind === 'file' && editing ? (
            <>
              <div className="min-w-0 flex-1 pl-2">
                <div className="truncate text-[15px] font-semibold text-foreground" title={view.name}>
                  {view.name}
                </div>
                <div role="status" className={`text-[11px] ${dirty ? 'text-warning' : 'text-muted-foreground'}`}>
                  {saving ? '保存中…' : dirty ? '未保存的修改' : '没有改动'}
                </div>
              </div>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className="min-h-11 shrink-0 rounded-xl px-3 text-sm text-muted-foreground active:bg-secondary disabled:opacity-40"
                aria-label="取消编辑"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty}
                className="min-h-11 shrink-0 rounded-xl bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40"
                aria-label="保存文件"
              >
                {saving ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : '保存'}
              </button>
            </>
          ) : (
            <>
              {canGoBack ? (
                <button
                  type="button"
                  onClick={() => go({ kind: 'list', path: backDirectory })}
                  className={fileTool}
                  aria-label="上一级"
                  title="上一级"
                >
                  <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.8} />
                </button>
              ) : (
                <div className="grid size-9 shrink-0 place-items-center text-foreground">
                  <FolderOpen aria-hidden="true" className="size-5" strokeWidth={1.8} />
                </div>
              )}
              <div className="min-w-0 flex-1" title={view.path}>
                <h1 className="truncate text-[15px] font-semibold leading-tight text-foreground">{viewTitle}</h1>
                {viewDetail && (
                  <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">{viewDetail}</p>
                )}
              </div>
              {!embedded && !canGoBack && <RunnerSelector compact />}
              {view.kind === 'file' && content && isRenderable(view.path) && (
                <button
                  type="button"
                  onClick={() => setPreview(!preview)}
                  aria-label={preview ? '查看源码' : '预览文件'}
                  title={preview ? '查看源码' : '预览文件'}
                  aria-pressed={preview}
                  className={`${fileTool} ${preview ? 'bg-secondary text-foreground' : ''}`}
                >
                  {preview ? (
                    <Code aria-hidden="true" className="size-5" />
                  ) : (
                    <Eye aria-hidden="true" className="size-5" />
                  )}
                </button>
              )}
              {view.kind === 'file' && content && !editBlockedBy && !error && (
                <button type="button" onClick={beginEdit} className={fileTool} aria-label="编辑文件" title="编辑文件">
                  <Pencil aria-hidden="true" className="size-5" strokeWidth={1.8} />
                </button>
              )}
              {view.kind === 'list' && (
                <button
                  type="button"
                  onClick={() => {
                    if (searchOpen) closeSearch()
                    else {
                      searchDirectory.current = view.path
                      setSearchOpen(true)
                    }
                  }}
                  className={`${fileTool} ${searchOpen ? 'bg-secondary text-foreground' : ''}`}
                  aria-label={searchOpen ? '关闭文件搜索' : '搜索文件'}
                  aria-expanded={searchOpen}
                >
                  <Search aria-hidden="true" className="size-5" />
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="文件操作" title="文件操作" className={fileTool}>
                    <Ellipsis aria-hidden="true" className="size-5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44 rounded-xl border-border p-1 shadow-xl">
                  {view.kind === 'file' && (
                    <DropdownMenuItem asChild className="min-h-11 rounded-lg">
                      <a href={fileDownloadUrl(view.path)} download>
                        <Download /> 下载文件
                      </a>
                    </DropdownMenuItem>
                  )}
                  {view.kind === 'list' && (
                    <DropdownMenuCheckboxItem
                      checked={sortByName}
                      onCheckedChange={setSortByName}
                      className="min-h-11 rounded-lg"
                    >
                      <ArrowUpDown /> 按名称排序
                    </DropdownMenuCheckboxItem>
                  )}
                  {view.kind === 'file' && !nativeMedia && (!preview || !isRenderable(view.path)) && (
                    <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap} className="min-h-11 rounded-lg">
                      <WrapText /> 自动换行
                    </DropdownMenuCheckboxItem>
                  )}
                  {view.kind !== 'diff' && (
                    <DropdownMenuItem
                      onSelect={() => {
                        const path = view.kind === 'file' ? view.path : undefined
                        if (onOpenDiffTab) onOpenDiffTab(path)
                        else go({ kind: 'diff', path })
                      }}
                      className="min-h-11 rounded-lg"
                    >
                      <GitBranch />
                      查看改动
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={refresh} className="min-h-11 rounded-lg">
                    <RefreshCw />
                    刷新
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </ToolbarRow>
        {view.kind === 'list' && searchOpen && (
          <div className="flex items-center gap-2 px-3 pb-2">
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                // biome-ignore lint/a11y/noAutofocus: the user explicitly opens file search.
                autoFocus={visible}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeSearch()
                }}
                placeholder="搜索当前目录"
                aria-label="搜索当前目录"
                className="h-11 w-full rounded-xl border border-border bg-secondary pl-9 pr-3 text-[16px] text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={closeSearch}
              className="min-h-11 shrink-0 rounded-xl px-2 text-sm text-muted-foreground"
            >
              取消
            </button>
          </div>
        )}
      </header>
      {saveError && (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/35 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          {saveError}
        </div>
      )}
      {view.kind === 'file' && !editing && editBlockedBy && (
        <div className="shrink-0 border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground">
          {editBlockedBy}
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className="scroll-y min-h-0 min-w-0 flex-1">
        {editing && view.kind === 'file' ? (
          <FileEditor
            path={view.path}
            value={draft}
            onChange={setDraft}
            disabled={saving}
            visible={visible}
            onSave={() => void save()}
          />
        ) : loading ? (
          <div role="status" className="grid min-h-full place-content-center text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              正在读取…
            </span>
          </div>
        ) : error ? (
          <div className="grid min-h-full place-content-center justify-items-center gap-3 px-8 text-center">
            <FileWarning aria-hidden="true" className="size-9 text-muted-foreground" strokeWidth={1.4} />
            <p role="alert" className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              {error}
            </p>
            <button
              type="button"
              onClick={refresh}
              className="min-h-11 rounded-xl border border-border px-5 text-sm text-foreground active:bg-secondary"
            >
              重试
            </button>
          </div>
        ) : view.kind === 'list' ? (
          <DirectoryList
            entries={visibleEntries}
            filtered={Boolean(searchQuery)}
            onOpen={openEntry}
            root={defaultCwd}
            onChanged={refresh}
          />
        ) : view.kind === 'file' ? (
          nativeMedia ? (
            <MediaFilePreview key={`${view.path}:${reload}`} path={view.path} refresh={reload > 0} visible={visible} />
          ) : (
            content && (
              <FileBody
                content={content}
                path={view.path}
                line={line}
                preview={preview}
                visible={visible}
                wrap={wrap}
              />
            )
          )
        ) : (
          <UnifiedDiff diff={diff} />
        )}
      </div>
      {discardDialog}
    </div>
  )
}

const DirectoryList = memo(function DirectoryList({
  entries,
  filtered,
  onOpen,
  root,
  onChanged,
}: {
  entries: FileEntry[]
  filtered: boolean
  onOpen: (entry: FileEntry) => void
  root: string
  onChanged: () => void
}) {
  return (
    <ul className="divide-y divide-border/70 overflow-hidden px-3 py-1">
      {entries.map((entry) => (
        <DirectoryRow key={entry.path} entry={entry} onOpen={onOpen} root={root} onChanged={onChanged} />
      ))}
      {entries.length === 0 && (
        <li className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
          {filtered ? (
            <Search aria-hidden="true" className="size-8" strokeWidth={1.5} />
          ) : (
            <FolderOpen aria-hidden="true" className="size-8" strokeWidth={1.5} />
          )}
          {filtered ? '没有匹配的文件' : '空目录'}
        </li>
      )}
    </ul>
  )
})

const DirectoryRow = memo(function DirectoryRow({
  entry,
  onOpen,
  root,
  onChanged,
}: {
  entry: FileEntry
  onOpen: (entry: FileEntry) => void
  root: string
  onChanged: () => void
}) {
  const directory = entry.type === 'directory'
  const Icon = directory
    ? Folder
    : isVideoFile(entry.path)
      ? FileVideo
      : isImageFile(entry.path)
        ? FileImage
        : /\.(?:md|txt|log|rst)$/i.test(entry.path)
          ? FileText
          : FileCode2
  return (
    <li className="flex items-center [content-visibility:auto] [contain-intrinsic-block-size:auto_49px]">
      <button
        type="button"
        onClick={() => onOpen(entry)}
        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left active:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      >
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-lg ${directory ? 'bg-primary/10 text-primary' : 'bg-card text-muted-foreground'}`}
        >
          <Icon aria-hidden="true" className="size-5" strokeWidth={1.6} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] text-foreground" title={entry.name}>
          {entry.name}
        </span>
        {directory ? (
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {entry.size === 0 ? '0 B' : formatBytes(entry.size)}
          </span>
        )}
      </button>
      {!directory && <FileActions mobile entry={entry} root={root} onChanged={onChanged} />}
    </li>
  )
})
