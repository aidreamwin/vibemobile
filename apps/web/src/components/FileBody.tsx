import { useEffect, useMemo, useRef } from 'react'
import type { FileContent } from '@vibemobile/protocol'
import { formatBytes } from '../lib/format'
import type { FileRef } from '../lib/fileLink'
import Markdown from './Markdown'

/**
 * How many lines a file is rendered as. Not a reading limit — a rendering one:
 * one row per line is what the gutter and the wrapping cost, and past a few
 * thousand rows the phone spends more time building them than the reader
 * spends on the file. The server's 512 KB read cap sits above this.
 */
const MAX_ROWS = 5000

/** Documents that can also be shown rendered instead of as source. */
const MARKDOWN = /\.(md|markdown)$/i

/** Whether a file has a rendered form to switch to. */
export function isRenderable(path: string): boolean {
  return MARKDOWN.test(path)
}

/**
 * The source/rendered switch, shared so both places that show a file label it
 * the same way, and neither has to know what "rendered" means for a file type.
 */
export function SourcePreviewToggle({ preview, onChange }: { preview: boolean; onChange: (preview: boolean) => void }) {
  return (
    <div className="flex shrink-0 items-center rounded-lg bg-secondary p-0.5">
      {([false, true] as const).map((mode) => (
        <button
          key={String(mode)}
          type="button"
          onClick={() => onChange(mode)}
          className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
            mode === preview ? 'bg-raised text-foreground' : 'text-muted-foreground'
          }`}
        >
          {mode ? '预览' : '源码'}
        </button>
      ))}
    </div>
  )
}

/**
 * The text of a file, as source or rendered.
 *
 * Shared by the two places that show one — the overlay a transcript link opens
 * and the file browser — because they are the same job, and the second copy
 * had already drifted: it was still 11px with a horizontal scrollbar and no
 * line numbers.
 *
 * `line` is the line a link pointed at: that row is marked and scrolled to.
 * It applies to the source view only; a rendered document has no lines.
 */
export default function FileBody({
  content,
  path,
  line = null,
  preview = false,
  onOpenFile,
}: {
  content: FileContent
  path: string
  line?: number | null
  preview?: boolean
  /** Given, a link inside the preview opens in the app instead of a new tab. */
  onOpenFile?: (ref: FileRef) => void
}) {
  const shown = preview && isRenderable(path)

  // `\r?\n`, not `\n`: these are Windows files, and a lone `\r` left at the end
  // of every row is an invisible character that survives a copy — or, under
  // `pre-wrap`, a second break that would double every row's height.
  const lines = useMemo(() => content.text.split(/\r?\n/), [content])
  const rows = lines.length > MAX_ROWS ? lines.slice(0, MAX_ROWS) : lines

  // Links inside a document are relative to the document, not to the session's
  // working directory — the two are the same only for a link in a transcript.
  const folder = useMemo(() => {
    const cut = path.lastIndexOf('/')
    return cut > 0 ? path.slice(0, cut) : ''
  }, [path])

  const targetRef = useRef<HTMLDivElement>(null)

  // Depends on `content` because the target row does not exist until the text
  // does; `line` alone would scroll a row that is not on screen yet.
  useEffect(() => {
    if (!shown) targetRef.current?.scrollIntoView({ block: 'center' })
  }, [content, line, shown])

  return (
    <>
      {content.truncated && (
        <div className="bg-warning/15 px-4 py-1.5 text-[11px] text-warning">
          文件较大，仅显示前 {Math.round(content.text.length / 1024)} KB（共 {formatBytes(content.bytes)}）
        </div>
      )}
      {shown ? (
        /* The same renderer the transcript uses, so a document looks the same
           whether the agent wrote it or wrote a link to it. */
        <div className="px-4 py-3">
          <Markdown text={content.text} cwd={folder} onOpenFile={onOpenFile} />
        </div>
      ) : (
        /* Wrapped, not horizontally scrolled: a phone cannot show a 200
           character line anyway, and side-scrolling a long line is worse than
           reading it in three. The gutter is `select-none` so copying the file
           out does not drag the numbers along, and an empty line gets a space
           to keep its row height. */
        <div className="py-2 font-mono text-[13px] leading-[1.7] text-foreground/90">
          {rows.map((text, index) => {
            const number = index + 1
            const target = number === line
            return (
              <div key={number} ref={target ? targetRef : undefined} className={target ? 'flex bg-warning/20' : 'flex'}>
                <span className="w-11 shrink-0 select-none pr-2.5 text-right text-muted-foreground/50">{number}</span>
                <span className="min-w-0 flex-1 wrap-break-word whitespace-pre-wrap pr-3">{text || ' '}</span>
              </div>
            )
          })}
          {rows.length < lines.length && (
            <div className="px-4 py-2 text-[12px] text-warning">
              文件较长，仅显示前 {MAX_ROWS} 行（共 {lines.length} 行）
            </div>
          )}
        </div>
      )}
    </>
  )
}
