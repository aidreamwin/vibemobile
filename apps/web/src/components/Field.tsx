/**
 * A labelled group inside a settings form.
 *
 * Deliberately not `ui/label`: the caption names a *group* of controls, not
 * one control, so a `<label>` here would have nothing to associate with.
 */
export default function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}
