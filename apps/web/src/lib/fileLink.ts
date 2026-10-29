/**
 * Markdown links the agents write point at files on the machine, not at the
 * web:
 *
 *   `[测试规范](/D:/code/aidlux/playbook/.ai/rules/testing.md:10)`   (Claude Code)
 *   `[testing.md](rules/testing.md)`                                  (Claude Code)
 *   `[CSV](performance-recovery-20261014/performance-runs.csv)`       (Codex)
 *
 * A browser resolves every one of those against the page's own origin, so
 * tapping one asked the VibeMobile server for
 * `http://127.0.0.1:3000/D:/code/...` — a route that does not exist, which is
 * why a file reference could never be read. The same link is unambiguous here:
 * it is a path, and the session's cwd is what a relative one is relative to.
 *
 * Pure and DOM-free so the rules above can be tested one at a time.
 */

export interface FileRef {
  /** Absolute, forward-slashed — what `/api/files/content` expects. */
  path: string
  /** 1-based line the link pointed at, when it pointed at one. */
  line: number | null
}

/** `http:`, `mailto:`, `app:` … but `D:` is one letter and is a drive. */
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

/**
 * A scheme-less web link (`example.com/docs`) is not a file. The trailing `/`
 * is what keeps this honest: a bare `README.md` also has a dotted tail, and
 * treating filenames as hostnames would break the common case to fix the rare
 * one. A first segment shaped like a domain followed by a path is a hostname.
 */
const HOST_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?\//i

function decodePercent(value: string): string {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    // A literal `%` in a Windows path is not an escape sequence.
    return value
  }
}

/** Collapse `.` / `..`, unify separators, keep the drive prefix. */
export function normalizeFilePath(value: string): string {
  const drive = /^([a-zA-Z]):/.exec(value)
  const rest = drive ? value.slice(2) : value
  const rooted = rest.startsWith('/') || Boolean(drive)
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (!rooted) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const prefix = drive ? `${drive[1]}:/` : rooted ? '/' : ''
  return prefix + parts.join('/')
}

/**
 * The href of a markdown link, or `null` when it is not a file reference.
 *
 * `cwd` is the session's working directory — the base for every relative link,
 * which is what the agent meant by it. Without one a relative link cannot be
 * resolved and is left to the browser.
 */
export function parseFileRef(href: string, cwd: string | null | undefined): FileRef | null {
  if (!href) return null
  let value = href.trim()
  if (!value || value.startsWith('#')) return null
  // Protocol-relative, i.e. a URL that happens to omit its scheme.
  if (value.startsWith('//')) return null
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim()

  value = decodePercent(value)
  if (HOST_LIKE.test(value)) return null

  let line: number | null = null
  const hash = value.indexOf('#')
  if (hash >= 0) {
    // `#L37`, `#L37-L42` — GitHub's line anchors.
    const anchor = /^L(\d+)/i.exec(value.slice(hash + 1))
    if (anchor) line = Number(anchor[1])
    value = value.slice(0, hash)
  }

  value = value.replace(/\\/g, '/')

  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\//i, '')
  } else {
    const scheme = SCHEME.exec(value)
    if (scheme && scheme[1].length > 1) return null
  }
  // `file:///D:/x`, and the `/D:/x` Claude Code actually emits, are both the
  // same Windows path as `D:/x`.
  value = value.replace(/^\/(?=[a-zA-Z]:\/)/, '')

  if (line === null) {
    const suffix = /^(.+):(\d+)$/.exec(value)
    // `D:10` is not a path with a line number, it is two characters that
    // happen to look like one.
    if (suffix && suffix[1].length > 1) {
      value = suffix[1]
      line = Number(suffix[2])
    }
  }

  const absolute = /^[a-zA-Z]:\//.test(value) || value.startsWith('/')
  if (!absolute) {
    const base = cwd?.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!base) return null
    value = `${base}/${value}`
  }

  const path = normalizeFilePath(value)
  if (!path || path === '/' || /^[a-zA-Z]:\/$/.test(path)) return null
  return { path, line }
}
