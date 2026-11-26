import type { FileContent } from '@vibemobile/protocol'
import { Check, ChevronRight, Ellipsis, FileCode2, GitCompare, LoaderCircle, Pencil, RefreshCw, X } from 'lucide-react'
import { useMemo, useState, type Ref } from 'react'
import { formatBytes } from '../../lib/format'
import type { FileRef } from '../../lib/fileLink'
import { isPathInside } from '../../lib/workspace'
import CopyButton from '../CopyButton'
import { UnifiedDiff } from '../DiffView'
import FileBody, { isRenderable } from '../FileBody'
import FileEditor from '../FileEditor'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

export type FilePaneView = { kind: 'file'; path: string; name: string } | { kind: 'diff'; path: string | undefined }

const toolClass =
  'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-40'

function PathBreadcrumbs({ path, root, diff }: { path: string | undefined; root: string; diff: boolean }) {
  const fullPath = path || root
  const parts = fullPath.split(/[\\/]+/).filter(Boolean)
  if (path && root && isPathInside(path, root)) {
    const rootParts = root.split(/[\\/]+/).filter(Boolean)
    parts.splice(0, rootParts.length, rootParts.at(-1) || '/')
  }
  const current = parts.pop() || fullPath
  const parent = parts.length > 2 ? `${parts[0]} › … › ${parts.at(-1)}` : parts.join(' › ')
  const Icon = diff ? GitCompare : FileCode2

  return (
    <div className="flex min-w-0 flex-1 basis-24 items-center gap-1.5 text-xs" title={fullPath}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      {parent && (
        <>
          <span className="max-w-[45%] truncate text-muted-foreground">{parent}</span>
          <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        </>
      )}
      <span className="min-w-0 truncate font-medium text-foreground">{current || '工作区'}</span>
      {diff && <span className="shrink-0 text-muted-foreground">改动</span>}
    </div>
  )
}

interface DesktopFilePaneProps {
  view: FilePaneView
  root: string
  line?: number
  content: FileContent | null
  diff: string
  preview: boolean
  loading: boolean
  error: string | null
  scrollRef: Ref<HTMLDivElement>
  onScroll: () => void
  onPreview: (preview: boolean) => void
  onOpenFile?: (ref: FileRef) => void
  onOpenDiff?: (path: string) => void
  onRefresh: () => void
  onEdit: () => void
  editBlockedBy: string | null
  editor?: {
    value: string
    dirty: boolean
    saving: boolean
    error: string | null
    onChange: (text: string) => void
    onCancel: () => void
    onSave: () => void
  }
}

