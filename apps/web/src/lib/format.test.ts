/**
 * `formatTokens` and `formatDateTime`.
 *
 * The token formatter has a boundary that is easy to move by accident — `0` is
 * a real value here (a request served entirely from cache reports zero new
 * input tokens), whereas `formatBytes` renders its falsy input as absent.
 * Copying that habit over would make a legitimate zero disappear from the
 * usage sheet. The date formatter's year-inclusion rule is the other one worth
 * pinning: a row that drops the year on an old session reads as this year.
 */
import { describe, expect, it } from 'vitest'
import { formatDateTime, formatTokens } from './format'

describe('formatTokens', () => {
  it('renders small counts exactly', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(999)).toBe('999')
  })

  it('drops to one decimal up to six figures', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(30170)).toBe('30.2k')
    expect(formatTokens(99999)).toBe('100k')
  })

  it('rounds to whole thousands above that', () => {
    expect(formatTokens(100_000)).toBe('100k')
    expect(formatTokens(258_400)).toBe('258k')
  })

  it('renders nothing for a value that is not a count', () => {
    expect(formatTokens(undefined)).toBe('')
    expect(formatTokens(-1)).toBe('')
    expect(formatTokens(Number.NaN)).toBe('')
  })
})

describe('formatDateTime', () => {
  const now = new Date(2026, 9, 19, 12, 0).getTime()

  it('keeps the timestamp short within the current year', () => {
    expect(formatDateTime(new Date(2026, 9, 19, 8, 5).getTime(), now)).toBe('10-19 08:05')
  })

  it('adds the year once the session is older than this year', () => {
    expect(formatDateTime(new Date(2025, 11, 3, 23, 59).getTime(), now)).toBe('2025-12-03 23:59')
  })

  it('normalises second-based timestamps like relativeTime does', () => {
    expect(formatDateTime(Math.floor(new Date(2026, 0, 2, 3, 4).getTime() / 1000), now)).toBe('01-02 03:04')
  })

  it('renders nothing when there is no timestamp', () => {
    expect(formatDateTime(undefined, now)).toBe('')
    expect(formatDateTime(0, now)).toBe('')
  })
})
