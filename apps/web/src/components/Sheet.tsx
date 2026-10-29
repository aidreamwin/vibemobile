import { Sheet as SheetRoot, SheetContent, SheetHeader, SheetTitle } from './ui/sheet'

/**
 * Bottom sheet — the mobile-native alternative to a centred dialog, since the
 * top of a phone screen is out of thumb reach.
 *
 * Thin adapter over shadcn's `sheet` (Radix Dialog). It keeps this app's
 * signature so the five call sites did not have to change, and adds what the
 * hand-rolled version was missing: a focus trap, background scroll lock,
 * Escape handling and a slide-in.
 *
 * Deliberately does not dismiss on backdrop tap when `dismissable` is false:
 * for destructive confirmations an accidental tap outside should not close it.
 * `open` is pinned true because the caller decides when this unmounts; a
 * non-dismissable sheet therefore has no route to closing at all, which is
 * exactly the intent.
 */
export default function Sheet({
  title,
  label,
  onClose,
  children,
  dismissable = true,
}: {
  title?: string
  /** Accessible name for a sheet that draws its own heading instead of using
   *  `title`; without it a screen reader hears the generic fallback. */
  label?: string
  onClose: () => void
  children: React.ReactNode
  dismissable?: boolean
}) {
  return (
    <SheetRoot
      open
      onOpenChange={(open) => {
        if (!open && dismissable) onClose()
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        /* SheetContent ships bg-background (oklch(0.145)), which is the *page*
           colour -- a panel in it reads as a hole rather than a layer. bg-card
           is the raised surface, matching what this sheet used before.
           gap-0 undoes the base's flex gap-4, which would add phantom space
           above the grab handle. */
        className="safe-bottom max-h-[88dvh] gap-0 overflow-hidden rounded-t-2xl border-t border-input bg-card shadow-2xl shadow-black/50"
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-input" aria-hidden="true" />
        <SheetHeader className="flex-row items-center gap-0 px-4 pt-2 pb-1">
          {/* Always present: a titleless dialog has no accessible name, and
              every sheet here would be titleless without this. */}
          <SheetTitle className={title ? 'flex-1 text-left text-base font-medium' : 'sr-only'}>
            {title ?? label ?? '操作面板'}
          </SheetTitle>
          {title && dismissable && (
            <button type="button" onClick={onClose} className="tap text-sm text-muted-foreground" aria-label="关闭">
              取消
            </button>
          )}
        </SheetHeader>
        {/* touch-pan-y keeps iOS from reading a horizontal drag in the sheet
            body as a back-navigation gesture. */}
        <div className="scroll-y max-h-[74dvh] touch-pan-y">{children}</div>
      </SheetContent>
    </SheetRoot>
  )
}
