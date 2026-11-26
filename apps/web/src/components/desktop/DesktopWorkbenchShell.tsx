import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Bot,
  Columns2,
  Files as FilesIcon,
  FolderOpen,
  GitBranch,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings as SettingsIcon,
  Terminal as TerminalIcon,
} from 'lucide-react'
import type { SessionStatus, SessionSummary } from '@vibemobile/protocol'
import RunnerSelector from '../RunnerSelector'
import UpdateBanner from '../UpdateBanner'
import { SheetPresentation } from '../Sheet'
import { SIDEBAR_MAX, SIDEBAR_MIN, useWorkbenchStore, type WorkbenchTab } from '../../lib/workbench'
import { pathAfterScope } from '../../lib/runner'
import { api } from '../../lib/api'
import { socket } from '../../lib/ws'
import { useDocumentTitle } from '../../lib/title'
import { shortPath } from '../../lib/format'
import { useWorkspaceStore } from '../../lib/workspace'
import { useApprovalStore } from '../../lib/approvals'
import type { FileRef } from '../../lib/fileLink'
import WorkbenchTabs from './WorkbenchTabs'
import WorkbenchSplitDivider from './WorkbenchSplitDivider'
import TerminalDrawer from './TerminalDrawer'
import InspectorPane from './InspectorPane'
import CommandPalette from './CommandPalette'
import DesktopAgentSidebar from './DesktopAgentSidebar'
import DesktopFileSidebar from './DesktopFileSidebar'
import './workbench.css'

const Chat = lazy(() => import('../../pages/Chat'))
const Files = lazy(() => import('../../pages/Files'))
const Settings = lazy(() => import('../../pages/Settings'))
// Keep recently visited panes warm without retaining every transcript and file DOM.
const MAX_MOUNTED_CHATS = 5
const MAX_MOUNTED_FILES = 3

function PaneFallback() {
  return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">加载中…</div>
}

