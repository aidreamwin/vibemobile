import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export default function ToolbarRow({ children }: { children: ReactNode }) {
  return <div className="flex min-h-13 min-w-0 items-center gap-1 px-2 py-1 sm:gap-2 sm:px-3">{children}</div>
}

export function ToolbarIdentity({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <h1 title={label} className="flex size-9 shrink-0 items-center justify-center text-foreground">
      <Icon aria-hidden="true" className="size-5" strokeWidth={1.8} />
      <span className="sr-only">{label}</span>
    </h1>
  )
}
