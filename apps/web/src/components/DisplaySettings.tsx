import { useState } from 'react'
import { Check, SlidersHorizontal } from 'lucide-react'
import Sheet from './Sheet'
import { Button } from './ui/button'
import { COMPACT_PREFS, DISPLAY_OPTIONS, useDisplayPrefs } from '../lib/displayPrefs'

/**
 * Global transcript visibility switches, reached from the chat header.
 *
 * Checked means hidden. Everything starts unchecked, and the choice lives in
 * localStorage without a runner suffix, so it survives switching runners.
 */
export default function DisplaySettings() {
  const [open, setOpen] = useState(false)
  const prefs = useDisplayPrefs((state) => state.prefs)
  const toggle = useDisplayPrefs((state) => state.toggle)
  const reset = useDisplayPrefs((state) => state.reset)
  const compact = useDisplayPrefs((state) => state.compact)
  const isCompact = DISPLAY_OPTIONS.every(({ key }) => prefs[key] === COMPACT_PREFS[key])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="显示设置"
        aria-label="显示设置"
        className="tap shrink-0 rounded-xl text-muted-foreground/60 active:bg-secondary"
      >
        <SlidersHorizontal aria-hidden="true" className="size-[18px]" strokeWidth={1.7} />
      </button>

      {open && (
        <Sheet title="显示设置" onClose={() => setOpen(false)}>
          <div className="px-4 pt-1 pb-4">
            <p className="pb-2 text-[12px] text-muted-foreground">
              勾选要隐藏的内容。设置全局生效，切换执行机器不会改变。
            </p>
            <div className="divide-y divide-border">
              {DISPLAY_OPTIONS.map((option) => {
                const checked = prefs[option.key]
                return (
                  <button
                    key={option.key}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => toggle(option.key)}
                    className="tap flex w-full items-center justify-between gap-3 py-3 text-left text-[15px] text-foreground/90 active:bg-secondary"
                  >
                    <span>{option.label}</span>
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-md border ${
                        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                      }`}
                    >
                      {checked && <Check aria-hidden="true" className="size-3.5" strokeWidth={2.4} />}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={reset}
                className="tap h-auto flex-1 py-3 text-[14px] text-muted-foreground"
              >
                全部恢复显示
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={compact}
                aria-pressed={isCompact}
                className="tap h-auto flex-1 py-3 text-[14px] text-muted-foreground aria-pressed:text-primary"
              >
                {isCompact && <Check aria-hidden="true" className="size-3.5" />}
                精简模式
              </Button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  )
}
