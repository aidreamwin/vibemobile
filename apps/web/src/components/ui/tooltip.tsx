import type { ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'

/**
 * A compact label for icon-only controls.
 *
 * Touch devices have no hover, so the same control must also carry an
 * `aria-label`; the hint is an addition, not the only source of the text.
 */
export function Hint({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom'
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-72 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-relaxed text-popover-foreground shadow-lg"
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-popover" width={8} height={4} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
