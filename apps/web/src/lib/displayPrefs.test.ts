import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, isItemHidden, type DisplayPrefs } from './displayPrefs'

describe('display preferences', () => {
  it('starts with everything visible', () => {
    expect(Object.values(DEFAULT_PREFS).every((hidden) => hidden === false)).toBe(true)
  })

  it('hides exactly the kind each switch names', () => {
    const cases = [
      ['reasoning', 'hideReasoning'],
      ['command', 'hideCommand'],
      ['tool', 'hideTool'],
      ['fileChange', 'hideFileChange'],
      ['mcpTool', 'hideMcp'],
      ['webSearch', 'hideWebSearch'],
      ['plan', 'hidePlan'],
      ['compaction', 'hideCompaction'],
    ] as const
    for (const [kind, key] of cases) {
      const prefs = { ...DEFAULT_PREFS, [key]: true } as DisplayPrefs
      expect(isItemHidden(kind, prefs)).toBe(true)
      expect(isItemHidden(kind, DEFAULT_PREFS)).toBe(false)
    }
  })

  it('never hides the conversation, errors, retries or images', () => {
    const all: DisplayPrefs = {
      hideReasoning: true,
      hideCommand: true,
      hideTool: true,
      hideFileChange: true,
      hideMcp: true,
      hideWebSearch: true,
      hidePlan: true,
      hideCompaction: true,
    }
    for (const kind of ['message', 'error', 'retry', 'image', 'unknown'] as const) {
      expect(isItemHidden(kind, all)).toBe(false)
    }
  })
})
