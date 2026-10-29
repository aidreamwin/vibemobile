/** Small display helpers shared by the list pages. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Relative time, tuned for a phone: precise under an hour, coarse above it.
 * `now` is injectable so tests do not depend on the wall clock.
 */
export function relativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return ''
  // Codex reports some timestamps in seconds; normalise anything implausibly
  // small for a millisecond epoch.
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp
  const delta = now - ms

  if (delta < 0) return '刚刚'
  if (delta < MINUTE) return '刚刚'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)} 天前`
  return new Date(ms).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/**
 * Absolute time for rows that need a fixed point in time: `10-19 14:32` this
 * year, `2025-10-19 14:32` otherwise. `relativeTime` answers "how long ago";
 * this answers "when", and a session list shows both.
 *
 * Seconds are normalised the same way as `relativeTime`.
 */
export function formatDateTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return ''
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  // The year is only worth the width when it is not the current one.
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${monthDay} ${time}`
    : `${date.getFullYear()}-${monthDay} ${time}`
}

/**
 * The clock time for a message that happened today, otherwise the full date
 * too.
 *
 * The transcript shows this under every user bubble and after every finished
 * turn, so it has to stay short: a phone column has room for `14:32`, and the
 * date only earns its width once the timestamp is no longer "today".
 */
export function formatClock(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return ''
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp
  const date = new Date(ms)
  if (new Date(now).toDateString() !== date.toDateString()) return formatDateTime(ms, now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * A token count as a phone can read it: `30.2k`, `258k`, `812`.
 *
 * Three significant digits at most, and no decimals above 100k — a header has
 * room for one short string, and the difference between 258 400 and 258 000 is
 * not a difference anyone acts on. `0` is a real value here (a cached-only
 * request reports 0 new input tokens), so it is rendered rather than treated as
 * "absent" the way `formatBytes` treats its falsy input.
 */
export function formatTokens(tokens: number | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return ''
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(tokens / 1000)}k`
}

/** Keep the tail of a path — on a phone the filename matters, the root does not. */
export function shortPath(path: string, segments = 2): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segments) return path
  return `…/${parts.slice(-segments).join('/')}`
}
