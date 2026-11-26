import { create } from 'zustand'
import type { FileEntry, ProviderId, SessionStatus } from '@vibemobile/protocol'
import { filePathKey } from './fileLink'
import { runnerStorageKey } from './runner'

export type WorkbenchTab =
  | {
      id: string
      kind: 'chat'
      threadId: string
      title: string
      provider?: ProviderId
      status?: SessionStatus
    }
  | {
      id: string
      kind: 'file'
      path: string
      title: string
      line?: number
    }
  | {
      id: string
      kind: 'diff'
      path?: string
      title: string
    }
  | {
      id: string
      kind: 'settings'
      title: string
    }

export interface TerminalTab {
  id: string
  title: string
}

export type SidebarTab = 'agents' | 'files'
export type AgentPanePosition = 'start' | 'end'
export type PaneCount = 1 | 2 | 3 | 4
export const MAX_PANES = 4
type ColumnCount = 3 | 4
type ColumnWidths = Record<ColumnCount, number[]>
interface OpenTabOptions {
  inSecondary?: boolean
  split?: boolean
  targetPane?: number
}

export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 272

export const TERMINAL_MIN = 150
export const TERMINAL_MAX = 560
export const TERMINAL_DEFAULT = 260

interface TabSelection {
  activeTabId: string | null
  secondaryTabId: string | null
  paneIds: (string | null)[]
  focusedPane: number
}

interface PersistedWorkbench extends TabSelection {
  tabs: WorkbenchTab[]
  splitEnabled: boolean
  splitRatio: number | null
  agentSplitRatio: number | null
  gridColumnRatio: number | null
  gridRowRatio: number | null
  columnWidths: ColumnWidths
  splitDirection: 'auto' | 'horizontal' | 'vertical'
  agentPanePosition: AgentPanePosition
  settingsReturn: TabSelection | null
  sidebarOpen: boolean
  sidebarTab: SidebarTab
  sidebarWidth: number
  terminalOpen: boolean
  terminalHeight: number
  inspectorOpen: boolean
  terminals: TerminalTab[]
  activeTerminalId: string
}

const STORAGE_KEY = () => runnerStorageKey('vibemobile.workbench.v1')

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeSplitRatio(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : null
}

function normalizeColumnWidths(value: unknown, count: ColumnCount): number[] {
  const widths =
    Array.isArray(value) &&
    value.length === count &&
    value.every((width) => typeof width === 'number' && Number.isFinite(width) && width >= 0)
      ? value
      : Array<number>(count).fill(1)
  const total = widths.reduce((sum, width) => sum + width, 0)
  return total > 0 && Number.isFinite(total)
    ? widths.map((width) => width / total)
    : Array<number>(count).fill(1 / count)
}

export function resizeColumnWidths(widths: number[], index: number, ratio: number | null): number[] {
  if (index < 0 || index >= widths.length - 1) return widths
  if (ratio === null) return widths.map(() => 1 / widths.length)
  const bounded = normalizeSplitRatio(ratio)
  if (bounded === null) return widths
  const next = [...widths]
  const total = next[index] + next[index + 1]
  next[index] = total * bounded
  next[index + 1] = total - next[index]
  return next
}

function defaultTerminal(): TerminalTab {
  return { id: 'term-1', title: '终端 1' }
}

function defaultState(): PersistedWorkbench {
  const first = defaultTerminal()
  return {
    tabs: [],
    activeTabId: null,
    secondaryTabId: null,
    paneIds: [null],
    focusedPane: 0,
    splitEnabled: false,
    splitRatio: null,
    agentSplitRatio: null,
    gridColumnRatio: null,
    gridRowRatio: null,
    columnWidths: { 3: normalizeColumnWidths(null, 3), 4: normalizeColumnWidths(null, 4) },
    splitDirection: 'auto',
    agentPanePosition: 'start',
    settingsReturn: null,
    sidebarOpen: true,
    sidebarTab: 'agents',
    sidebarWidth: SIDEBAR_DEFAULT,
    terminalOpen: false,
    terminalHeight: TERMINAL_DEFAULT,
    inspectorOpen: false,
    terminals: [first],
    activeTerminalId: first.id,
  }
}

