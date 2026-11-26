import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { highlightFileRows } from '../lib/fileSyntax'
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

export default function FileEditor({
  path,
  value,
  onChange,
  disabled = false,
  desktop = false,
  onSave,
}: {
  path: string
  value: string
  onChange: (text: string) => void
  disabled?: boolean
  desktop?: boolean
  onSave?: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLPreElement>(null)
  const [composing, setComposing] = useState(false)
  // Match the textarea's line endings without changing the draft sent to save.
  const rows = useMemo(() => value.split(/\r\n?|\n/), [value])
  const highlighted = useMemo(() => (composing ? null : highlightFileRows(path, rows)), [composing, path, rows])
  const lineNumbers = useMemo(
    () => Array.from({ length: rows.length }, (_, index) => index + 1).join('\n'),
    [rows.length],
  )

  function syncScroll(editor: HTMLTextAreaElement) {
    if (mirror.current) mirror.current.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`
    if (gutter.current) gutter.current.style.transform = `translateY(${-editor.scrollTop}px)`
  }

  useLayoutEffect(() => {
    if (ref.current) syncScroll(ref.current)
  }, [value, highlighted])

  // Focused on entry, because the user tapped 编辑 and the next thing they want
  // is a keyboard. `preventScroll` because focusing an element below the fold
  // otherwise scrolls it into view by scrolling the page — on a phone that
  // shoves the header, and with it the 取消 button, off the top.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div className="file-editor file-source" data-highlighted={Boolean(highlighted)}>
      <div className="file-editor-gutter" aria-hidden="true">
        <pre ref={gutter} className="file-editor-numbers">
          {lineNumbers}
        </pre>
      </div>
      <div className="file-editor-area">
        {highlighted && (
          <div className="file-editor-highlight" aria-hidden="true">
            <pre ref={mirror} className="file-editor-text">
              {highlighted.map((tokens, index) => {
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
