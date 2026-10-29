import { useEffect, useState } from 'react'
import type { FileContent } from '@vibemobile/protocol'
import { api, ApiError } from '../lib/api'
import { shortPath } from '../lib/format'
import type { FileRef } from '../lib/fileLink'
import FileBody, { SourcePreviewToggle, isRenderable } from './FileBody'

/**
 * What a file reference in a transcript opens into.
 *
 * A full-screen overlay rather than a route, for the same two reasons the turn
 * diff is one: the phone keeps its place in a long transcript, and the viewer
 * works for files from any workspace root — the file browser next door is
 * rooted at the app's default directory, so a link into another project would
 * open a browser with no way back.
 *
 * Only the chrome lives here; what the file looks like is `FileBody`, which
 * the file browser renders too.
 */
export default function FileViewer({
  file,
  onClose,
  onOpenFile,
}: {
  file: FileRef
  onClose: () => void
  /** Given, a link inside the preview opens here instead of on a new tab. */
  onOpenFile?: (ref: FileRef) => void
}) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState(false)
  // The mode is kept across files — reading a document in the rendered form
  // and then following a link to another one should not drop back to source —
  // so what is actually rendered is the mode *and* whether this file has a
  // rendered form at all.
  const shown = preview && isRenderable(file.path)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)
    api
      .fileContent(file.path)
      .then((res) => {
        if (!cancelled) setContent(res)
      })
      .catch((err) => {
        if (!cancelled) setError(describe(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [file.path])

  const name = file.path.split('/').pop() || file.path

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      <header className="safe-top shrink-0 border-b border-border">
        <div className="flex items-center gap-2 px-2 py-2">
          <button
            type="button"
            onClick={onClose}
            className="tap shrink-0 rounded-lg text-muted-foreground active:bg-white/5"
            aria-label="关闭"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="size-5"
            >
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[14px] font-medium text-foreground">{name}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{shortPath(file.path, 3)}</div>
          </div>
          {/* The line badge belongs to the source view: it says which line the
              link pointed at, and a rendered document has no lines to point
              at. Dropping it there also leaves the toggle room on a 390px
              header. */}
          {file.line !== null && !shown && (
            <span className="shrink-0 rounded-md bg-warning/15 px-2 py-1 text-[11px] text-warning">
              第 {file.line} 行
            </span>
          )}
          {isRenderable(file.path) && content && <SourcePreviewToggle preview={preview} onChange={setPreview} />}
        </div>
      </header>

      <div className="scroll-y min-h-0 flex-1">
        {loading ? (
          <div className="py-16 text-center text-sm text-muted-foreground/70">加载中…</div>
        ) : error ? (
          <div className="px-4 py-6 text-center">
            <div className="text-sm text-destructive">{error}</div>
            <div className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{file.path}</div>
          </div>
        ) : (
          content && (
            <FileBody content={content} path={file.path} line={file.line} preview={preview} onOpenFile={onOpenFile} />
          )
        )}
      </div>
    </div>
  )
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return '这个路径不在服务端允许访问的工作区里。'
    if (err.status === 404) return '打不开：文件不存在，或者它是一个目录。'
    if (err.status === 415) return '这是一个二进制文件，看不了。'
    return err.message
  }
  return (err as Error).message
}