function loadPersisted(): PersistedWorkbench {
  const fallback = defaultState()
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY())
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PersistedWorkbench>
    const terminals =
      Array.isArray(parsed.terminals) && parsed.terminals.length > 0 ? parsed.terminals : fallback.terminals
    const activeTerminalId = terminals.some((t) => t.id === parsed.activeTerminalId)
      ? (parsed.activeTerminalId as string)
      : terminals[0].id
    const tabs = Array.isArray(parsed.tabs) ? parsed.tabs : []
    const active =
      tabs.find((tab) => tab.id === parsed.activeTabId) ?? (Array.isArray(parsed.paneIds) ? undefined : tabs[0])
    const secondaryTabId = parsed.splitEnabled
      ? (tabs.find((tab) => tab.id === parsed.secondaryTabId && tab.id !== active?.id && tab.kind !== 'settings')?.id ??
        null)
      : null
    const restored = restoreSelection(tabs, parsed, active?.id)
    const selection = Array.isArray(parsed.paneIds)
      ? restored
      : orderMixed(tabs, restored.paneIds, restored.focusedPane, parsed.agentPanePosition ?? 'start')
    const settingsReturn =
      active?.kind === 'settings' ? restoreSelection(tabs, parsed.settingsReturn, secondaryTabId) : null
    return {
      tabs,
      ...(active?.kind === 'settings' ? tabSelection(['settings'], 0) : selection),
      splitRatio: normalizeSplitRatio(parsed.splitRatio),
      agentSplitRatio: normalizeSplitRatio(parsed.agentSplitRatio),
      gridColumnRatio: normalizeSplitRatio(parsed.gridColumnRatio),
      gridRowRatio: normalizeSplitRatio(parsed.gridRowRatio),
      columnWidths: {
        3: normalizeColumnWidths(parsed.columnWidths?.[3], 3),
        4: normalizeColumnWidths(parsed.columnWidths?.[4], 4),
      },
      splitDirection:
        parsed.splitDirection === 'horizontal' || parsed.splitDirection === 'vertical' ? parsed.splitDirection : 'auto',
      agentPanePosition: parsed.agentPanePosition === 'end' ? 'end' : 'start',
      settingsReturn,
      sidebarOpen: parsed.sidebarOpen ?? true,
      sidebarTab: parsed.sidebarTab === 'files' ? 'files' : 'agents',
      sidebarWidth: clamp(parsed.sidebarWidth ?? SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
      terminalOpen: Boolean(parsed.terminalOpen),
      terminalHeight: clamp(parsed.terminalHeight ?? TERMINAL_DEFAULT, TERMINAL_MIN, TERMINAL_MAX),
      inspectorOpen: Boolean(parsed.inspectorOpen),
      terminals,
      activeTerminalId,
    }
  } catch {
    return fallback
  }
}

function savePersisted(state: PersistedWorkbench): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY(), JSON.stringify(state))
  } catch {
    // Storage quota or private mode failures should never break the workbench.
  }
}

function pickPersisted(s: WorkbenchState): PersistedWorkbench {
  return {
    tabs: s.tabs,
    activeTabId: s.activeTabId,
    secondaryTabId: s.secondaryTabId,
    paneIds: s.paneIds,
    focusedPane: s.focusedPane,
    splitEnabled: s.splitEnabled,
    splitRatio: s.splitRatio,
    agentSplitRatio: s.agentSplitRatio,
    gridColumnRatio: s.gridColumnRatio,
    gridRowRatio: s.gridRowRatio,
    columnWidths: s.columnWidths,
    splitDirection: s.splitDirection,
    agentPanePosition: s.agentPanePosition,
    settingsReturn: s.settingsReturn,
    sidebarOpen: s.sidebarOpen,
    sidebarTab: s.sidebarTab,
    sidebarWidth: s.sidebarWidth,
    terminalOpen: s.terminalOpen,
    terminalHeight: s.terminalHeight,
    inspectorOpen: s.inspectorOpen,
    terminals: s.terminals,
    activeTerminalId: s.activeTerminalId,
  }
}

