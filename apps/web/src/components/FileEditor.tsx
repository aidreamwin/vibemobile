import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SourceToken } from '../lib/fileSyntax'
import './file-source.css'
import './file-editor.css'

/**
 * Above this many lines, editing is not offered.
 *
 * Not a reading limit like `FileBody`'s `MAX_ROWS` — this one is about the
 * draft: the textarea holds the whole file in one React state string, every
 * keystroke re-renders it, and on a phone that turns typing into a slideshow
 * long before the server's 512 KB ceiling is in sight. Refusing the entry point
 * is the honest version of that: a file this long is one to read on a phone and
 * edit on a laptop.
 */
export const MAX_EDIT_LINES = 20_000

interface EditorViewport {
  start: number
  end: number
  lineHeight: number
}

interface HighlightResult {
  path: string
  value: string
  rows: SourceToken[][] | null
}

export default function FileEditor({
  path,
  value,
  onChange,
  disabled = false,
  desktop = false,
  visible = true,
  onSave,
}: {
  path: string
  value: string
  onChange: (text: string) => void
  disabled?: boolean
  desktop?: boolean
  visible?: boolean
  onSave?: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLPreElement>(null)
  const highlighter = useRef<Worker | null>(null)
  const sequence = useRef(0)
  const [composing, setComposing] = useState(false)
  const [result, setResult] = useState<HighlightResult | null>(null)
  const [viewport, setViewport] = useState<EditorViewport>({ start: 0, end: 48, lineHeight: 0 })
  // Match the textarea's line endings without changing the draft sent to save.
  const rows = useMemo(() => value.split(/\r\n?|\n/), [value])
  const highlighted = !composing && result?.path === path && result.value === value ? result.rows : null
  const visibleTokens = useMemo(
    () => highlighted?.slice(viewport.start, viewport.end),
    [highlighted, viewport.start, viewport.end],
  )
  const lineNumbers = useMemo(
    () => Array.from({ length: rows.length }, (_, index) => index + 1).join('\n'),
    [rows.length],
  )

  const syncScroll = useCallback(
    (editor: HTMLTextAreaElement) => {
      if (!editor.clientHeight) return
      if (mirror.current) mirror.current.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`
      const numbers = gutter.current
      if (!numbers) return
      numbers.style.transform = `translateY(${-editor.scrollTop}px)`
      // The browser rounds each line box to layout units. Measuring the gutter
      // avoids accumulating subpixel drift thousands of rows into the file.
      const { paddingTop, paddingBottom } = getComputedStyle(numbers)
      const lineHeight =
        (numbers.getBoundingClientRect().height - parseFloat(paddingTop) - parseFloat(paddingBottom)) / rows.length
      if (lineHeight <= 0) return
      const start = Math.max(0, Math.floor(editor.scrollTop / lineHeight) - 8)
      const end = Math.ceil((editor.scrollTop + editor.clientHeight) / lineHeight) + 8
      setViewport((previous) =>
        previous.start === start && previous.end === end && previous.lineHeight === lineHeight
          ? previous
          : { start, end, lineHeight },
      )
    },
    [rows.length],
  )

  useLayoutEffect(() => {
    if (visible && ref.current && (!highlighted || mirror.current)) syncScroll(ref.current)
  }, [highlighted, syncScroll, visible])

  useEffect(() => {
    const editor = ref.current
    if (!editor) return
    const observer = new ResizeObserver(() => syncScroll(editor))
    observer.observe(editor)
    return () => observer.disconnect()
  }, [syncScroll])

  useEffect(() => {
    try {
      const worker = new Worker(new URL('../lib/fileEditorSyntax.worker.ts', import.meta.url), { type: 'module' })
      highlighter.current = worker
      return () => {
        highlighter.current = null
        worker.terminate()
      }
    } catch {
      // A restricted browser can still use the native editor with plain text.
    }
  }, [])

  useEffect(() => {
    const worker = highlighter.current
    if (!worker || composing) return
    const id = ++sequence.current
    function receive(event: MessageEvent<{ id: number; rows: SourceToken[][] | null }>) {
      if (event.data.id === id) setResult({ path, value, rows: event.data.rows })
    }
    worker.addEventListener('message', receive)
    // Wait for a brief typing pause so old drafts do not queue up in the worker.
    const timer = window.setTimeout(() => worker.postMessage({ id, path, text: value }), 48)
    return () => {
      window.clearTimeout(timer)
      worker.removeEventListener('message', receive)
    }
  }, [path, value, composing])

  // Focused on entry, because the user tapped 编辑 and the next thing they want
  // is a keyboard. `preventScroll` because focusing an element below the fold
  // otherwise scrolls it into view by scrolling the page — on a phone that
  // shoves the header, and with it the 取消 button, off the top.
  useEffect(() => {
    const editor = ref.current
    if (editor?.clientHeight) editor.focus({ preventScroll: true })
  }, [])

  return (
    <div className="file-editor file-source" data-highlighted={Boolean(highlighted)}>
      <div className="file-editor-gutter" aria-hidden="true">
        <pre ref={gutter} className="file-editor-numbers">
          {lineNumbers}
        </pre>
      </div>
      <div className="file-editor-area">
        {visibleTokens && (
          <div className="file-editor-highlight" aria-hidden="true">
            <pre ref={mirror} className="file-editor-text" style={{ marginTop: viewport.start * viewport.lineHeight }}>
              {visibleTokens.map((tokens, index) => {
                const offset = tokens[0]?.offset
                return (
                  <Fragment key={index === 0 ? 'first' : (offset ?? `empty-${index}`)}>
                    {index > 0 && '\n'}
                    {tokens.map((token) =>
                      token.className ? (
                        <span className={token.className} key={token.offset}>
                          {token.text}
                        </span>
                      ) : (
                        token.text
                      ),
                    )}
                  </Fragment>
                )
              })}
              {'\u200b'}
            </pre>
          </div>
        )}
        <textarea
          ref={ref}
          value={value}
          aria-label="文件内容"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => syncScroll(event.currentTarget)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={
            onSave
              ? (event) => {
                  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
                  event.preventDefault()
                  onSave()
                }
              : undefined
          }
          // Every one of these is aimed at a phone keyboard: autocapitalization
          // rewrites `useState` to `UseState`, autocorrect "fixes" identifiers, and
          // spellcheck paints red under every symbol.
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          // `off`, not wrapping: a wrapped code line is a line whose indentation no
          // longer tells you anything, and this is the one view where the reader is
          // also the writer.
          wrap="off"
          className={`file-editor-text file-editor-input scroll-y scroll-x ${desktop ? 'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50' : ''}`}
        />
      </div>
    </div>
  )
}
