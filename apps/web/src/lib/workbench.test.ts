import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_MAX, SIDEBAR_MIN, TERMINAL_MAX, TERMINAL_MIN, useWorkbenchStore } from './workbench'

describe('useWorkbenchStore', () => {
  beforeEach(() => {
    useWorkbenchStore.getState().resetWorkbench()
  })

  it('opens and deduplicates chat, file, diff, and settings tabs', () => {
    const store = useWorkbenchStore.getState()
    store.openChatTab({ threadId: 't1', title: 'Fix bug', provider: 'codex' })
    store.openFileTab({ path: '/repo/src/App.tsx' })
    store.openDiffTab()
    store.openSettingsTab()
    // Re-opening existing chat focuses it without duplicating.
    store.openChatTab({ threadId: 't1', title: 'Fix bug (updated)' })

    const state = useWorkbenchStore.getState()
    expect(state.tabs).toHaveLength(4)
    expect(state.activeTabId).toBe('chat:t1')
    expect(state.tabs[0].title).toBe('Fix bug (updated)')
  })

  it('supports split view and prevents mirroring the same tab', () => {
    const store = useWorkbenchStore.getState()
    store.openChatTab({ threadId: 't1', title: 'Agent A' })
    store.openFileTab({ path: '/repo/README.md' }, { inSecondary: true })

    let state = useWorkbenchStore.getState()
    expect(state.splitEnabled).toBe(true)
    expect(state.activeTabId).toBe('chat:t1')
    expect(state.secondaryTabId).toBe('file:/repo/README.md')

    // Closing secondary disables split cleanly.
    store.closeTab('file:/repo/README.md')
    state = useWorkbenchStore.getState()
    expect(state.splitEnabled).toBe(false)
    expect(state.secondaryTabId).toBeNull()
  })

  it('restores pane order and independent split ratios, including both endpoints', async () => {
    const saved = new Map([['vibemobile.workbench.v1', JSON.stringify({ sidebarWidth: 350 })]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    })

    try {
      vi.resetModules()
      const { useWorkbenchStore: legacy } = await import('./workbench')
      expect(legacy.getState()).toMatchObject({
        sidebarWidth: 350,
        splitRatio: null,
        agentSplitRatio: null,
        agentPanePosition: 'start',
      })

      legacy.getState().setSplitRatio(0)
      legacy.getState().setSplitRatio(1, true)
      legacy.getState().setAgentPanePosition('end')

      vi.resetModules()
      const { useWorkbenchStore: restored } = await import('./workbench')
      expect(restored.getState()).toMatchObject({
        sidebarWidth: 350,
        splitRatio: 0,
        agentSplitRatio: 1,
        agentPanePosition: 'end',
      })

      restored.getState().setSplitRatio(Number.NaN)
      expect(restored.getState()).toMatchObject({ splitRatio: null, agentSplitRatio: 1 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('automatically pairs a chat with a file and maintains selections by pane', () => {
    const store = useWorkbenchStore.getState()
    store.openChatTab({ threadId: 't1' })
    store.openFileTab({ path: '/repo/a.ts' })
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeTabId: 'file:/repo/a.ts',
      secondaryTabId: 'chat:t1',
      splitEnabled: true,
    })

    store.openChatTab({ threadId: 't2' }, { inSecondary: true })
    store.setActiveTab('chat:t2')
    store.openFileTab({ path: '/repo/b.ts', line: 7 }, { inSecondary: true })
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeTabId: 'chat:t2',
      secondaryTabId: 'file:/repo/b.ts',
      splitEnabled: true,
    })

    store.openChatTab({ threadId: 't3' }, { inSecondary: true })
    store.openDiffTab({ path: '/repo/b.ts' })
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeTabId: 'diff:/repo/b.ts',
      secondaryTabId: 'chat:t3',
      splitEnabled: true,
    })
  })

  it('fills closed tabs from their own pane and restores both panes after Settings', () => {
    const store = useWorkbenchStore.getState()
    store.openChatTab({ threadId: 't1' })
    store.openChatTab({ threadId: 't2' })
    store.openFileTab({ path: '/repo/a.ts' })
    store.openFileTab({ path: '/repo/b.ts' })
    store.closeTab('file:/repo/b.ts')
    store.closeTab('chat:t2')
    store.openSettingsTab()
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeTabId: 'settings',
      secondaryTabId: null,
      splitEnabled: false,
    })

    store.closeTab('settings')
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeTabId: 'file:/repo/a.ts',
      secondaryTabId: 'chat:t1',
      splitEnabled: true,
    })
  })

  it('closes only the selected group of workbench tabs and updates the saved selection', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    })

    try {
      const store = useWorkbenchStore.getState()
      store.openChatTab({ threadId: 't1' })
      store.openChatTab({ threadId: 't2' })
      store.openFileTab({ path: '/repo/a.ts' })
      store.openDiffTab()
      store.openSettingsTab()
      store.addTerminal()
      store.setSidebarTab('files')
      store.setAgentPanePosition('end')

      expect(useWorkbenchStore.getState().settingsReturn).not.toBeNull()
      store.closeAllTabs('diff:workspace')
      expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual(['chat:t1', 'chat:t2', 'settings'])
      expect(useWorkbenchStore.getState().settingsReturn).toEqual({ activeTabId: 'chat:t2', secondaryTabId: null })
      store.closeTab('settings')
      expect(useWorkbenchStore.getState().activeTabId).toBe('chat:t2')
      store.closeAllTabs('chat:t1')

      const result = {
        tabs: [],
        activeTabId: null,
        secondaryTabId: null,
        splitEnabled: false,
        settingsReturn: null,
        sidebarTab: 'files',
        agentPanePosition: 'end',
        activeTerminalId: 'term-2',
        terminalOpen: true,
      }
      expect(useWorkbenchStore.getState()).toMatchObject(result)
      expect(useWorkbenchStore.getState().terminals).toHaveLength(2)
      expect(JSON.parse(saved.get('vibemobile.workbench.v1') ?? '{}')).toMatchObject(result)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the selected editor when closing all Agent tabs, even from an inactive tab', () => {
    const store = useWorkbenchStore.getState()
    store.openChatTab({ threadId: 't1' })
    store.openChatTab({ threadId: 't2' })
    store.openFileTab({ path: '/repo/a.ts' })
    store.openFileTab({ path: '/repo/b.ts' })
    store.closeAllTabs('chat:t1')
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeTabId: 'file:/repo/b.ts',
      secondaryTabId: null,
      splitEnabled: false,
    })
    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual(['file:/repo/a.ts', 'file:/repo/b.ts'])
  })

  it('promotes the remaining Agent when closing all files in a mixed split', () => {
    const store = useWorkbenchStore.getState()
    store.openChatTab({ threadId: 't1' })
    store.openFileTab({ path: '/repo/a.ts' })
    store.openDiffTab()
    store.closeAllTabs('file:/repo/a.ts')
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeTabId: 'chat:t1',
      secondaryTabId: null,
      splitEnabled: false,
    })
    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual(['chat:t1'])
  })

  it('swaps the split panes when reopening the secondary tab and promotes it when closing the primary', () => {
    const store = useWorkbenchStore.getState()
    store.openChatTab({ threadId: 't1' })
    store.openChatTab({ threadId: 't2' }, { inSecondary: true })
    store.openChatTab({ threadId: 't2' })

    expect(useWorkbenchStore.getState()).toMatchObject({
      activeTabId: 'chat:t2',
      secondaryTabId: 'chat:t1',
      splitEnabled: true,
    })

    store.closeTab('chat:t2')
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeTabId: 'chat:t1',
      secondaryTabId: null,
      splitEnabled: false,
    })
  })

  it('manages multiple terminal tabs and clamps panel sizes', () => {
    const store = useWorkbenchStore.getState()
    store.addTerminal()
    store.addTerminal()

    let state = useWorkbenchStore.getState()
    expect(state.terminals).toHaveLength(3)
    expect(state.activeTerminalId).toBe('term-3')
    expect(state.terminalOpen).toBe(true)

    store.closeTerminal('term-3')
    state = useWorkbenchStore.getState()
    expect(state.terminals).toHaveLength(2)
    expect(state.activeTerminalId).toBe('term-2')

    store.setSidebarWidth(999)
    expect(useWorkbenchStore.getState().sidebarWidth).toBe(SIDEBAR_MAX)
    store.setSidebarWidth(10)
    expect(useWorkbenchStore.getState().sidebarWidth).toBe(SIDEBAR_MIN)

    store.setTerminalHeight(999)
    expect(useWorkbenchStore.getState().terminalHeight).toBe(TERMINAL_MAX)
    store.setTerminalHeight(10)
    expect(useWorkbenchStore.getState().terminalHeight).toBe(TERMINAL_MIN)
  })
})