export interface WorkbenchState extends PersistedWorkbench {
  terminalMaximized: boolean
  commandPaletteOpen: boolean

  openChatTab: (
    chat: { threadId: string; title?: string; provider?: ProviderId; status?: SessionStatus },
    opts?: OpenTabOptions,
  ) => void
  openFileTab: (file: { path: string; title?: string; line?: number }, opts?: OpenTabOptions) => void
  openDiffTab: (diff?: { path?: string; title?: string }, opts?: OpenTabOptions) => void
  openSettingsTab: () => void
  updateChatTabMeta: (threadId: string, meta: { title?: string; provider?: ProviderId; status?: SessionStatus }) => void
  closeTab: (id: string) => void
  closeAllTabs: (id: string) => void
  fileChanged: (path: string, replacement?: FileEntry) => void
  setActiveTab: (id: string) => void
  focusPane: (index: number) => void
  showTabInPane: (index: number, id: string) => void
  closePane: (index: number) => void
  splitTab: (id: string) => void
  setPaneCount: (count: PaneCount, direction?: 'auto' | 'horizontal' | 'vertical') => void
  toggleSplit: () => void
  setSplitRatio: (ratio: number | null, mixed?: boolean) => void
  setGridRatio: (axis: 'column' | 'row', ratio: number | null) => void
  setColumnRatio: (count: ColumnCount, index: number, ratio: number | null) => void
  setAgentPanePosition: (position: AgentPanePosition) => void

  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSidebarTab: (tab: SidebarTab) => void
  setSidebarWidth: (width: number) => void

  toggleTerminal: () => void
  setTerminalOpen: (open: boolean) => void
  setTerminalHeight: (height: number) => void
  toggleTerminalMaximized: () => void
  addTerminal: () => void
  closeTerminal: (id: string) => void
  setActiveTerminal: (id: string) => void

  toggleInspector: () => void
  setInspectorOpen: (open: boolean) => void

  setCommandPaletteOpen: (open: boolean) => void
  resetWorkbench: () => void
}

function tabSelection(paneIds: (string | null)[], focusedPane: number) {
  const activeTabId = paneIds[focusedPane] ?? null
  const secondaryTabId = paneIds.find((id, index) => id && index !== focusedPane) ?? null
  return { paneIds, focusedPane, activeTabId, secondaryTabId, splitEnabled: paneIds.length > 1 }
}

function samePane(a: WorkbenchTab, b: WorkbenchTab): boolean {
  return (a.kind === 'chat') === (b.kind === 'chat')
}

function restoreSelection(tabs: WorkbenchTab[], selection?: Partial<TabSelection> | null, fallbackId?: string | null) {
  const workspaceTabs = tabs.filter((tab) => tab.kind !== 'settings')
  const valid = new Set(workspaceTabs.map((tab) => tab.id))
  const seen = new Set<string>()
  const raw =
    Array.isArray(selection?.paneIds) && selection.paneIds.length
      ? selection.paneIds.slice(0, MAX_PANES)
      : [selection?.activeTabId ?? fallbackId ?? null, selection?.secondaryTabId].filter(Boolean)
  const panes = raw.map((id) => {
    if (typeof id !== 'string' || !valid.has(id) || seen.has(id)) return null
    seen.add(id)
    return id
  })
  if (!panes.length) panes.push(workspaceTabs.at(-1)?.id ?? null)
  if (!Array.isArray(selection?.paneIds) && !panes.some(Boolean) && workspaceTabs.length)
    panes[0] = workspaceTabs.at(-1)?.id ?? null
  const focused =
    typeof selection?.focusedPane === 'number' && Number.isInteger(selection.focusedPane)
      ? clamp(selection.focusedPane, 0, panes.length - 1)
      : 0
  return tabSelection(panes, focused)
}

