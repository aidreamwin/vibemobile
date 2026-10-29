/**
 * Global transcript visibility preferences.
 *
 * Deliberately NOT scoped by runner (unlike `runnerStorageKey`): the user asked
 * for these to follow them across execution machines. They are display-only —
 * exports and copies still see the full turn.
 */
import { create } from 'zustand'
import type { AgentItem } from '@vibemobile/protocol'

export interface DisplayPrefs {
  hideReasoning: boolean
  hideCommand: boolean
  hideTool: boolean
  hideFileChange: boolean
  hideMcp: boolean
  hideWebSearch: boolean
  hidePlan: boolean
  hideCompaction: boolean
}

export const DEFAULT_PREFS: DisplayPrefs = {
  hideReasoning: false,
  hideCommand: false,
  hideTool: false,
  hideFileChange: false,
  hideMcp: false,
  hideWebSearch: false,
  hidePlan: false,
  hideCompaction: false,
}

export interface DisplayOption {
  key: keyof DisplayPrefs
  label: string
}

/** Checkbox order, mirroring the settings popover. */
export const DISPLAY_OPTIONS: DisplayOption[] = [
  { key: 'hideReasoning', label: '不显示思考过程' },
  { key: 'hideCommand', label: '不显示命令' },
  { key: 'hideTool', label: '不显示工具调用' },
  { key: 'hideFileChange', label: '不显示文件 diff' },
  { key: 'hideMcp', label: '不显示 MCP' },
  { key: 'hideWebSearch', label: '不显示搜索' },
  { key: 'hidePlan', label: '不显示计划' },
  { key: 'hideCompaction', label: '不显示压缩提示' },
]

const STORAGE_KEY = 'vibemobile.displayPrefs'

function load(): DisplayPrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFS }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS }
    const prefs = { ...DEFAULT_PREFS }
    for (const { key } of DISPLAY_OPTIONS) {
      if (typeof raw[key] === 'boolean') prefs[key] = raw[key] as boolean
    }
    return prefs
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function persist(prefs: DisplayPrefs): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Private mode / quota: the preference still works for this visit.
  }
}

interface DisplayState {
  prefs: DisplayPrefs
  toggle: (key: keyof DisplayPrefs) => void
  reset: () => void
}

export const useDisplayPrefs = create<DisplayState>((set, get) => ({
  prefs: load(),
  toggle: (key) => {
    const prefs = { ...get().prefs, [key]: !get().prefs[key] }
    persist(prefs)
    set({ prefs })
  },
  reset: () => {
    persist(DEFAULT_PREFS)
    set({ prefs: { ...DEFAULT_PREFS } })
  },
}))

/** Whether an item kind is hidden by the current preferences. */
export function isItemHidden(kind: AgentItem['kind'], prefs: DisplayPrefs): boolean {
  switch (kind) {
    case 'reasoning':
      return prefs.hideReasoning
    case 'command':
      return prefs.hideCommand
    case 'tool':
      return prefs.hideTool
    case 'fileChange':
      return prefs.hideFileChange
    case 'mcpTool':
      return prefs.hideMcp
    case 'webSearch':
      return prefs.hideWebSearch
    case 'plan':
      return prefs.hidePlan
    case 'compaction':
      return prefs.hideCompaction
    default:
      return false
  }
}
