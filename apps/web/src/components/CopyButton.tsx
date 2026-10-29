import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

const DEFAULT_BUTTON =
  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/70 active:bg-secondary'

/**
 * Copy-to-clipboard icon button with a short-lived checkmark.
 *
 * `getText` rather than `text` so a caller that builds the string from the
 * transcript (the per-turn copy) does not rebuild it on every delta frame just
 * to pass it in. An empty result is a no-op, not a rejection.
 */
export default function CopyButton({
  getText,
  label,
  className = DEFAULT_BUTTON,
  iconClassName = 'size-3.5',
}: {
  getText: () => string
  label: string
  className?: string
  iconClassName?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  function copy() {
    const text = getText()
    if (!text) return
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 2_000)
      })
      .catch(() => undefined)
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? '已复制' : label}
      aria-label={copied ? '已复制' : label}
      className={className}
    >
      {copied ? (
        <Check aria-hidden="true" className={`${iconClassName} text-success`} strokeWidth={1.8} />
      ) : (
        <Copy aria-hidden="true" className={iconClassName} strokeWidth={1.7} />
      )}
    </button>
  )
}