export default function DesktopFilePane({
  view,
  root,
  line,
  content,
  diff,
  preview,
  loading,
  error,
  scrollRef,
  onScroll,
  onPreview,
  onOpenFile,
  onOpenDiff,
  onRefresh,
  onEdit,
  editBlockedBy,
  editor,
}: DesktopFilePaneProps) {
  const [wrap, setWrap] = useState(false)
  const markdown = view.kind === 'file' && isRenderable(view.path)
  const rendered = markdown && preview
  const selection = editor?.value ?? content?.text
  const lineCount = useMemo(() => selection?.split('\n').length, [selection])
  const saveEnabled = editor && editor.dirty && !editor.saving

  return (
    <section
      className="flex h-full min-w-0 flex-col bg-background"
      aria-label={view.kind === 'file' ? '文件编辑器' : '文件改动'}
    >
      <header className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-card/60 px-2.5 py-0.5">
        <PathBreadcrumbs path={view.path} root={root} diff={view.kind === 'diff'} />
        {view.kind === 'file' &&
          (editor ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label="取消编辑"
                title="取消编辑"
                disabled={editor.saving}
                onClick={editor.onCancel}
                className={toolClass}
              >
                <X aria-hidden="true" className="size-4" />
              </button>
              <button
                type="button"
                aria-label="保存文件"
                aria-keyshortcuts="Control+S Meta+S"
                title="保存文件（Ctrl/⌘+S）"
                disabled={!saveEnabled}
                onClick={editor.onSave}
                className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              >
                <Check aria-hidden="true" className="size-3.5" /> 保存
              </button>
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-0.5">
              {markdown && (
                <fieldset className="mr-1 flex shrink-0 items-center rounded-md border border-border p-0.5">
                  <legend className="sr-only">显示方式</legend>
                  {([false, true] as const).map((showPreview) => (
                    <button
                      key={String(showPreview)}
                      type="button"
                      aria-pressed={preview === showPreview}
                      onClick={() => onPreview(showPreview)}
                      className="h-5 rounded-sm px-1.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-secondary aria-pressed:text-foreground"
                    >
                      {showPreview ? '预览' : '源码'}
                    </button>
                  ))}
                </fieldset>
              )}
              <button
                type="button"
                aria-label="编辑文件"
                title={editBlockedBy ?? '编辑文件'}
                disabled={!content || loading || Boolean(error) || Boolean(editBlockedBy)}
                onClick={onEdit}
                className={toolClass}
              >
                <Pencil aria-hidden="true" className="size-3.5" />
              </button>
              {onOpenDiff && (
                <button
                  type="button"
                  aria-label="查看文件改动"
                  title="查看文件改动"
                  onClick={() => onOpenDiff(view.path)}
                  className={toolClass}
                >
                  <GitCompare aria-hidden="true" className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        {!editor && (
          <div className="flex shrink-0 items-center gap-0.5">
            {(view.path || root) && (
              <CopyButton getText={() => view.path || root} label="复制路径" className={toolClass} />
            )}
            {view.kind === 'file' && !rendered ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="更多文件操作" title="更多文件操作" className={toolClass}>
                    <Ellipsis aria-hidden="true" className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="desktop-workbench text-foreground">
                  <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap} className="text-xs">
                    自动换行
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuItem onSelect={onRefresh} disabled={loading} className="text-xs">
                    <RefreshCw aria-hidden="true" className="size-3.5" /> 刷新文件
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <button
                type="button"
                aria-label="刷新"
                title="刷新"
                disabled={loading}
                onClick={onRefresh}
                className={toolClass}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </header>

      {editor?.error && (
        <p
          role="alert"
          className="shrink-0 border-b border-destructive/35 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          {editor.error}
        </p>
      )}
      {!editor && !error && editBlockedBy && (
        <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">{editBlockedBy}</p>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
        {loading ? (
          <div role="status" className="grid h-full place-content-center text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              正在读取…
            </span>
          </div>
        ) : error ? (
          <div className="grid min-h-full place-content-center justify-items-center gap-2 px-6 text-center text-xs">
            <p role="alert" className="max-w-md break-words text-muted-foreground">
              {error}
            </p>
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-md border border-border px-2.5 py-1 text-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
            >
              重试
            </button>
          </div>
        ) : view.kind === 'diff' ? (
          diff.trim() ? (
            <UnifiedDiff diff={diff} desktop />
          ) : (
            <p className="grid h-full place-content-center text-xs text-muted-foreground">没有文件改动</p>
          )
        ) : (
          content &&
          (editor ? (
            <FileEditor
              desktop
              path={view.path}
              value={editor.value}
              disabled={editor.saving}
              onChange={editor.onChange}
              onSave={editor.onSave}
            />
          ) : (
            <FileBody
              desktop
              wrap={wrap}
              content={content}
              path={view.path}
              line={line}
              preview={preview}
              onOpenFile={onOpenFile}
            />
          ))
        )}
      </div>

      {view.kind === 'file' && content && !loading && !error && (
        <footer className="flex h-6 shrink-0 items-center justify-end gap-3 border-t border-border bg-card/60 px-3 text-[11px] tabular-nums text-muted-foreground">
          {editor && (
            <span className="mr-auto truncate" role="status">
              {editor.saving ? '正在保存…' : editor.dirty ? '未保存' : '无修改'}
            </span>
          )}
          {line && !rendered && !editor && <span>第 {line} 行</span>}
          <span>{lineCount} 行</span>
          {!editor && <span>{formatBytes(content.bytes)}</span>}
        </footer>
      )}
    </section>
  )
}
