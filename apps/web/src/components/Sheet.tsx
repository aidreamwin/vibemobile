import { createContext, useContext, useRef, type ReactNode } from 'react'
import { Dialog } from 'radix-ui'
import { Sheet as SheetRoot, SheetContent, SheetHeader, SheetTitle } from './ui/sheet'

const SheetPresentationContext = createContext<{ centered: boolean; container?: HTMLElement | null }>({
  centered: false,
})

export function SheetPresentation({
  centered,
  container,
  children,
}: {
  centered: boolean
  container?: HTMLElement | null
  children: ReactNode
}) {
  const inherited = useContext(SheetPresentationContext)
  return (
    <SheetPresentationContext.Provider
      value={{ centered, container: container === undefined ? inherited.container : container }}
    >
      {children}
    </SheetPresentationContext.Provider>
  )
}

interface SheetProps {
  title?: string
  label?: string
  closeLabel?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  dismissable?: boolean
  className?: string
}

function CenteredSheet({
  title,
  label,
  closeLabel = '取消',
  onClose,
  children,
  footer,
  dismissable = true,
}: SheetProps) {
  const { container } = useContext(SheetPresentationContext)
  const previousFocus = useRef(typeof document === 'undefined' ? null : document.activeElement)

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && dismissable) onClose()
      }}
    >
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(80dvh,48rem)] w-[calc(100%-3rem)] max-w-xl -translate-1/2 flex-col overflow-hidden rounded-xl border border-input bg-popover text-popover-foreground shadow-2xl"
          onCloseAutoFocus={(event) => {
            const trigger = previousFocus.current
            if (trigger instanceof HTMLElement && trigger.isConnected) {
              event.preventDefault()
              trigger.focus({ preventScroll: true })
            }
          }}
          onEscapeKeyDown={(event) => {
            if (!dismissable) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (!dismissable) event.preventDefault()
          }}
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
            <Dialog.Title className={title ? 'flex-1 truncate text-sm font-semibold' : 'sr-only'}>
              {title ?? label ?? '操作面板'}
            </Dialog.Title>
            {title && dismissable && (
              <Dialog.Close
                className="ml-auto inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-label="关闭"
              >
                {closeLabel}
              </Dialog.Close>
            )}
          </div>
          <div className="scroll-y min-h-0 pt-2 [&_.tap]:min-h-8 [&_.tap]:min-w-8 [&_.tap]:py-1.5">{children}</div>
          {footer && <div className="shrink-0 border-t border-border px-4 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

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
export default function Sheet(props: SheetProps) {
  const { centered } = useContext(SheetPresentationContext)
  return centered ? <CenteredSheet {...props} /> : <MobileSheet {...props} />
}

function MobileSheet({
  title,
  label,
  closeLabel = '取消',
  onClose,
  children,
  footer,
  dismissable = true,
  className = '',
}: SheetProps) {
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
        className={`safe-bottom max-h-[88dvh] gap-0 overflow-hidden rounded-t-2xl border-t border-input bg-card shadow-2xl shadow-black/50 ${className}`}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-input" aria-hidden="true" />
        <SheetHeader className="shrink-0 flex-row items-center gap-0 px-4 pt-2 pb-1">
          {/* Always present: a titleless dialog has no accessible name, and
              every sheet here would be titleless without this. */}
          <SheetTitle className={title ? 'flex-1 text-left text-base font-medium' : 'sr-only'}>
            {title ?? label ?? '操作面板'}
          </SheetTitle>
          {title && dismissable && (
            <button type="button" onClick={onClose} className="tap text-sm text-muted-foreground" aria-label="关闭">
              {closeLabel}
            </button>
          )}
        </SheetHeader>
        {/* touch-pan-y keeps iOS from reading a horizontal drag in the sheet
            body as a back-navigation gesture. */}
        <div className="scroll-y min-h-0 max-h-[74dvh] touch-pan-y">{children}</div>
        {footer && <div className="shrink-0 border-t border-border/70 bg-card px-4 py-3">{footer}</div>}
      </SheetContent>
    </SheetRoot>
  )
}
