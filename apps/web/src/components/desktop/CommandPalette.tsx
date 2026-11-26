import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import {
  Bot,
  Columns2,
  FolderOpen,
  GitBranch,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings,
  Terminal,
} from 'lucide-react'
import type { SessionSummary } from '@vibemobile/protocol'
import { useWorkbenchStore } from '../../lib/workbench'
import { api } from '../../lib/api'

interface CommandItem {
  id: string
  label: string
  hint?: string
  shortcut?: string
  icon: React.ReactNode
  run: () => void
}

export default function CommandPalette({
  sessions,
  onSelectSession,
  onCreateSession,
  onFocusComposer,
  mod,
  container,
}: {
  sessions: SessionSummary[]
  onSelectSession: (session: SessionSummary) => void
  onCreateSession?: () => void
  onFocusComposer?: () => void
  mod: string
  container?: HTMLElement | null
}) {
  const open = useWorkbenchStore((s) => s.commandPaletteOpen)
  const setOpen = useWorkbenchStore((s) => s.setCommandPaletteOpen)
  const toggleSidebar = useWorkbenchStore((s) => s.toggleSidebar)
  const setSidebarTab = useWorkbenchStore((s) => s.setSidebarTab)
  const toggleTerminal = useWorkbenchStore((s) => s.toggleTerminal)
  const addTerminal = useWorkbenchStore((s) => s.addTerminal)
  const toggleSplit = useWorkbenchStore((s) => s.toggleSplit)
  const toggleInspector = useWorkbenchStore((s) => s.toggleInspector)
  const openDiffTab = useWorkbenchStore((s) => s.openDiffTab)
  const openSettingsTab = useWorkbenchStore((s) => s.openSettingsTab)

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [remote, setRemote] = useState<{ query: string; sessions: SessionSummary[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const pendingCommand = useRef<(() => void) | null>(null)
  const highlighted = useRef<HTMLButtonElement>(null)
  const needle = query.trim().toLocaleLowerCase()

  useEffect(() => {
    if (!open || !needle) return
    let active = true
    const timeout = window.setTimeout(() => {
      void api
        .sessions({ provider: 'all', search: needle, limit: 30 })
        .then(({ data }) => {
          if (active) setRemote({ query: needle, sessions: data })
        })
        .catch(() => undefined)
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [open, needle])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    setRemote(null)
  }, [open])

  const items = useMemo<CommandItem[]>(() => {
    const actions: CommandItem[] = [
      {
        id: 'cmd:toggle-sidebar',
        label: '切换左侧边栏',
        shortcut: mod + 'B',
        icon: <PanelLeft className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        run: () => toggleSidebar(),
      },
      {
        id: 'cmd:files',
        label: '浏览工作区文件',
        icon: <FolderOpen className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        run: () => setSidebarTab('files'),
      },
      {
        id: 'cmd:toggle-terminal',
        label: '展开 / 收起终端',
        shortcut: mod + 'J',
        icon: <Terminal className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        run: () => toggleTerminal(),
      },
      {
        id: 'cmd:new-terminal',
        label: '新建终端标签',
        icon: <Terminal className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        run: () => addTerminal(),
      },
      {
        id: 'cmd:toggle-split',
        label: '切换分屏',
        shortcut: mod + '\\',
        icon: <Columns2 className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        run: () => toggleSplit(),
      },
      {
        id: 'cmd:toggle-inspector',
        label: '切换右侧检查器',
        shortcut: mod + 'I',
        icon: <PanelRight className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        run: () => toggleInspector(),
      },
      {
        id: 'cmd:diff',
        label: '查看工作区改动 (Git Diff)',
        icon: <GitBranch className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        run: () => openDiffTab(),
      },
      {
        id: 'cmd:settings',
        label: '打开设置',
        icon: <Settings className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        run: () => openSettingsTab(),
      },
    ]

    if (onCreateSession)
      actions.unshift({
        id: 'cmd:new-session',
        label: '新建会话',
        icon: <Plus className="size-4" />,
        run: onCreateSession,
      })
    if (onFocusComposer)
      actions.unshift({
        id: 'cmd:focus-chat',
        label: '聚焦会话输入框',
        shortcut: mod + 'Shift+L',
        icon: <MessageSquare className="size-4" />,
        run: onFocusComposer,
      })

    const recentIds = new Set(sessions.map((session) => session.id))
    const found = remote?.query === needle ? remote.sessions.filter((session) => !recentIds.has(session.id)) : []
    const sessionItems: CommandItem[] = [...sessions, ...found].map((session) => ({
      id: `session:${session.id}`,
      label: session.title || '未命名会话',
      hint: session.provider,
      icon: <Bot className="size-4 text-muted-foreground" strokeWidth={1.5} />,
      run: () => onSelectSession(session),
    }))

    const all = [...sessionItems, ...actions]
    if (!needle) return [...actions.slice(0, 4), ...sessionItems.slice(0, 6), ...actions.slice(4)]
    return all
      .filter(
        (item) => item.label.toLocaleLowerCase().includes(needle) || item.hint?.toLocaleLowerCase().includes(needle),
      )
      .slice(0, 30)
  }, [
    sessions,
    needle,
    remote,
    mod,
    toggleSidebar,
    setSidebarTab,
    toggleTerminal,
    addTerminal,
    toggleSplit,
    toggleInspector,
    openDiffTab,
    openSettingsTab,
    onSelectSession,
    onCreateSession,
    onFocusComposer,
  ])

  useEffect(() => {
    setSelectedIndex((prev) => (items.length === 0 ? 0 : Math.min(prev, items.length - 1)))
  }, [items.length])

  const execute = (item: CommandItem) => {
    pendingCommand.current = item.run
    setOpen(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            inputRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            previousFocus.current?.focus()
            const command = pendingCommand.current
            pendingCommand.current = null
            command?.()
          }}
          onKeyDown={(e) => {
            if (e.target !== inputRef.current || e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelectedIndex((i) => (items.length ? (i + 1) % items.length : 0))
              requestAnimationFrame(() => highlighted.current?.scrollIntoView({ block: 'nearest' }))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelectedIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0))
              requestAnimationFrame(() => highlighted.current?.scrollIntoView({ block: 'nearest' }))
            } else if (e.key === 'Enter' && items[selectedIndex]) {
              e.preventDefault()
              execute(items[selectedIndex])
            }
          }}
          className="fixed top-[14vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
        >
          <Dialog.Title className="sr-only">命令面板</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSelectedIndex(0)
              }}
              aria-label="搜索会话或命令"
              placeholder="搜索 Agent 会话或输入命令…"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
            />
            <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              ESC
            </kbd>
          </div>

          <ul className="scroll-y max-h-80 p-1.5">
            {items.length === 0 ? (
              <li className="px-3 py-8 text-center text-xs text-muted-foreground">没有匹配的结果</li>
            ) : (
              items.map((item, idx) => (
                <li key={item.id}>
                  <button
                    type="button"
                    ref={idx === selectedIndex ? highlighted : undefined}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => execute(item)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                      idx === selectedIndex
                        ? 'bg-secondary text-foreground'
                        : 'text-foreground/85 hover:bg-secondary/50'
                    }`}
                  >
                    {item.icon}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint && (
                      <span className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {item.hint}
                      </span>
                    )}
                    {item.shortcut && (
                      <kbd className="font-mono text-[10px] text-muted-foreground">{item.shortcut}</kbd>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
