import { create } from 'zustand'
import type { ProviderId, SessionStatus } from '@vibemobile/protocol'
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

export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 272

export const TERMINAL_MIN = 150
export const TERMINAL_MAX = 560
export const TERMINAL_DEFAULT = 260

interface TabSelection {
  activeTabId: string | null
  secondaryTabId: string | null
}

interface PersistedWorkbench extends TabSelection {
  tabs: WorkbenchTab[]
  splitEnabled: boolean
  splitRatio: number | null
  agentSplitRatio: number | null
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

function defaultTerminal(): TerminalTab {
  return { id: 'term-1', title: '终端 1' }
}

function defaultState(): PersistedWorkbench {
  const first = defaultTerminal()
  return {
    tabs: [],
    activeTabId: null,
    secondaryTabId: null,
    splitEnabled: false,
    splitRatio: null,
    agentSplitRatio: null,
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
    const active = tabs.find((tab) => tab.id === parsed.activeTabId) ?? tabs[0]
    const secondaryTabId = parsed.splitEnabled
      ? (tabs.find((tab) => tab.id === parsed.secondaryTabId && tab.id !== active?.id && tab.kind !== 'settings')?.id ??
        null)
      : null
    const settingsReturn =
      active?.kind === 'settings'
        ? restoreSelection(tabs, parsed.settingsReturn ?? { activeTabId: secondaryTabId, secondaryTabId: null })
        : null
    return {
      tabs,
      ...tabSelection(active?.id ?? null, active?.kind === 'settings' ? null : secondaryTabId),
      splitRatio: normalizeSplitRatio(parsed.splitRatio),
      agentSplitRatio: normalizeSplitRatio(parsed.agentSplitRatio),
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
    splitEnabled: s.splitEnabled,
    splitRatio: s.splitRatio,
    agentSplitRatio: s.agentSplitRatio,
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
    opts?: { inSecondary?: boolean },
  ) => void
  openFileTab: (file: { path: string; title?: string; line?: number }, opts?: { inSecondary?: boolean }) => void
  openDiffTab: (diff?: { path?: string; title?: string }, opts?: { inSecondary?: boolean }) => void
  openSettingsTab: () => void
  updateChatTabMeta: (threadId: string, meta: { title?: string; provider?: ProviderId; status?: SessionStatus }) => void
  closeTab: (id: string) => void
  closeAllTabs: (id: string) => void
  setActiveTab: (id: string) => void
  setSecondaryTab: (id: string | null) => void
  toggleSplit: () => void
  setSplitRatio: (ratio: number | null, mixed?: boolean) => void
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

function tabSelection(activeTabId: string | null, secondaryTabId: string | null = null) {
  return { activeTabId, secondaryTabId, splitEnabled: secondaryTabId !== null }
}

function samePane(a: WorkbenchTab, b: WorkbenchTab): boolean {
  return (a.kind === 'chat') === (b.kind === 'chat')
}

function restoreSelection(tabs: WorkbenchTab[], selection: TabSelection | null): TabSelection | null {
  const workspaceTabs = tabs.filter((tab) => tab.kind !== 'settings')
  if (!workspaceTabs.length) return null
  const active = workspaceTabs.find((tab) => tab.id === selection?.activeTabId)
  const secondary = workspaceTabs.find((tab) => tab.id === selection?.secondaryTabId && tab.id !== active?.id)
  return {
    activeTabId: active?.id ?? secondary?.id ?? workspaceTabs.at(-1)?.id ?? null,
    secondaryTabId: active ? (secondary?.id ?? null) : null,
  }
}

function selectTab(state: WorkbenchState, tab: WorkbenchTab, inSecondary = false): Partial<WorkbenchState> {
  const previous = state.tabs.find((candidate) => candidate.id === state.activeTabId)
  if (tab.kind === 'settings') {
    return {
      ...tabSelection(tab.id),
      settingsReturn: previous?.kind === 'settings' ? state.settingsReturn : restoreSelection(state.tabs, state),
    }
  }

  const current = previous?.kind === 'settings' ? state.settingsReturn : state
  const active = state.tabs.find((candidate) => candidate.id === current?.activeTabId && candidate.kind !== 'settings')
  const secondary = state.tabs.find(
    (candidate) => candidate.id === current?.secondaryTabId && candidate.kind !== 'settings',
  )
  if (!active || active.id === tab.id) return { ...tabSelection(tab.id, secondary?.id), settingsReturn: null }

  const crossesPane = !samePane(active, tab)
  const mixedSplit = secondary && !samePane(active, secondary)
  if (inSecondary && (crossesPane || !mixedSplit)) {
    return { ...tabSelection(active.id, tab.id), settingsReturn: null }
  }

  const companion = crossesPane || secondary?.id === tab.id ? active : secondary
  return { ...tabSelection(tab.id, companion?.id), settingsReturn: null }
}

function openOrFocusTab(state: WorkbenchState, tab: WorkbenchTab, inSecondary?: boolean): Partial<WorkbenchState> {
  const exists = state.tabs.some((t) => t.id === tab.id)
  const tabs = exists ? state.tabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t)) : [...state.tabs, tab]
  return { tabs, ...selectTab(state, tab, inSecondary) }
}

function selectionAfterClose(tabs: WorkbenchTab[], index: number, current: TabSelection) {
  const closed = tabs[index]
  const neighbors = [...tabs.slice(index + 1), ...tabs.slice(0, index).reverse()]
  const active = current.activeTabId === closed.id
  const companionId = active ? current.secondaryTabId : current.activeTabId
  const next = neighbors.find((tab) => tab.id !== companionId && tab.kind !== 'settings' && samePane(closed, tab))
  if (active) {
    if (next) return tabSelection(next.id, companionId)
    return tabSelection(companionId ?? neighbors.find((tab) => tab.kind !== 'settings')?.id ?? neighbors[0]?.id ?? null)
  }
  return tabSelection(current.activeTabId, current.secondaryTabId === closed.id ? next?.id : current.secondaryTabId)
}

export const useWorkbenchStore = create<WorkbenchState>((set) => {
  const initial = loadPersisted()

  const commit = (updater: (state: WorkbenchState) => Partial<WorkbenchState>) => {
    set((state) => {
      const patch = updater(state)
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
          opts?.inSecondary,
        )
      }),

    openFileTab: ({ path, title, line }, opts) =>
      commit((state) => {
        const id = `file:${path}`
        const name = title || path.split(/[\\/]/).filter(Boolean).pop() || path
        return openOrFocusTab(state, { id, kind: 'file', path, title: name, line }, opts?.inSecondary)
      }),

    openDiffTab: (diff, opts) =>
      commit((state) => {
        const path = diff?.path
        const id = `diff:${path ?? 'workspace'}`
        const title = diff?.title || (path ? `改动 · ${path.split(/[\\/]/).pop()}` : '工作区改动')
        return openOrFocusTab(state, { id, kind: 'diff', path, title }, opts?.inSecondary)
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
              ...tabSelection(previous?.activeTabId ?? null, previous?.secondaryTabId),
              settingsReturn: null,
            }
          }
          const next = state.settingsReturn && selectionAfterClose(state.tabs, index, state.settingsReturn)
          return { tabs, settingsReturn: restoreSelection(tabs, next) }
        }
        return { tabs, ...selectionAfterClose(state.tabs, index, state) }
      }),

    closeAllTabs: (id) =>
      commit((state) => {
        const target = state.tabs.find((tab) => tab.id === id)
        if (!target || target.kind === 'settings') return {}
        const tabs = state.tabs.filter((tab) => tab.kind === 'settings' || !samePane(target, tab))
        if (state.activeTabId === 'settings') {
          return { tabs, settingsReturn: restoreSelection(tabs, state.settingsReturn) }
        }
        const selection = restoreSelection(tabs, state)
        return {
          tabs,
          ...tabSelection(selection?.activeTabId ?? tabs[0]?.id ?? null, selection?.secondaryTabId),
          settingsReturn: null,
        }
      }),

    setActiveTab: (id) =>
      commit((state) => {
        if (id === state.activeTabId) return {}
        const tab = state.tabs.find((candidate) => candidate.id === id)
        return tab ? selectTab(state, tab) : {}
      }),

    setSecondaryTab: (id) =>
      commit((state) => {
        if (id === null) return tabSelection(state.activeTabId)
        if (!state.activeTabId || state.activeTabId === 'settings' || state.activeTabId === id) return {}
        const tab = state.tabs.find((candidate) => candidate.id === id && candidate.kind !== 'settings')
        return tab ? selectTab(state, tab, true) : {}
      }),

    toggleSplit: () =>
      commit((state) => {
        if (state.splitEnabled) return tabSelection(state.activeTabId)
        const active = state.tabs.find((tab) => tab.id === state.activeTabId)
        if (!active || active.kind === 'settings') return {}
        const candidates = state.tabs.filter((tab) => tab.id !== active.id && tab.kind !== 'settings').reverse()
        const companion = candidates.find((tab) => !samePane(active, tab)) ?? candidates[0]
        return companion ? tabSelection(active.id, companion.id) : {}
      }),

    setSplitRatio: (ratio, mixed) => {
      const value = normalizeSplitRatio(ratio)
      commit(() => (mixed ? { agentSplitRatio: value } : { splitRatio: value }))
    },
    setAgentPanePosition: (position) => commit(() => ({ agentPanePosition: position })),

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
