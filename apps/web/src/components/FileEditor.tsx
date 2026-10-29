import { useEffect, useRef } from 'react'

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

/**
 * A file's text, editable.
 *
 * A sibling of `FileBody` rather than a mode inside it: that component is a
 * *reader* — one div per line, a gutter, a rendered preview — and every one of
 * those is wrong for a textarea, which owns its own scrolling, has no per-line
 * elements to number, and must not be re-wrapped.
 *
 * There is no line-number gutter here on purpose. The one it could have would be
 * a second element that has to be scrolled in lockstep with this one and would
 * drift the moment the two disagree — and a textarea's `wrap="off"` means the
 * rows are not even the same heights the gutter would assume.
 */
export default function FileEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (text: string) => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Focused on entry, because the user tapped 编辑 and the next thing they want
  // is a keyboard. `preventScroll` because focusing an element below the fold
  // otherwise scrolls it into view by scrolling the page — on a phone that
  // shoves the header, and with it the 取消 button, off the top.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])

  return (
    <textarea
      ref={ref}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
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
      className="scroll-y scroll-x h-full w-full resize-none bg-transparent p-3 font-mono text-[13px] leading-[1.7] text-foreground outline-none"
    />
  )
}
