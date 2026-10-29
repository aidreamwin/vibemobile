import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/* Radix throws on <SelectItem value="">, so "no explicit choice" needs a real
 * string. It is translated back to '' at this boundary, because '' is what the
 * API means by "let the server decide" -- see `model: model || undefined` at
 * the call sites. */
const NONE = '__none__'

/**
 * The app's one dropdown. Replaces the hand-rolled native `<select>` wrapper
 * in NewSessionSheet -- the native picker rendered as a light OS panel over
 * the dark UI.
 *
 * `options` may contain a `value: ''` entry; it becomes the "nothing chosen"
 * row and round-trips to '' on the way out.
 */
export default function SelectField({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
  ariaLabel: string
}) {
  return (
    <Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? '' : next)}>
      <SelectTrigger
        aria-label={ariaLabel}
        disabled={disabled}
        /* `data-[size=default]:h-auto` is load-bearing: the base's height comes
           from a data-variant, and tailwind-merge will NOT cancel it with a
           plain `h-auto`. Same trap as `dark:` -- see BARE_TRIGGER in
           Composer.tsx. py-3 on 15px text lands on the 48px this control was
           already using. */
        className="tap h-auto w-full justify-between rounded-xl bg-secondary px-3.5 py-3 text-[15px] data-[size=default]:h-auto dark:bg-secondary dark:hover:bg-secondary"
      >
        <SelectValue />
      </SelectTrigger>
      {/* Matching the trigger width is what the native picker did for free. */}
      <SelectContent position="popper" align="start" className="w-[var(--radix-select-trigger-width)]">
        {options.map((option) => (
          <SelectItem key={option.value || NONE} value={option.value || NONE}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
