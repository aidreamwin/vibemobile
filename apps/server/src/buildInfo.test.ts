import { describe, expect, it } from 'vitest'
import { parseStamp } from './buildInfo.js'

const stamp = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: '0.1.0', commit: '11a3943', dirty: false, builtAt: 1758000000000, ...over })

describe('parseStamp', () => {
  it('reads a stamp the build wrote', () => {
    expect(parseStamp(stamp())).toEqual({
      version: '0.1.0',
      commit: '11a3943',
      dirty: false,
      builtAt: 1758000000000,
    })
  })

  it('keeps a dirty tree marked', () => {
    expect(parseStamp(stamp({ dirty: true }))?.dirty).toBe(true)
  })

  it('accepts the no-git build, where both commit and builtAt are absent', () => {
    // The Docker image has no .git; the stamp still has to load.
    expect(parseStamp(stamp({ commit: null, dirty: false, builtAt: null }))).toEqual({
      version: '0.1.0',
      commit: null,
      dirty: false,
      builtAt: null,
    })
  })

  it.each([
    ['not JSON at all', 'oops'],
    ['a JSON scalar', 'null'],
    ['an empty object', '{}'],
    ['a non-string version', stamp({ version: 1 })],
    ['a missing version', JSON.stringify({ commit: '11a3943' })],
  ])('treats %s as no stamp', (_why, raw) => {
    expect(parseStamp(raw)).toBeNull()
  })

  it.each([
    ['a non-string commit', { commit: 7 }, null],
    ['an empty commit', { commit: '' }, null],
    ['a non-numeric builtAt', { builtAt: 'yesterday' }, null],
    ['a non-boolean dirty', { dirty: 'yes' }, false],
  ])('coerces %s instead of trusting it', (_why, over, expected) => {
    const key = Object.keys(over)[0]
    expect(parseStamp(stamp(over))?.[key as 'commit' | 'builtAt' | 'dirty']).toBe(expected)
  })
})
