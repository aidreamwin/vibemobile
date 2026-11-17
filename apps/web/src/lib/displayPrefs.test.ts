import { describe, expect, it, vi } from 'vitest'
import {
  COMPACT_PREFS,
  DEFAULT_PREFS,
  DISPLAY_OPTIONS,
  isItemHidden,
  useDisplayPrefs,
  type DisplayPrefs,
} from './displayPrefs'

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

  it('applies compact mode as editable switches and persists changes and reset', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem })
    try {
      useDisplayPrefs.getState().compact()
      const compact = useDisplayPrefs.getState().prefs
      expect(compact).toEqual(COMPACT_PREFS)
      for (const { key } of DISPLAY_OPTIONS) expect(compact[key]).toBe(key !== 'hideCompaction')
      expect(isItemHidden('compaction', compact)).toBe(false)
      expect(isItemHidden('message', compact)).toBe(false)
      expect(setItem).toHaveBeenLastCalledWith('vibemobile.displayPrefs', JSON.stringify(COMPACT_PREFS))
      useDisplayPrefs.getState().toggle('hideCommand')
      expect(useDisplayPrefs.getState().prefs.hideCommand).toBe(false)
      expect(COMPACT_PREFS.hideCommand).toBe(true)
      useDisplayPrefs.getState().reset()
      expect(useDisplayPrefs.getState().prefs).toEqual(DEFAULT_PREFS)
      expect(setItem).toHaveBeenLastCalledWith('vibemobile.displayPrefs', JSON.stringify(DEFAULT_PREFS))
    } finally {
      useDisplayPrefs.setState({ prefs: { ...DEFAULT_PREFS } })
      vi.unstubAllGlobals()
    }
  })
})
