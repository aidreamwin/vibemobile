/** Runner scope is part of the URL, so bookmarks and separate tabs cannot drift. */
export function scopeFromPath(pathname: string): string {
  return /^\/r\/([a-zA-Z0-9_-]{1,64})(?:\/|$)/.exec(pathname)?.[1] ?? ''
}

/**
 * Everything after `/r/<scope>` — the path a runner switch must keep.
 *
 * Deliberately takes the pathname rather than reading `location` here: the
 * suffix at *switch time* is what matters. React Router changes the URL with
 * pushState and does not reload the module, so a value captured at import time
 * is the URL the tab was opened with, not the page the user is looking at.
 */
export function pathAfterScope(pathname: string, search = '', hash = ''): string {
  const scope = scopeFromPath(pathname)
  const base = scope ? `/r/${scope}` : ''
  const rest = pathname.slice(base.length) || '/'
  return `${rest.startsWith('/') ? rest : `/${rest}`}${search}${hash}`
}

/** Full URL for the same page on another runner. Read at call time, not import. */
export function runnerSwitchUrl(id: string): string {
  const suffix =
    typeof location === 'undefined' ? '/' : pathAfterScope(location.pathname, location.search, location.hash)
  return `/r/${encodeURIComponent(id)}${suffix}`
}

export const runnerId = typeof location === 'undefined' ? '' : scopeFromPath(location.pathname)
export const runnerBase = runnerId ? `/r/${runnerId}` : ''
export const runnerPath = (path: string) => `${runnerBase}${path}`
export const runnerStorageKey = (key: string) => (runnerId ? `${key}.${runnerId}` : key)

export type { RunnerInfo } from '@vibemobile/protocol'