function orderMixed(tabs: WorkbenchTab[], panes: (string | null)[], focused: number, position: AgentPanePosition) {
  if (panes.length === 2 && panes.every(Boolean)) {
    const first = tabs.find((tab) => tab.id === panes[0])
    const second = tabs.find((tab) => tab.id === panes[1])
    if (first && second && !samePane(first, second) && (first.kind === 'chat') !== (position === 'start')) {
      return tabSelection([panes[1], panes[0]], 1 - focused)
    }
  }
  return tabSelection(panes, focused)
}

function selectTab(state: WorkbenchState, tab: WorkbenchTab, opts?: OpenTabOptions): Partial<WorkbenchState> {
  if (tab.kind === 'settings') {
    return {
      ...tabSelection(['settings'], 0),
      settingsReturn: state.activeTabId === 'settings' ? state.settingsReturn : restoreSelection(state.tabs, state),
    }
  }
  const current = state.activeTabId === 'settings' ? (state.settingsReturn ?? restoreSelection(state.tabs)) : state
  const panes = [...current.paneIds]
  const focused = current.focusedPane
  const existing = panes.indexOf(tab.id)
  if (opts?.targetPane !== undefined && panes[opts.targetPane] !== undefined) {
    const target = opts.targetPane
    if (existing >= 0) panes[existing] = panes[target]
    panes[target] = tab.id
    return { ...tabSelection(panes, target), settingsReturn: null }
  }
  if (existing >= 0) return { ...tabSelection(panes, existing), settingsReturn: null }
  const active = state.tabs.find((candidate) => candidate.id === panes[focused])
  const matching = panes.findIndex((id) => {
    const candidate = state.tabs.find((item) => item.id === id)
    return candidate && samePane(candidate, tab)
  })
  const empty = panes.indexOf(null)
  let target = focused
  if (opts?.split) target = empty >= 0 ? empty : panes.length < MAX_PANES ? panes.length : focused
  else if (!active) target = focused
  else if (opts?.inSecondary) {
    if (matching >= 0 && matching !== focused) target = matching
    else if (empty >= 0) target = empty
    else if (panes.length === 1) target = 1
    else if (
      !panes.some((id) => {
        const candidate = state.tabs.find((item) => item.id === id)
        return candidate && !samePane(candidate, active)
      })
    )
      target = (focused + 1) % panes.length
    else if (!samePane(active, tab)) target = (focused + 1) % panes.length
  } else if (!samePane(active, tab)) {
    target = matching >= 0 ? matching : empty >= 0 ? empty : panes.length === 1 ? 1 : focused
  }
  panes[target] = tab.id
  const nextFocus = opts?.inSecondary && !opts.split && active && existing < 0 && target !== focused ? focused : target
  return {
    ...orderMixed(
      state.tabs.some((item) => item.id === tab.id) ? state.tabs : [...state.tabs, tab],
      panes,
      nextFocus,
      state.agentPanePosition,
    ),
    settingsReturn: null,
  }
}

function openOrFocusTab(state: WorkbenchState, tab: WorkbenchTab, opts?: OpenTabOptions): Partial<WorkbenchState> {
  const exists = state.tabs.some((t) => t.id === tab.id)
  const tabs = exists ? state.tabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t)) : [...state.tabs, tab]
  return { tabs, ...selectTab(state, tab, opts) }
}

function selectionAfterClose(previousTabs: WorkbenchTab[], tabs: WorkbenchTab[], current: TabSelection) {
  const panes = [...current.paneIds]
  const available = new Set(tabs.map((tab) => tab.id))
  const focusId = panes[current.focusedPane]
  for (let index = panes.length - 1; index >= 0; index--) {
    const id = panes[index]
    if (!id || available.has(id)) continue
    const closed = previousTabs.find((tab) => tab.id === id)
    const replacement = tabs.findLast(
      (tab) => tab.kind !== 'settings' && closed && samePane(closed, tab) && !panes.includes(tab.id),
    )
    if (replacement) panes[index] = replacement.id
    else panes.splice(index, 1)
  }
  if (!panes.length) panes.push(tabs.findLast((tab) => tab.kind !== 'settings')?.id ?? null)
  return tabSelection(
    panes,
    focusId && panes.includes(focusId) ? panes.indexOf(focusId) : Math.min(current.focusedPane, panes.length - 1),
  )
}

