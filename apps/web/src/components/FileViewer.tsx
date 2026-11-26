import { useEffect, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { FileWarning, LoaderCircle, X } from 'lucide-react'
import type { FileContent } from '@vibemobile/protocol'
import { shortPath } from '../lib/format'
import type { FileRef } from '../lib/fileLink'
import FileBody, { SourcePreviewToggle, isRenderable } from './FileBody'
import ImageFilePreview from './ImageFilePreview'
import { isRasterImage } from '../lib/fileImage'
import { fileReadError } from '../lib/fileErrors'
import { getFileSnapshot, readFileSnapshot } from '../lib/fileSnapshots'

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
  const rasterImage = isRasterImage(file.path)
  const [loaded, setLoaded] = useState<{ path: string; content: FileContent } | null>(() => {
    const cached = rasterImage ? null : getFileSnapshot(file.path)
    return cached ? { path: file.path, content: cached } : null
  })
  const content = loaded?.path === file.path ? loaded.content : null
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!content)
  const [reload, setReload] = useState(0)
  const lastReload = useRef(0)
  const previousFocus = useRef(document.activeElement)
  // Markdown opens rendered: a `.md` link is usually opened to be read, and
  // the switch is one tap away for the source. Non-documents ignore it.
  const [preview, setPreview] = useState(true)
  // The mode is kept across files — reading a document in the rendered form
  // and then following a link to another one should not drop back to source —
  // so what is actually rendered is the mode *and* whether this file has a
  // rendered form at all.
  const shown = preview && isRenderable(file.path)

  useEffect(() => {
    if (rasterImage) {
      setLoading(false)
      setError(null)
      setLoaded(null)
      return
    }
    let cancelled = false
    const cached = getFileSnapshot(file.path)
    const force = reload !== lastReload.current
    lastReload.current = reload
    setLoading(!cached)
    setError(null)
    setLoaded(cached ? { path: file.path, content: cached } : null)
    readFileSnapshot(file.path, force)
      .then((res) => {
        if (!cancelled) setLoaded({ path: file.path, content: res })
      })
      .catch((err) => {
        if (!cancelled) setError(fileReadError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [file.path, rasterImage, reload])

  const name = file.path.split(/[\\/]/).at(-1) || file.path

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Content
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          const trigger = previousFocus.current
          if (trigger instanceof HTMLElement && trigger.isConnected) {
            event.preventDefault()
            trigger.focus({ preventScroll: true })
          }
        }}
        className="fixed inset-0 z-40 flex flex-col bg-background pb-[env(safe-area-inset-bottom)]"
      >
        <header className="safe-top shrink-0 border-b border-border">
          <div className="flex items-center gap-2 px-2 py-2">
            <Dialog.Close className="tap shrink-0 rounded-lg text-muted-foreground active:bg-white/5" aria-label="关闭">
              <X aria-hidden="true" className="size-5" />
            </Dialog.Close>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-[15px] font-semibold text-foreground">{name}</Dialog.Title>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{shortPath(file.path, 3)}</div>
            </div>
            {/* The line badge belongs to the source view: it says which line the
              link pointed at, and a rendered document has no lines to point
              at. Dropping it there also leaves the toggle room on a 390px
              header. */}
            {file.line !== null && !shown && !rasterImage && (
              <span className="shrink-0 rounded-md bg-warning/15 px-2 py-1 text-[11px] text-warning">
                第 {file.line} 行
              </span>
            )}
            {isRenderable(file.path) && content && <SourcePreviewToggle preview={preview} onChange={setPreview} />}
          </div>
        </header>

        <div className="scroll-y min-h-0 flex-1">
          {rasterImage ? (
            <ImageFilePreview key={file.path} path={file.path} />
          ) : loading || (!error && !content) ? (
            <div role="status" className="grid min-h-full place-content-center text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                正在读取…
              </span>
            </div>
          ) : error ? (
            <div className="grid min-h-full place-content-center justify-items-center gap-3 px-8 text-center">
              <FileWarning aria-hidden="true" className="size-9 text-muted-foreground" strokeWidth={1.4} />
              <p role="alert" className="text-sm text-muted-foreground">
                {error}
              </p>
              <button
                type="button"
                onClick={() => setReload((previous) => previous + 1)}
                className="min-h-11 rounded-xl border border-border px-5 text-sm text-foreground active:bg-secondary"
              >
                重试
              </button>
            </div>
          ) : (
            content && (
              <FileBody content={content} path={file.path} line={file.line} preview={preview} onOpenFile={onOpenFile} />
            )
          )}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}
