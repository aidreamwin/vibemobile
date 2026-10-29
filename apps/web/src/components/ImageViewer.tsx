import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * A picture in the transcript that opens full-screen on tap.
 *
 * Needed because the thumbnails are deliberately small — a screenshot of a
 * terminal is unreadable at 390px wide — and because there is no other way to
 * get at the original: the bytes live behind an authenticated route, so
 * long-pressing to "open image in new tab" is not something the PWA can offer.
 *
 * Note this takes a `src`, not an image-store token, because two different
 * image mechanisms end up here:
 *
 *  - the pictures a user attached, fetched from `/api/images/<token>`, and
 *  - the ones an agent produced, whose URL the provider sends inline on an
 *    `image` item.
 *
 * They are deliberately not unified. The agents' own URLs are theirs to shape
 * (`imageView` items are already data URLs by the time they reach here), while
 * the user's images are ours and are served from disk so a transcript reload
 * does not re-transfer them.
 */
export default function ImageViewer({ src, alt = '', className }: { src: string; alt?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)

  // A picture that cannot be fetched is dropped rather than shown as a broken
  // icon. The realistic causes are all uninteresting: the session expired, or
  // the cache directory was cleared. (With `no-store` on the 404, a cleared
  // image comes back on the next transcript load rather than staying broken.)
  if (broken) return null

  return (
    <>
      <button
        type="button"
        // Not a link: there is nowhere to navigate, and this keeps the whole
        // thumbnail a tap target.
        onClick={() => setOpen(true)}
        className="block w-fit max-w-full active:opacity-80"
        aria-label="查看大图"
      >
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError only hides a broken image; it is not an interaction */}
        <img src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} className={className} />
      </button>
      {open && <Overlay src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  )
}

function Overlay({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // The transcript behind is height-locked, so this is belt-and-braces — but
    // a full-screen overlay that lets the page scroll underneath on the one
    // browser that does scroll is a bug that only shows up on a phone.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  const stop = useCallback((event: React.MouseEvent) => event.stopPropagation(), [])

  // Portalled to the body rather than rendered in place. `position: fixed` is
  // positioned against the nearest ancestor with a transform/filter, and the
  // transcript is deep enough inside the tree that this is not worth betting
  // on; z-50 also puts it above the diff overlay (`z-40`) and the approval
  // sheets, whatever order they are in.
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse convenience; Escape closes the dialog
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the document listener above
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the dialog backdrop is intentionally clickable
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: this handler only stops backdrop propagation; Escape still closes */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: this handler only stops backdrop propagation */}
      <img src={src} alt={alt} onClick={stop} className="max-h-full max-w-full object-contain" />
      <button
        type="button"
        onClick={onClose}
        className="tap safe-top absolute right-1 top-1 rounded-lg text-white/80 hover:text-white"
        aria-label="关闭"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="size-6"
        >
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </button>
    </div>,
    document.body,
  )
}
