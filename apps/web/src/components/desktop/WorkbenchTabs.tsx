import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Bot, ChevronLeft, ChevronRight, FileCode2, FileImage, GitBranch, Settings, X } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import type { WorkbenchTab } from '../../lib/workbench'
import { isImageFile } from '../../lib/fileImage'

function TabStatusDot({ tab }: { tab: WorkbenchTab }) {
  if (tab.kind !== 'chat' || !tab.status || tab.status === 'idle') return null
  if (tab.status === 'working') {
    return <span className="size-1.5 shrink-0 motion-safe:animate-pulse rounded-full bg-success" title="执行中" />
  }
  if (tab.status === 'waitingApproval' || tab.status === 'waitingInput') {
    return <span className="size-1.5 shrink-0 rounded-full bg-warning" title="等待处理" />
  }
  if (tab.status === 'error') {
    return <span className="size-1.5 shrink-0 rounded-full bg-destructive" title="出错" />
  }
  return null
}

function TabIcon({ tab }: { tab: WorkbenchTab }) {
  const cls = 'size-3.5 shrink-0 text-muted-foreground'
  switch (tab.kind) {
    case 'chat':
      return <Bot className={cls} strokeWidth={1.5} />
    case 'file':
      return isImageFile(tab.path) ? (
        <FileImage className={cls} strokeWidth={1.5} />
      ) : (
        <FileCode2 className={cls} strokeWidth={1.5} />
      )
    case 'diff':
      return <GitBranch className={cls} strokeWidth={1.5} />
    case 'settings':
      return <Settings className={cls} strokeWidth={1.5} />
  }
}

export default function WorkbenchTabs({
  tabs,
  label = '打开的标签页',
  activeTabId,
  secondaryTabId,
  onSelect,
  onClose,
  onCloseAll,
  menuContainer,
}: {
  tabs: WorkbenchTab[]
  label?: string
  activeTabId: string | null
  secondaryTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCloseAll: (id: string) => void
  menuContainer: HTMLElement | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ overflow: false, start: true, end: true })

  const measure = useCallback(() => {
    const container = containerRef.current
    const scroll = scrollRef.current
    const content = tabsRef.current
    if (!container || !scroll || !content) return
    const next = {
      overflow: content.offsetWidth > container.clientWidth,
      start: scroll.scrollLeft <= 1,
      end: scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 1,
    }
    setEdges((previous) =>
      previous.overflow === next.overflow && previous.start === next.start && previous.end === next.end
        ? previous
        : next,
    )
  }, [])

  useLayoutEffect(() => {
    const observer = new ResizeObserver(measure)
    for (const element of [containerRef.current, scrollRef.current, tabsRef.current]) {
      if (element) observer.observe(element)
    }
    measure()
    return () => observer.disconnect()
  }, [measure])

  useLayoutEffect(() => {
    if (!activeTabId) return
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [activeTabId, edges.overflow, measure])

  function scrollTabs(direction: -1 | 1) {
    const scroll = scrollRef.current
    if (scroll) scroll.scrollBy({ left: scroll.clientWidth * 0.75 * direction })
  }

  const arrowClass =
    'grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-30'
  const menuItemClass =
    'flex cursor-default select-none items-center rounded px-2.5 py-1.5 text-xs outline-none data-[highlighted]:bg-accent'

  return (
    <div ref={containerRef} className="flex h-full min-w-0 flex-1 items-center">
      {edges.overflow && (
        <button
          type="button"
          aria-label="向左滚动标签"
          title="向左滚动标签"
          disabled={edges.start}
          onClick={() => scrollTabs(-1)}
          className={arrowClass}
        >
          <ChevronLeft aria-hidden="true" className="size-3.5" />
        </button>
      )}
      <div
        ref={scrollRef}
        onScroll={measure}
        className="h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div ref={tabsRef} role="tablist" aria-label={label} className="flex h-full w-max items-center gap-1 px-1">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId
            const isSecondary = tab.id === secondaryTabId
            return (
              <ContextMenu.Root key={tab.id}>
                <ContextMenu.Trigger asChild>
                  <div
                    ref={isActive ? activeRef : undefined}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    title={tab.title}
                    onClick={() => onSelect(tab.id)}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault()
                        onClose(tab.id)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.currentTarget !== e.target || e.altKey || e.ctrlKey || e.metaKey) return
                      const indexByKey: Record<string, number> = {
                        ArrowLeft: (index + tabs.length - 1) % tabs.length,
                        ArrowRight: (index + 1) % tabs.length,
                        Home: 0,
                        End: tabs.length - 1,
                      }
                      const next = indexByKey[e.key]
                      if (next !== undefined) {
                        e.preventDefault()
                        onSelect(tabs[next].id)
                        requestAnimationFrame(() => activeRef.current?.focus())
                      } else if (e.key === 'Delete') {
                        e.preventDefault()
                        onClose(tab.id)
                        requestAnimationFrame(() => activeRef.current?.focus())
                      } else if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelect(tab.id)
                      }
                    }}
                    className={`workbench-tab group relative flex h-[30px] max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors select-none ${
                      isActive
                        ? 'bg-[var(--workbench-selection)] font-medium text-foreground'
                        : isSecondary
                          ? 'bg-secondary/50 text-foreground/85 ring-1 ring-border/70'
                          : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground'
                    }`}
                  >
                    <TabIcon tab={tab} />
                    <span className="truncate">{tab.title}</span>
                    <TabStatusDot tab={tab} />
                    <button
                      type="button"
                      tabIndex={isActive ? 0 : -1}
                      aria-label={`关闭 ${tab.title}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onClose(tab.id)
                      }}
                      className={`ml-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 ${isActive || isSecondary ? 'opacity-100' : 'opacity-0'}`}
                    >
                      <X className="size-3" strokeWidth={1.75} />
                    </button>
                  </div>
                </ContextMenu.Trigger>
                <ContextMenu.Portal container={menuContainer}>
                  <ContextMenu.Content
                    aria-label="标签页操作"
                    collisionPadding={8}
                    className="z-50 min-w-36 rounded-lg border border-border bg-popover p-1 text-foreground shadow-xl"
                  >
                    <ContextMenu.Item className={menuItemClass} onSelect={() => onClose(tab.id)}>
                      关闭标签页
                    </ContextMenu.Item>
                    {tab.kind !== 'settings' && (
                      <ContextMenu.Item className={menuItemClass} onSelect={() => onCloseAll(tab.id)}>
                        {tab.kind === 'chat' ? '关闭全部 Agent 标签' : '关闭全部文件标签'}
                      </ContextMenu.Item>
                    )}
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            )
          })}
        </div>
      </div>
      {edges.overflow && (
        <button
          type="button"
          aria-label="向右滚动标签"
          title="向右滚动标签"
          disabled={edges.end}
          onClick={() => scrollTabs(1)}
          className={arrowClass}
        >
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </div>
  )
}
