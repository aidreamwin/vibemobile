import { describe, expect, it } from 'vitest'
import { autoCompactWindowFor, guessedContextWindowForModel } from './runtime.js'

describe('autoCompactWindowFor', () => {
  it('leaves 20% headroom on a 1M window', () => {
    // The reported failure: 1,019,635 message tokens + 32,000 completion
    // against a 1,048,576-token hard limit. Triggering at 838k leaves enough
    // room for a tool-heavy turn to finish before the next compaction check.
    expect(autoCompactWindowFor(1_048_576)).toBe(838_860)
  })

  it('leaves 20% on a 200k window', () => {
    expect(autoCompactWindowFor(200_000)).toBe(160_000)
  })

  it('clamps to the setting maximum', () => {
    expect(autoCompactWindowFor(2_000_000)).toBe(1_000_000)
  })

  it('skips windows too small for the setting minimum', () => {
    // 100k * 0.8 would be below the CLI's accepted 100k floor; let its own
    // policy handle a window that small rather than disabling compaction.
    expect(autoCompactWindowFor(100_000)).toBeUndefined()
    expect(autoCompactWindowFor(124_999)).toBeUndefined()
  })

  it('starts using the setting at the floor', () => {
    expect(autoCompactWindowFor(125_000)).toBe(100_000)
  })

  it('skips unknown windows', () => {
    expect(autoCompactWindowFor(undefined)).toBeUndefined()
    expect(autoCompactWindowFor(0)).toBeUndefined()
  })
})

describe('guessedContextWindowForModel', () => {
  it('recognises the 1M catalogue spelling', () => {
    expect(guessedContextWindowForModel('deepseek-flash[1m]')).toBe(1_048_576)
    expect(guessedContextWindowForModel('claude-sonnet-5[1M]')).toBe(1_048_576)
  })

  it('does not guess for ordinary models', () => {
    expect(guessedContextWindowForModel('deepseek-flash')).toBeUndefined()
    expect(guessedContextWindowForModel('claude-opus-5')).toBeUndefined()
    expect(guessedContextWindowForModel(undefined)).toBeUndefined()
  })
})