function resizePanes(state: WorkbenchState, count: PaneCount) {
  if (state.activeTabId === 'settings') return {}
  const panes = [...state.paneIds]
  let focused = state.focusedPane
  if (count < panes.length) {
    const active = panes[focused]
    panes.length = count
    if (focused >= count) {
      focused = count - 1
      panes[focused] = active
    }
  } else {
    while (panes.length < count) {
      const next = state.tabs.findLast((tab) => tab.kind !== 'settings' && !panes.includes(tab.id))
      panes.push(next?.id ?? null)
    }
  }
  return orderMixed(state.tabs, panes, focused, state.agentPanePosition)
}

export const useWorkbenchStore = create<WorkbenchState>((set) => {
  const initial = loadPersisted()

  const commit = (updater: (state: WorkbenchState) => Partial<WorkbenchState>) => {
    set((state) => {
      const patch = updater(state)
      if (!Object.keys(patch).length) return state
      const next = { ...state, ...patch }
      savePersisted(pickPersisted(next))
      return patch
    })
  }

  return {
    ...initial,
    terminalMaximized: false,
    commandPaletteOpen: false,

    openChatTab: ({ threadId, title, provider, status }, opts) =>
      commit((state) => {
        const id = `chat:${threadId}`
        const existing = state.tabs.find((t) => t.id === id)
        const resolvedTitle = title || (existing?.kind === 'chat' ? existing.title : '对话')
        return openOrFocusTab(
          state,
          {
            id,
            kind: 'chat',
            threadId,
            title: resolvedTitle,
            provider: provider ?? (existing?.kind === 'chat' ? existing.provider : undefined),
            status: status ?? (existing?.kind === 'chat' ? existing.status : undefined),
          },
          opts,
        )
      }),

    openFileTab: ({ path, title, line }, opts) =>
      commit((state) => {
        const id = `file:${path}`
        const name = title || path.split(/[\\/]/).filter(Boolean).pop() || path
        return openOrFocusTab(state, { id, kind: 'file', path, title: name, line }, opts)
      }),

    openDiffTab: (diff, opts) =>
      commit((state) => {
        const path = diff?.path
        const id = `diff:${path ?? 'workspace'}`
        const title = diff?.title || (path ? `改动 · ${path.split(/[\\/]/).pop()}` : '工作区改动')
        return openOrFocusTab(state, { id, kind: 'diff', path, title }, opts)
      }),

    openSettingsTab: () =>
      commit((state) => openOrFocusTab(state, { id: 'settings', kind: 'settings', title: '设置' })),

    updateChatTabMeta: (threadId, meta) =>
      commit((state) => {
        const id = `chat:${threadId}`
        let changed = false
        const tabs = state.tabs.map((tab) => {
          if (tab.id !== id || tab.kind !== 'chat') return tab
          const nextTitle = meta.title ?? tab.title
          const nextProvider = meta.provider ?? tab.provider
          const nextStatus = meta.status ?? tab.status
          if (nextTitle === tab.title && nextProvider === tab.provider && nextStatus === tab.status) return tab
          changed = true
          return { ...tab, title: nextTitle, provider: nextProvider, status: nextStatus }
        })
        return changed ? { tabs } : {}
      }),

    closeTab: (id) =>
      commit((state) => {
        const index = state.tabs.findIndex((t) => t.id === id)
        if (index === -1) return {}
        const tabs = state.tabs.filter((t) => t.id !== id)
        if (state.activeTabId === 'settings') {
          if (id === 'settings') {
            const previous = restoreSelection(tabs, state.settingsReturn)
            return {
              tabs,
              ...previous,
              settingsReturn: null,
            }
          }
          const next = state.settingsReturn && selectionAfterClose(state.tabs, tabs, state.settingsReturn)
          return { tabs, settingsReturn: next }
        }
        return { tabs, ...selectionAfterClose(state.tabs, tabs, state) }
      }),

    fileChanged: (filePath, replacement) =>
      commit((state) => {
        const matching = state.tabs.filter(
          (tab) =>
            (tab.kind === 'file' || tab.kind === 'diff') && tab.path && filePathKey(tab.path) === filePathKey(filePath),
        )
        if (!matching.length) return {}
        const ids = new Set(matching.map((tab) => tab.id))
        if (!replacement) {
          const tabs = state.tabs.filter((tab) => !ids.has(tab.id))
          return state.activeTabId === 'settings'
            ? {
                tabs,
                settingsReturn: state.settingsReturn && selectionAfterClose(state.tabs, tabs, state.settingsReturn),
              }
            : { tabs, ...selectionAfterClose(state.tabs, tabs, state) }
        }
        const mapping = new Map<string, string>()
        const tabs = state.tabs.map((tab) => {
          if (!ids.has(tab.id) || (tab.kind !== 'file' && tab.kind !== 'diff')) return tab
          const id = `${tab.kind}:${replacement.path}`
          mapping.set(tab.id, id)
          return {
            ...tab,
            id,
            path: replacement.path,
            title: tab.kind === 'file' ? replacement.name : `改动 · ${replacement.name}`,
          }
        })
        const uniqueTabs = [...new Map(tabs.map((tab) => [tab.id, tab])).values()]
        const replaceSelection = (selection: TabSelection) => {
          const seen = new Set<string>()
          const panes = selection.paneIds.map((id) => {
            if (!id) return null
            const next = mapping.get(id) ?? id
            if (seen.has(next)) return null
            seen.add(next)
            return next
          })
          return tabSelection(panes, selection.focusedPane)
        }
        return {
          tabs: uniqueTabs,
          ...replaceSelection(state),
          settingsReturn: state.settingsReturn && replaceSelection(state.settingsReturn),
        }
      }),

    closeAllTabs: (id) =>
      commit((state) => {
        const target = state.tabs.find((tab) => tab.id === id)
        if (!target || target.kind === 'settings') return {}
        const tabs = state.tabs.filter((tab) => tab.kind === 'settings' || !samePane(target, tab))
        if (state.activeTabId === 'settings') {
          return {
            tabs,
            settingsReturn: state.settingsReturn && selectionAfterClose(state.tabs, tabs, state.settingsReturn),
          }
        }
        return {
          tabs,
          ...selectionAfterClose(state.tabs, tabs, state),
          settingsReturn: null,
        }
      }),

    setActiveTab: (id) =>
      commit((state) => {
        if (id === state.activeTabId) return {}
        const tab = state.tabs.find((candidate) => candidate.id === id)
        return tab ? selectTab(state, tab) : {}
      }),

    focusPane: (index) =>
      commit((state) => {
        if (index === state.focusedPane || index < 0 || index >= state.paneIds.length) return {}
        return tabSelection(state.paneIds, index)
      }),

    showTabInPane: (index, id) =>
      commit((state) => {
        if (
          state.activeTabId === 'settings' ||
          index < 0 ||
          index >= state.paneIds.length ||
          !state.tabs.some((tab) => tab.id === id && tab.kind !== 'settings')
        )
          return {}
        const panes = [...state.paneIds]
        const previous = panes.indexOf(id)
        if (previous >= 0) panes[previous] = panes[index]
        panes[index] = id
        return tabSelection(panes, index)
      }),

    closePane: (index) =>
      commit((state) => {
        if (state.paneIds.length <= 1 || index < 0 || index >= state.paneIds.length) return {}
        const panes = state.paneIds.filter((_, slot) => slot !== index)
        return tabSelection(
          panes,
          Math.min(state.focusedPane > index ? state.focusedPane - 1 : state.focusedPane, panes.length - 1),
        )
      }),

    splitTab: (id) =>
      commit((state) => {
        const tab = state.tabs.find((item) => item.id === id && item.kind !== 'settings')
        return tab && (state.paneIds.length < MAX_PANES || state.paneIds.includes(null))
          ? selectTab(state, tab, { split: true })
          : {}
      }),

    setPaneCount: (count, direction = 'auto') =>
      commit((state) => ({
        ...resizePanes(state, count),
        splitDirection: direction,
      })),

    toggleSplit: () =>
      commit((state) => resizePanes(state, Math.min(MAX_PANES, state.paneIds.length + 1) as PaneCount)),

    setSplitRatio: (ratio, mixed) => {
      const value = normalizeSplitRatio(ratio)
      commit(() => (mixed ? { agentSplitRatio: value } : { splitRatio: value }))
    },
    setGridRatio: (axis, ratio) =>
      commit(() =>
        axis === 'column'
          ? { gridColumnRatio: normalizeSplitRatio(ratio) }
          : { gridRowRatio: normalizeSplitRatio(ratio) },
      ),
    setColumnRatio: (count, index, ratio) =>
      commit((state) => ({
        columnWidths: { ...state.columnWidths, [count]: resizeColumnWidths(state.columnWidths[count], index, ratio) },
      })),
    setAgentPanePosition: (position) =>
      commit((state) => {
        if (state.activeTabId === 'settings' && state.settingsReturn) {
          const { paneIds, focusedPane } = state.settingsReturn
          return { settingsReturn: orderMixed(state.tabs, paneIds, focusedPane, position), agentPanePosition: position }
        }
        return { ...orderMixed(state.tabs, state.paneIds, state.focusedPane, position), agentPanePosition: position }
      }),

    toggleSidebar: () => commit((state) => ({ sidebarOpen: !state.sidebarOpen })),
    setSidebarOpen: (open) => commit(() => ({ sidebarOpen: open })),
    setSidebarTab: (tab) => commit(() => ({ sidebarTab: tab, sidebarOpen: true })),
    setSidebarWidth: (width) => commit(() => ({ sidebarWidth: clamp(width, SIDEBAR_MIN, SIDEBAR_MAX) })),

    toggleTerminal: () => commit((state) => ({ terminalOpen: !state.terminalOpen })),
    setTerminalOpen: (open) => commit(() => ({ terminalOpen: open })),
    setTerminalHeight: (height) => commit(() => ({ terminalHeight: clamp(height, TERMINAL_MIN, TERMINAL_MAX) })),
    toggleTerminalMaximized: () => set((state) => ({ terminalMaximized: !state.terminalMaximized })),

    addTerminal: () =>
      commit((state) => {
        const nextNum =
          state.terminals.reduce((max, t) => {
            const match = t.id.match(/^term-(\d+)$/)
            return match ? Math.max(max, Number(match[1])) : max
          }, 0) + 1
        const created: TerminalTab = { id: `term-${nextNum}`, title: `终端 ${nextNum}` }
        return {
          terminals: [...state.terminals, created],
          activeTerminalId: created.id,
          terminalOpen: true,
        }
      }),

    closeTerminal: (id) =>
      commit((state) => {
        if (state.terminals.length <= 1) {
          return { terminalOpen: false }
        }
        const index = state.terminals.findIndex((t) => t.id === id)
        if (index === -1) return {}
        const terminals = state.terminals.filter((t) => t.id !== id)
        const activeTerminalId =
          state.activeTerminalId === id ? terminals[Math.min(index, terminals.length - 1)].id : state.activeTerminalId
        return { terminals, activeTerminalId }
      }),

    setActiveTerminal: (id) =>
      commit((state) => (state.terminals.some((t) => t.id === id) ? { activeTerminalId: id, terminalOpen: true } : {})),

    toggleInspector: () => commit((state) => ({ inspectorOpen: !state.inspectorOpen })),
    setInspectorOpen: (open) => commit(() => ({ inspectorOpen: open })),

    setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
    resetWorkbench: () => {
      const fresh = defaultState()
      savePersisted(fresh)
      set({ ...fresh, terminalMaximized: false, commandPaletteOpen: false })
    },
  }
})
