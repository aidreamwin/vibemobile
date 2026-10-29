import { FolderOpen, X, Check, Eye, Code, Ellipsis, Pencil, GitBranch, RefreshCw } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import ToolbarRow, { ToolbarIdentity } from '../components/ToolbarRow'
import RunnerSelector from '../components/RunnerSelector'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileContent, FileEntry } from '@vibemobile/protocol'
import { api, ApiError } from '../lib/api'
import { formatBytes, shortPath } from '../lib/format'
import { isPathInside, parentPath, useWorkspaceStore } from '../lib/workspace'
import { UnifiedDiff } from '../components/DiffView'
import FileBody, { isRenderable } from '../components/FileBody'
import FileEditor, { MAX_EDIT_LINES } from '../components/FileEditor'

type View =
  | { kind: 'list'; path: string }
  | { kind: 'file'; path: string; name: string }
  /** `path` is absent for the whole-workspace diff. */
  | { kind: 'diff'; path: string | undefined }

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
let lastDraft: { path: string; text: string } | null = null

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

export default function Files() {
  const defaultCwd = useWorkspaceStore((state) => state.defaultCwd)
  const workspaceLoaded = useWorkspaceStore((state) => state.loaded)
  // Picked up from the last visit to this page, if there was one — which is the
  // whole point: the root of the workspace is the fallback, not the default.
  const [view, setView] = useState<View>(() => lastView ?? { kind: 'list', path: '' })

  const [entries, setEntries] = useState<FileEntry[]>([])
  const [content, setContent] = useState<FileContent | null>(null)
  const [diff, setDiff] = useState('')
  const [preview, setPreview] = useState(false)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Bumped by 刷新, so re-reading the same view is one more fetch. */
  const [reload, setReload] = useState(0)

  // Editing state lives here rather than inside `FileEditor`, because three
  // things outside it need to know: the header (which buttons to draw), the
  // scroll memory (below), and the unmount cleanup that parks a dirty draft.
  const [editing, setEditing] = useState(
    () => Boolean(lastDraft) && lastView?.kind === 'file' && lastView.path === lastDraft!.path,
  )
  const [draft, setDraft] = useState(() =>
    lastDraft && lastView?.kind === 'file' && lastView.path === lastDraft.path ? lastDraft.text : '',
  )
  const [saving, setSaving] = useState(false)
  /**
   * Kept apart from `error` on purpose. `error` is the page-level fetch banner,
   * and a failed SAVE landing there would also satisfy `firstLoad`'s fallback
   * logic and bounce the user back to the directory listing — losing the draft
   * that just failed to save, which is the one thing that must not happen.
   */
  const [saveError, setSaveError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  /** True until this mount's first fetch has answered — see the fallback below. */
  const firstLoad = useRef(true)

  const key = viewKey(view)

  useEffect(() => {
    lastView = view
  }, [view])

  const dirty = editing && content !== null && draft !== content.text

  /** Files the editor will not open, with the reason to show instead of a button. */
  const editBlockedBy = useMemo(() => {
    if (!content) return null
    if (content.truncated) return '文件太大，无法在手机上编辑'
    if (content.text.split('\n').length > MAX_EDIT_LINES) return `超过 ${MAX_EDIT_LINES} 行，请在电脑上编辑`
    return null
  }, [content])

  // Parked on the way out, restored by the initial state above. `dirty` is what
  // decides whether there is anything to park: leaving a clean file must not
  // leave a draft behind that would reopen the editor for a file the user only
  // read.
  useEffect(() => {
    return () => {
      if (!dirty) {
        lastDraft = null
        return
      }
      const path = view.kind === 'file' ? view.path : null
      lastDraft = path ? { path, text: draft } : null
    }
  }, [dirty, draft, view])

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

  function go(next: View) {
    // `loading` moves in the same tick as the view on purpose: the fetch below
    // only starts after the render that shows the new screen, and without this
    // that render would carry the *previous* screen's rows or file body.
    setLoading(true)
    setError(null)
    setView(next)
  }

  function beginEdit() {
    if (!content) return
    setSaveError(null)
    setDraft(content.text)
    setEditing(true)
  }

  function cancelEdit() {
    setSaveError(null)
    setDraft(content?.text ?? '')
    setEditing(false)
  }

  async function save() {
    if (!content || view.kind !== 'file') return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await api.saveFile(view.path, draft, content.rev)
      // The server's copy is authoritative and is not byte-identical to what was
      // sent — it restored the file's line endings — so the draft is rebased on
      // it rather than kept as typed.
      setContent(saved)
      setDraft(saved.text)
      lastDraft = null
      setEditing(false)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone else wrote the file while this draft was open. Re-reading is
        // the only correct move; the draft is deliberately left alone, because
        // the user's edit is the one thing the app cannot reconstruct, and
        // discarding it to match the disk would be choosing the agent's work
        // over theirs without asking.
        const fresh = await api.fileContent(view.path).catch(() => null)
        if (fresh) setContent(fresh)
        setSaveError('文件在磁盘上已被改动。你的草稿还在，再点一次保存会覆盖磁盘上的版本。')
      } else {
        setSaveError((err as Error).message)
      }
    } finally {
      setSaving(false)
    }
  }

  // The root arrives asynchronously, and a remembered path only means anything
  // inside it. Changing the app-wide default in 设置 lands here too, and it is
  // deliberately still a reset to the root: that is a different workspace, not
  // a return to this one.
  useEffect(() => {
    if (!defaultCwd) {
      if (workspaceLoaded) setLoading(false)
      return
    }
    if (inWorkspace(view, defaultCwd)) return
    setContent(null)
    go({ kind: 'list', path: defaultCwd })
  }, [defaultCwd, workspaceLoaded, view])

  // One fetcher, keyed on the view itself, so entering a directory, opening a
  // file and landing back on a remembered one are all the same path through
  // here — and 刷新 is just one more turn of `reload`.
  useEffect(() => {
    if (view.kind === 'list' && !view.path) return
    if (view.kind === 'diff' && !defaultCwd) return

    let cancelled = false
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        if (view.kind === 'list') {
          const res = await api.files(view.path)
          if (!cancelled) setEntries(res.data)
        } else if (view.kind === 'file') {
          const res = await api.fileContent(view.path)
          if (!cancelled) setContent(res)
        } else {
          const res = await api.fileDiff(defaultCwd, view.path)
          if (!cancelled) setDiff(res.diff)
        }
      } catch (err) {
        if (cancelled) return
        setError((err as Error).message)
        // What this mount opened on can outlive itself: the agent renames and
        // deletes files while this page sits in another tab. An empty pane
        // under a red banner is a dead end nobody asked for, so only the first
        // load of a mount falls back — after that the error is the answer to
        // something the user just did, and hiding it would be the wrong move.
        if (firstLoad.current) go({ kind: 'list', path: defaultCwd || '' })
      } finally {
        firstLoad.current = false
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [view, defaultCwd, reload])

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
    if (!el || loading || editing) return
    offsets.set(key, el.scrollTop)
  }, [key, loading, editing])

  // Laid out, not painted: restoring in a plain effect shows the top of the
  // page for one frame first.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || loading) return
    // Absent means "never seen" — a directory opened for the first time starts
    // at the top, which is what `0` here does.
    el.scrollTop = offsets.get(key) ?? 0
    // `editing` is a dependency so that leaving the editor puts the reader back
    // where they were, rather than at the top the clamp left behind.
  }, [key, loading, editing])

  const backDirectory = view.kind === 'list' ? parentPath(view.path) : view.path ? parentPath(view.path) : defaultCwd
  const canGoBack = view.kind !== 'list' || (view.path !== defaultCwd && isPathInside(backDirectory, defaultCwd))

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="safe-top shrink-0 border-b border-border bg-background/95 backdrop-blur-xl">
        <ToolbarRow>
          {/* While editing, the entire button cluster is replaced by 取消/保存.
              That is the hard guarantee that a draft cannot be lost by a stray
              tap: the back button, the diff, the refresh and the source/preview
              switch are all gone, so the only two ways out are the two buttons
              that know about the draft. */}
          {view.kind === 'file' && editing ? (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold text-foreground">{view.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {saving ? '保存中…' : dirty ? '已修改，尚未保存' : '没有改动'}
                </div>
              </div>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className="tap shrink-0 rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground disabled:opacity-40"
                aria-label="取消编辑"
                title="取消编辑"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
              <button
                type="button"
                onClick={() => void save()}
                // Disabled when there is nothing to save as well as while a save
                // is in flight: the second tap of an impatient double-tap would
                // otherwise go out with the same `rev` and come back a 409.
                disabled={saving || !dirty}
                className="tap shrink-0 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground disabled:opacity-40"
                aria-label="保存文件"
                title="保存文件"
              >
                <Check aria-hidden="true" className="size-5" />
              </button>
            </>
          ) : (
            <>
              {!canGoBack && <ToolbarIdentity icon={FolderOpen} label="文件" />}
              {canGoBack && <h1 className="sr-only">文件</h1>}
              <RunnerSelector compact />
              {canGoBack ? (
                <button
                  type="button"
                  onClick={() => {
                    go({ kind: 'list', path: backDirectory })
                  }}
                  className="tap shrink-0 rounded-xl text-muted-foreground active:bg-white/5"
                  aria-label="上一级"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-5 w-5"
                  >
                    <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : null}

              <div className="min-w-0 flex-1" title={view.path}>
                {view.kind === 'list' ? (
                  <div className="truncate font-mono text-[13px] font-medium text-foreground">
                    {view.path === defaultCwd ? (
                      <span className="text-muted-foreground">{shortPath(defaultCwd, 1)}</span>
                    ) : (
                      shortPath(view.path, 1)
                    )}
                  </div>
                ) : (
                  <div className="truncate text-[15px] font-semibold text-foreground">
                    {view.kind === 'file' ? view.name : '工作区改动'}
                  </div>
                )}
              </div>

              {view.kind === 'file' ? (
                <>
                  {content && isRenderable(view.path) && (
                    <button
                      type="button"
                      onClick={() => setPreview(!preview)}
                      aria-label={preview ? '查看源码' : '预览文件'}
                      title={preview ? '查看源码' : '预览文件'}
                      aria-pressed={preview}
                      className={`tap shrink-0 rounded-xl ${preview ? 'bg-secondary text-foreground' : 'text-muted-foreground'} active:bg-secondary`}
                    >
                      {preview ? (
                        <Code aria-hidden="true" className="size-5" />
                      ) : (
                        <Eye aria-hidden="true" className="size-5" />
                      )}
                    </button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="文件操作"
                        title="文件操作"
                        className="tap shrink-0 rounded-xl text-muted-foreground active:bg-secondary"
                      >
                        <Ellipsis aria-hidden="true" className="size-5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-40 rounded-xl border-border p-1 shadow-xl">
                      {content && !editBlockedBy && (
                        <DropdownMenuItem onSelect={beginEdit} className="min-h-11 rounded-lg">
                          <Pencil />
                          编辑文件
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onSelect={() => go({ kind: 'diff', path: view.path })}
                        className="min-h-11 rounded-lg"
                      >
                        <GitBranch />
                        查看改动
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setReload((n) => n + 1)} className="min-h-11 rounded-lg">
                        <RefreshCw />
                        刷新
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : (
                <>
                  {view.kind !== 'diff' && (
                    <button
                      type="button"
                      onClick={() => go({ kind: 'diff', path: undefined })}
                      className="tap shrink-0 rounded-xl text-muted-foreground active:bg-white/5"
                      aria-label="查看改动"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        className="h-5 w-5"
                      >
                        <path
                          d="M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9v3a6 6 0 01-6 6H9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setReload((n) => n + 1)}
                    className="tap shrink-0 rounded-xl text-muted-foreground active:bg-white/5"
                    aria-label="刷新"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className="h-5 w-5"
                    >
                      <path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </>
              )}
            </>
          )}
        </ToolbarRow>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="scroll-y min-h-0 flex-1">
        {error && (
          <div className="border-b border-destructive/50 bg-destructive/15 px-4 py-2 text-[12px] text-destructive">
            {error}
          </div>
        )}

        {/* A save failure is not a destination: it is a line about the draft
            below it, so it sits above the editor and never replaces it. */}
        {saveError && (
          <div className="border-b border-destructive/50 bg-destructive/15 px-4 py-2 text-[12px] text-destructive">
            {saveError}
          </div>
        )}

        {/* Why there is no 编辑 button. Said here rather than as a disabled
            button in the header, because a greyed-out pencil on a phone explains
            nothing and this is the only place with room for a sentence. */}
        {view.kind === 'file' && !editing && editBlockedBy && (
          <div className="border-b border-border bg-card px-4 py-1.5 text-[11px] text-muted-foreground">
            {editBlockedBy}
          </div>
        )}

        {loading ? (
          <div className="py-16 text-center text-sm text-muted-foreground/70">加载中…</div>
        ) : view.kind === 'list' ? (
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() =>
                    entry.type === 'directory'
                      ? go({ kind: 'list', path: entry.path })
                      : go({ kind: 'file', path: entry.path, name: entry.name })
                  }
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-card"
                >
                  <span className={entry.type === 'directory' ? 'text-primary' : 'text-muted-foreground/70'}>
                    {entry.type === 'directory' ? (
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                        <path d="M3 7a2 2 0 012-2h3.6l2 2H19a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                      </svg>
                    ) : (
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        className="h-5 w-5"
                      >
                        <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" strokeLinejoin="round" />
                        <path d="M14 3v5h5" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-foreground/90">{entry.name}</span>
                  {entry.type === 'file' && (
                    <span className="shrink-0 text-[11px] text-muted-foreground/70">{formatBytes(entry.size)}</span>
                  )}
                </button>
              </li>
            ))}
            {entries.length === 0 && <li className="py-16 text-center text-sm text-muted-foreground/70">空目录</li>}
          </ul>
        ) : view.kind === 'file' ? (
          content &&
          (editing ? (
            // `h-full` because the textarea owns its own scrolling: the outer
            // container has to hand it a definite height, not grow to fit it.
            <div className="h-full">
              <FileEditor value={draft} onChange={setDraft} disabled={saving} />
            </div>
          ) : (
            <FileBody content={content} path={view.path} preview={preview} />
          ))
        ) : (
          <UnifiedDiff diff={diff} />
        )}
      </div>
    </div>
  )
}
