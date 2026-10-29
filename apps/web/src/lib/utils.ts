/**
 * The shadcn registry's components import `cn` straight from the `cn` package,
 * not from here -- that package is clsx + tailwind-merge compiled into one
 * zero-dependency engine. This module exists because `components.json` declares
 * `aliases.utils` as `@/lib/utils`, and some registry items (hooks, sonner) do
 * import from that alias. Re-exporting keeps the alias from being a dead path.
 */
export { cn } from 'cn'