function EmptyWorkbench({
  workspace,
  actions,
}: {
  workspace: string
  actions: { label: string; icon: ReactNode; run: () => void; key?: string; disabled?: boolean }[]
}) {
  return (
    <div className="grid h-full place-items-center overflow-y-auto px-7 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center gap-3.5">
          <div className="grid size-11 shrink-0 place-items-center rounded-[12px] border border-primary/20 bg-primary/8 text-primary">
            <FolderOpen className="size-5" strokeWidth={1.6} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[22px] leading-tight font-semibold tracking-tight">
              {workspace.split(/[\\/]/).filter(Boolean).at(-1) || 'VibeMobile'}
            </h1>
            {workspace && (
              <p title={workspace} className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {shortPath(workspace, 3)}
              </p>
            )}
          </div>
        </div>
        <div className="divide-y divide-border rounded-xl border border-border bg-card/55">
          {actions.map(({ label, icon, run, key, disabled }) => (
            <button
              type="button"
              onClick={run}
              disabled={disabled}
              key={label}
              className="flex min-h-11 w-full items-center gap-3 px-3.5 text-left text-[13px] first:rounded-t-xl last:rounded-b-xl hover:bg-secondary focus-visible:bg-secondary disabled:opacity-45"
            >
              <span className="text-primary">{icon}</span>
              <span className="flex-1">{label}</span>
              {key ? (
                <kbd className="workbench-key">{key}</kbd>
              ) : (
                <ArrowRight className="size-3.5 text-muted-foreground" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ChromeButton({
  label,
  shortcut,
  active,
  onClick,
  disabled,
  children,
}: {
  label: string
  shortcut?: string
  active?: boolean
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className="workbench-icon"
    >
      {children}
    </button>
  )
}

const WorkbenchPane = memo(function WorkbenchPane({
  tab,
  split,
  visible,
  onLogout,
  onSelectSessionId,
}: {
  tab: WorkbenchTab
  split: boolean
  visible: boolean
  onLogout: () => void
  onSelectSessionId: (id: string) => void
}) {
  const openFileTab = useWorkbenchStore((s) => s.openFileTab)
  const openDiffTab = useWorkbenchStore((s) => s.openDiffTab)
  const updateChatTabMeta = useWorkbenchStore((s) => s.updateChatTabMeta)
  const closeTab = useWorkbenchStore((s) => s.closeTab)
  const setSidebarTab = useWorkbenchStore((s) => s.setSidebarTab)
  const threadId = tab.kind === 'chat' ? tab.threadId : undefined
  const path = tab.kind === 'file' || tab.kind === 'diff' ? tab.path : undefined
  const fileName = tab.kind === 'file' ? tab.title : undefined
  const fixedView = useMemo(() => {
    if (path !== undefined && fileName !== undefined) return { kind: 'file' as const, path, name: fileName }
    if (tab.kind === 'diff') return { kind: 'diff' as const, path }
    return undefined
  }, [path, fileName, tab.kind])
  const handleSessionMeta = useCallback(
    (session: SessionSummary, status: SessionStatus) => {
      updateChatTabMeta(session.id, { title: session.title || '对话', provider: session.provider, status })
    },
    [updateChatTabMeta],
  )
  const openChatFile = useCallback(
    (ref: FileRef) => openFileTab({ path: ref.path, line: ref.line ?? undefined }, { inSecondary: true }),
    [openFileTab],
  )
  const exitChat = useCallback(() => {
    closeTab(tab.id)
    setSidebarTab('agents')
  }, [closeTab, setSidebarTab, tab.id])

  return (
    <Suspense fallback={<PaneFallback />}>
      {threadId ? (
        <Chat
          threadId={threadId}
          embedded
          visible={visible}
          showPaneTitle={split}
          onSessionMeta={handleSessionMeta}
          onOpenFileTab={openChatFile}
          onSelectSession={onSelectSessionId}
          onExit={exitChat}
        />
      ) : fixedView ? (
        <Files
          embedded
          visible={visible}
          fixedView={fixedView}
          line={tab.kind === 'file' ? tab.line : undefined}
          onOpenFileTab={(path, title, line) => openFileTab({ path, title, line })}
          onOpenDiffTab={(filePath) => openDiffTab({ path: filePath })}
        />
      ) : (
        <Settings onLogout={onLogout} embedded />
      )}
    </Suspense>
  )
})

export default function DesktopWorkbenchShell({ onLogout }: { onLogout: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const workspace = useWorkspaceStore((s) => s.defaultCwd)
  const projects = useWorkspaceStore((s) => s.projects)
  const pendingApprovals = useApprovalStore((s) => s.pending.length)

  const tabs = useWorkbenchStore((s) => s.tabs)
  const activeTabId = useWorkbenchStore((s) => s.activeTabId)
  const secondaryTabId = useWorkbenchStore((s) => s.secondaryTabId)
  const splitEnabled = useWorkbenchStore((s) => s.splitEnabled)
  const sidebarOpen = useWorkbenchStore((s) => s.sidebarOpen)
  const sidebarTab = useWorkbenchStore((s) => s.sidebarTab)
  const sidebarWidth = useWorkbenchStore((s) => s.sidebarWidth)
  const terminalOpen = useWorkbenchStore((s) => s.terminalOpen)
  const inspectorOpen = useWorkbenchStore((s) => s.inspectorOpen)
  const commandPaletteOpen = useWorkbenchStore((s) => s.commandPaletteOpen)

  const openChatTab = useWorkbenchStore((s) => s.openChatTab)
  const openFileTab = useWorkbenchStore((s) => s.openFileTab)
  const openDiffTab = useWorkbenchStore((s) => s.openDiffTab)
  const openSettingsTab = useWorkbenchStore((s) => s.openSettingsTab)
  const closeTab = useWorkbenchStore((s) => s.closeTab)
  const setActiveTab = useWorkbenchStore((s) => s.setActiveTab)
  const closeAllTabs = useWorkbenchStore((s) => s.closeAllTabs)
  const toggleSplit = useWorkbenchStore((s) => s.toggleSplit)
  const toggleSidebar = useWorkbenchStore((s) => s.toggleSidebar)
  const setSidebarTab = useWorkbenchStore((s) => s.setSidebarTab)
  const setSidebarWidth = useWorkbenchStore((s) => s.setSidebarWidth)
  const toggleTerminal = useWorkbenchStore((s) => s.toggleTerminal)
  const setTerminalOpen = useWorkbenchStore((s) => s.setTerminalOpen)
  const toggleInspector = useWorkbenchStore((s) => s.toggleInspector)
  const setCommandPaletteOpen = useWorkbenchStore((s) => s.setCommandPaletteOpen)
  const splitRatio = useWorkbenchStore((s) => s.splitRatio)
  const agentSplitRatio = useWorkbenchStore((s) => s.agentSplitRatio)
  const agentPanePosition = useWorkbenchStore((s) => s.agentPanePosition)
  const setSplitRatio = useWorkbenchStore((s) => s.setSplitRatio)

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [connection, setConnection] = useState(socket.state)
  const [creatingSession, setCreatingSession] = useState(false)
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)
  const [filesVisited, setFilesVisited] = useState(sidebarTab === 'files')
  const [recentPaneIds, setRecentPaneIds] = useState<string[]>([])
  const sidebarDrag = useRef<{ x: number; width: number } | null>(null)
  const editorRef = useRef<HTMLElement>(null)
  const handledLocation = useRef<string | null>(null)
  const pendingPath = useRef<string | null>(null)
  const previousTabId = useRef(activeTabId)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const secondaryTab =
    splitEnabled && activeTab?.kind !== 'settings'
      ? tabs.find((tab) => tab.id === secondaryTabId && tab.kind !== 'settings')
      : undefined
  const visibleAgent = activeTab?.kind === 'chat' ? activeTab : secondaryTab?.kind === 'chat' ? secondaryTab : undefined
  const mixedSplit = Boolean(
    activeTab && secondaryTab && (activeTab.kind === 'chat') !== (secondaryTab.kind === 'chat'),
  )
  const savedRatio = mixedSplit ? agentSplitRatio : splitRatio
  const ratioPaneFirst = mixedSplit && agentPanePosition === 'start'
  const filePane = activeTab?.kind === 'chat' ? secondaryTab : activeTab
  const visibleTabs = mixedSplit
    ? ratioPaneFirst
      ? [visibleAgent, filePane]
      : [filePane, visibleAgent]
    : [activeTab, secondaryTab]
  const retainedPaneIds = useMemo(() => {
    const open = new Map(tabs.map((tab) => [tab.id, tab.kind]))
    const retained: string[] = []
    let chats = 0
    let files = 0
    for (const id of new Set([activeTabId, secondaryTab?.id, ...recentPaneIds])) {
      if (!id) continue
      const kind = open.get(id)
      if (kind === 'chat' && chats < MAX_MOUNTED_CHATS) {
        retained.push(id)
        chats += 1
      } else if (kind === 'file' && files < MAX_MOUNTED_FILES) {
        retained.push(id)
        files += 1
      }
    }
    return retained
  }, [activeTabId, secondaryTab?.id, recentPaneIds, tabs])
  const cachedTabs = tabs.filter(
    (tab) => retainedPaneIds.includes(tab.id) && tab.id !== activeTabId && tab.id !== secondaryTab?.id,
  )
  const mixedBefore = useRef(mixedSplit)
  const canSplit = activeTab?.kind !== 'settings' && tabs.filter((tab) => tab.kind !== 'settings').length >= 2
  const activeFile = activeTab?.kind === 'file' ? activeTab : secondaryTab?.kind === 'file' ? secondaryTab : undefined
  const needsSessions = commandPaletteOpen || inspectorOpen
  const mod = /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘' : 'Ctrl+'
  useDocumentTitle(activeTab?.title || '工作台')

  useEffect(() => socket.onState(setConnection), [])

  useEffect(() => {
    if (
      retainedPaneIds.length !== recentPaneIds.length ||
      retainedPaneIds.some((id, index) => id !== recentPaneIds[index])
    ) {
      setRecentPaneIds(retainedPaneIds)
    }
  }, [recentPaneIds, retainedPaneIds])

  useEffect(() => {
    if (activeTab?.kind === 'settings') return
    if (mixedSplit && !mixedBefore.current && sidebarOpen) setSidebarTab('files')
    mixedBefore.current = mixedSplit
  }, [activeTab?.kind, mixedSplit, sidebarOpen, setSidebarTab])

  const openPalette = useCallback(() => setCommandPaletteOpen(true), [setCommandPaletteOpen])
  const showFiles = useCallback(() => setSidebarTab('files'), [setSidebarTab])
  const createSession = useCallback(() => {
    if (!projects.length) return
    setSidebarTab('agents')
    setCreatingSession(true)
  }, [projects.length, setSidebarTab])
  const focusComposer = useCallback(() => {
    editorRef.current?.querySelector<HTMLTextAreaElement>('[data-workbench-composer]')?.focus()
  }, [])
  const handleCloseAllTabs = useCallback(() => {
    closeAllTabs()
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
  }, [closeAllTabs])

  const previewSplitRatio = useCallback((ratio: number | null) => {
    const style = editorRef.current?.style
    if (ratio === null) style?.removeProperty('--workbench-live-ratio')
    else style?.setProperty('--workbench-live-ratio', String(ratio))
  }, [])

  useEffect(() => {
    const path = pathAfterScope(location.pathname)
    const tabChanged = previousTabId.current !== activeTabId
    previousTabId.current = activeTabId

    if (handledLocation.current !== location.key) {
      handledLocation.current = location.key
      const fromWorkbench = pendingPath.current === path
      pendingPath.current = null
      if (fromWorkbench) return

      const chatPath = /^\/chat\/([^/]+)\/?$/.exec(path)
      if (chatPath) {
        try {
          openChatTab({ threadId: decodeURIComponent(chatPath[1]) })
        } catch {
          openChatTab({ threadId: chatPath[1] })
        }
      } else if (path === '/files') {
        setSidebarTab('files')
      } else if (path === '/terminal') {
        setTerminalOpen(true)
      } else if (path === '/settings') {
        openSettingsTab()
      }
      return
    }

    if (!tabChanged) return
    let nextPath = '/'
    if (activeTab?.kind === 'chat') nextPath = `/chat/${encodeURIComponent(activeTab.threadId)}`
    else if (activeTab?.kind === 'settings') nextPath = '/settings'
    else if (activeTab) nextPath = '/files'
    if (nextPath === path) return
    pendingPath.current = nextPath
    navigate(nextPath, { replace: true })
  }, [
    activeTab,
    activeTabId,
    location.key,
    location.pathname,
    navigate,
    openChatTab,
    openSettingsTab,
    setSidebarTab,
    setTerminalOpen,
  ])

  useEffect(() => {
    if (sidebarTab === 'files') setFilesVisited(true)
  }, [sidebarTab])

  useEffect(() => {
    if (!needsSessions) return
    let cancelled = false
    const statuses = new Map<string, SessionSummary['status']>()
    const unsubscribe = socket.onEvent((event) => {
      if (event.kind !== 'session.status') return
      statuses.set(event.threadId, event.status)
      setSessions((current) =>
        current.map((session) => (session.id === event.threadId ? { ...session, status: event.status } : session)),
      )
    })
    void api
      .sessions({ provider: 'all', limit: 80 })
      .then(({ data }) => {
        if (cancelled) return
        setSessions(data.map((session) => ({ ...session, status: statuses.get(session.id) ?? session.status })))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [needsSessions])

  // Global macOS / IDE keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.defaultPrevented || event.isComposing || event.altKey) return

      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        setCommandPaletteOpen(!useWorkbenchStore.getState().commandPaletteOpen)
      } else if (key === 'l' && event.shiftKey) {
        event.preventDefault()
        focusComposer()
      } else if (key === 'b') {
        event.preventDefault()
        toggleSidebar()
      } else if (key === 'j') {
        event.preventDefault()
        toggleTerminal()
      } else if (key === '\\') {
        event.preventDefault()
        toggleSplit()
      } else if (key === 'i' && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        toggleInspector()
      } else if (key === 'w' && !event.shiftKey) {
        const current = useWorkbenchStore.getState().activeTabId
        if (current) {
          event.preventDefault()
          closeTab(current)
        }
      } else if (key >= '1' && key <= '9') {
        const idx = Number(key) - 1
        const target = useWorkbenchStore.getState().tabs[idx]
        if (target) {
          event.preventDefault()
          setActiveTab(target.id)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    setCommandPaletteOpen,
    toggleSidebar,
    toggleTerminal,
    toggleSplit,
    toggleInspector,
    closeTab,
    setActiveTab,
    focusComposer,
  ])

  const handleSelectSession = useCallback(
    (session: SessionSummary) => {
      openChatTab({
        threadId: session.id,
        title: session.title || '对话',
        provider: session.provider,
        status: session.status,
      })
    },
    [openChatTab],
  )

  const handleSelectSessionId = useCallback((id: string) => openChatTab({ threadId: id }), [openChatTab])

  const handleSplitSession = useCallback(
    (session: SessionSummary) => {
      openChatTab(
        { threadId: session.id, title: session.title, provider: session.provider, status: session.status },
        {
          inSecondary: true,
        },
      )
    },
    [openChatTab],
  )

  return (
    <div
      ref={setPortalContainer}
      className="desktop-workbench app-height flex flex-col overflow-hidden bg-background text-foreground"
    >
      <SheetPresentation centered container={portalContainer}>
        <UpdateBanner />
        <header className="grid h-[47px] shrink-0 grid-cols-[minmax(0,1fr)_minmax(230px,410px)_minmax(0,1fr)] items-center gap-3 border-b border-border bg-[var(--workbench-toolbar)] px-3">
          <div className="flex min-w-0 items-center gap-2">
            <ChromeButton label="切换侧边栏" active={sidebarOpen} shortcut={mod + 'B'} onClick={toggleSidebar}>
              <PanelLeft className="size-4" strokeWidth={1.7} />
            </ChromeButton>
            <div className="hidden shrink-0 items-center gap-2 px-1 text-[13px] font-semibold tracking-tight xl:flex">
              <img src="/icon-192.png" alt="" className="size-[19px] rounded-[5px]" /> VibeMobile
            </div>
            <RunnerSelector compact workbench />
          </div>
          <button
            type="button"
            onClick={openPalette}
            aria-label="命令面板"
            className="flex h-[30px] min-w-0 items-center gap-2 rounded-lg border border-border bg-background/70 px-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-input hover:text-foreground"
          >
            <Search aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.7} />
            <span className="flex-1 truncate">搜索会话或输入命令</span>
            <kbd className="workbench-key">{mod}K</kbd>
          </button>
          <div className="flex items-center justify-end gap-1">
            <ChromeButton
              label="分屏"
              active={Boolean(secondaryTab)}
              shortcut={mod + '\\'}
              disabled={!canSplit}
              onClick={toggleSplit}
            >
              <Columns2 className="size-4" strokeWidth={1.7} />
            </ChromeButton>
            <ChromeButton label="终端抽屉" active={terminalOpen} shortcut={mod + 'J'} onClick={toggleTerminal}>
              <TerminalIcon className="size-4" strokeWidth={1.7} />
            </ChromeButton>
            <ChromeButton label="右侧检查器" active={inspectorOpen} shortcut={mod + 'I'} onClick={toggleInspector}>
              <PanelRight className="size-4" strokeWidth={1.7} />
            </ChromeButton>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <nav
            aria-label="工作区导航"
            className="flex w-[47px] shrink-0 flex-col items-center gap-2 border-r border-border bg-[var(--workbench-rail)] py-2"
          >
            <div className="relative">
              <ChromeButton
                label="会话"
                active={sidebarOpen && sidebarTab === 'agents'}
                onClick={() => setSidebarTab('agents')}
              >
                <Bot className="size-[18px]" strokeWidth={1.65} />
              </ChromeButton>
              {pendingApprovals > 0 && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 right-0 size-1.5 rounded-full bg-warning"
                />
              )}
            </div>
            <ChromeButton label="文件" active={sidebarOpen && sidebarTab === 'files'} onClick={showFiles}>
              <FilesIcon className="size-[18px]" strokeWidth={1.65} />
            </ChromeButton>
            <ChromeButton label="工作区改动" active={activeTab?.kind === 'diff'} onClick={() => openDiffTab()}>
              <GitBranch className="size-[17px]" strokeWidth={1.65} />
            </ChromeButton>
            <div className="mt-auto">
              <ChromeButton label="设置" active={activeTab?.kind === 'settings'} onClick={openSettingsTab}>
                <SettingsIcon className="size-[18px]" strokeWidth={1.65} />
              </ChromeButton>
            </div>
          </nav>

          <aside
            aria-label="工作区侧边栏"
            style={{ width: sidebarWidth }}
            className={`${sidebarOpen ? 'flex' : 'hidden'} relative shrink-0 flex-col border-r border-border bg-[var(--workbench-sidebar)]`}
          >
            <div className="flex h-[38px] shrink-0 items-center justify-between gap-2 px-3">
              <h2 className="text-xs font-semibold">{sidebarTab === 'agents' ? '会话' : '资源管理器'}</h2>
              {sidebarTab === 'agents' && (
                <span title={workspace} className="truncate font-mono text-[10px] text-muted-foreground">
                  {workspace.split(/[\\/]/).filter(Boolean).at(-1)}
                </span>
              )}
            </div>
            <div hidden={sidebarTab !== 'agents'} className="min-h-0 flex-1 overflow-hidden">
              <DesktopAgentSidebar
                activeThreadId={visibleAgent?.threadId ?? null}
                secondaryThreadId={
                  secondaryTab?.kind === 'chat' && secondaryTab.id !== visibleAgent?.id ? secondaryTab.threadId : null
                }
                creating={creatingSession}
                setCreating={setCreatingSession}
                onSelectSession={handleSelectSession}
                onSplitSession={handleSplitSession}
              />
            </div>
            <div hidden={sidebarTab !== 'files'} className="min-h-0 flex-1 overflow-hidden">
              {(filesVisited || sidebarTab === 'files') && (
                <DesktopFileSidebar
                  visible={sidebarOpen && sidebarTab === 'files'}
                  activeFilePath={activeFile?.path ?? null}
                  onOpenFile={(path, name) => openFileTab({ path, title: name })}
                  onSplitFile={(path, name) => openFileTab({ path, title: name }, { inSecondary: true })}
                  onOpenDiff={() => openDiffTab(undefined, { inSecondary: true })}
                />
              )}
            </div>
            <hr
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="调整侧边栏宽度"
              aria-valuemin={SIDEBAR_MIN}
              aria-valuemax={SIDEBAR_MAX}
              aria-valuenow={sidebarWidth}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                sidebarDrag.current = { x: event.clientX, width: sidebarWidth }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                const drag = sidebarDrag.current
                if (drag) setSidebarWidth(drag.width + event.clientX - drag.x)
              }}
              onLostPointerCapture={() => {
                sidebarDrag.current = null
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                setSidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16))
              }}
              className="absolute inset-y-0 -right-1 z-20 h-full w-2 touch-none cursor-col-resize border-0 hover:bg-primary/25 focus-visible:bg-primary/25"
            />
          </aside>

          <div className="workbench-editor flex min-w-0 flex-1 flex-col overflow-hidden">
            {tabs.length > 0 && !mixedSplit && (
              <div className="flex h-[38px] shrink-0 border-b border-border bg-[var(--workbench-toolbar)]">
                <WorkbenchTabs
                  tabs={tabs}
                  activeTabId={activeTabId}
                  secondaryTabId={secondaryTabId}
                  onSelect={setActiveTab}
                  onClose={closeTab}
                  onCloseAll={handleCloseAllTabs}
                  menuContainer={portalContainer}
                />
              </div>
            )}
            <main
              ref={editorRef}
              tabIndex={-1}
              className="workbench-panes flex min-h-0 flex-1 overflow-hidden"
              data-split={Boolean(secondaryTab)}
              data-mixed={mixedSplit}
              style={
                {
                  '--workbench-saved-ratio': savedRatio ?? undefined,
                } as CSSProperties
              }
            >
              {!activeTab && (
                <div className="min-h-0 min-w-0 flex-1">
                  <EmptyWorkbench
                    workspace={workspace}
                    actions={[
                      {
                        label: '新建会话',
                        icon: <Plus className="size-4" />,
                        run: createSession,
                        disabled: !projects.length,
                      },
                      { label: '浏览工作区文件', icon: <FolderOpen className="size-4" />, run: showFiles },
                      {
                        label: terminalOpen ? '收起终端' : '打开终端',
                        icon: <TerminalIcon className="size-4" />,
                        run: toggleTerminal,
                        key: mod + 'J',
                      },
                    ]}
                  />
                </div>
              )}
              {[...visibleTabs, ...cachedTabs].flatMap((tab, index) => {
                if (!tab) return []
                const visible = index < visibleTabs.length
                const ratioPane = mixedSplit ? tab.kind === 'chat' : index === 1
                const collapsed = visible && Boolean(secondaryTab) && savedRatio === (ratioPane ? 0 : 1)
                const pane = (
                  <section
                    key={tab.id}
                    aria-label={tab.title}
                    data-ratio-pane={ratioPane}
                    data-pane={tab.kind === 'chat' ? 'agent' : 'editor'}
                    hidden={!visible}
                    inert={!visible || collapsed}
                    className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  >
                    {visible && mixedSplit && (
                      <div className="flex h-[38px] shrink-0 border-b border-border bg-[var(--workbench-toolbar)]">
                        <WorkbenchTabs
                          tabs={tabs.filter((item) =>
                            tab.kind === 'chat' ? item.kind === 'chat' : item.kind === 'file' || item.kind === 'diff',
                          )}
                          label={tab.kind === 'chat' ? 'Agent 会话标签' : '文件标签'}
                          activeTabId={tab.id}
                          secondaryTabId={null}
                          onSelect={setActiveTab}
                          onClose={closeTab}
                          onCloseAll={handleCloseAllTabs}
                          menuContainer={portalContainer}
                        />
                      </div>
                    )}
                    <div
                      className="min-h-0 flex-1 overflow-hidden"
                      onFocusCapture={() => {
                        if (mixedSplit && activeTabId !== tab.id) setActiveTab(tab.id)
                      }}
                    >
                      <WorkbenchPane
                        tab={tab}
                        split={visible && Boolean(secondaryTab) && !mixedSplit}
                        visible={visible && !collapsed}
                        onLogout={onLogout}
                        onSelectSessionId={handleSelectSessionId}
                      />
                    </div>
                  </section>
                )
                if (index !== 1) return [pane]
                return [
                  <WorkbenchSplitDivider
                    key={mixedSplit ? `agent-divider-${agentPanePosition}` : 'compare-divider'}
                    mixed={mixedSplit}
                    ratioPaneFirst={ratioPaneFirst}
                    ratio={savedRatio}
                    onPreview={previewSplitRatio}
                    onSave={(ratio) => setSplitRatio(ratio, mixedSplit)}
                  />,
                  pane,
                ]
              })}
            </main>
            <TerminalDrawer />
          </div>

          <InspectorPane
            sessions={sessions}
            threadId={visibleAgent?.threadId}
            onSelectSession={handleSelectSession}
            onSelectSessionId={handleSelectSessionId}
          />
        </div>

        <footer className="flex h-[24px] shrink-0 items-center gap-3 border-t border-border bg-[var(--workbench-rail)] px-3 text-[11px] text-muted-foreground">
          <span className="flex shrink-0 items-center gap-1.5">
            <span
              className={`size-1.5 rounded-full ${connection === 'open' ? 'bg-success' : connection === 'connecting' ? 'bg-warning' : 'bg-destructive'}`}
            />
            {connection === 'open' ? '已连接' : connection === 'connecting' ? '连接中' : '连接中断'}
          </span>
          {workspace && (
            <span title={workspace} className="truncate font-mono">
              {shortPath(workspace, 2)}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {pendingApprovals > 0 && (
              <button
                type="button"
                onClick={() => useWorkbenchStore.getState().setInspectorOpen(true)}
                className="rounded px-1 text-warning hover:bg-secondary"
              >
                {pendingApprovals} 项待审批
              </button>
            )}
            {visibleAgent && <span className="font-mono">{visibleAgent.provider}</span>}
          </div>
        </footer>

        <CommandPalette
          sessions={sessions}
          onSelectSession={handleSelectSession}
          onCreateSession={projects.length ? createSession : undefined}
          onFocusComposer={visibleAgent ? focusComposer : undefined}
          mod={mod}
          container={portalContainer}
        />
      </SheetPresentation>
    </div>
  )
}
