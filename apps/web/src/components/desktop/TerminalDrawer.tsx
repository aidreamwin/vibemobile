import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Maximize2, Minimize2, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import { TERMINAL_MAX, TERMINAL_MIN, useWorkbenchStore } from '../../lib/workbench'
import type { TerminalPageProps } from '../../pages/Terminal'

const TerminalPage = lazy(() => import('../../pages/Terminal'))
type TerminalStatus = Parameters<NonNullable<TerminalPageProps['onStatusChange']>>[0]

const TerminalPane = memo(function TerminalPane({
  id,
  active,
  onStatusChange,
}: {
  id: string
  active: boolean
  onStatusChange: (id: string, status: TerminalStatus, label: string) => void
}) {
  const reportStatus = useCallback(
    (status: TerminalStatus, label: string) => onStatusChange(id, status, label),
    [id, onStatusChange],
  )
  return (
    <div hidden={!active} inert={!active} className="h-full w-full">
      <TerminalPage terminalKey={id} embedded visible={active} onStatusChange={reportStatus} />
    </div>
  )
})

export default function TerminalDrawer() {
  const terminalOpen = useWorkbenchStore((s) => s.terminalOpen)
  const terminalHeight = useWorkbenchStore((s) => s.terminalHeight)
  const terminalMaximized = useWorkbenchStore((s) => s.terminalMaximized)
  const terminals = useWorkbenchStore((s) => s.terminals)
  const activeTerminalId = useWorkbenchStore((s) => s.activeTerminalId)
  const setTerminalOpen = useWorkbenchStore((s) => s.setTerminalOpen)
  const setTerminalHeight = useWorkbenchStore((s) => s.setTerminalHeight)
  const toggleTerminalMaximized = useWorkbenchStore((s) => s.toggleTerminalMaximized)
  const addTerminal = useWorkbenchStore((s) => s.addTerminal)
  const closeTerminal = useWorkbenchStore((s) => s.closeTerminal)
  const setActiveTerminal = useWorkbenchStore((s) => s.setActiveTerminal)

  const [statusMap, setStatusMap] = useState<Record<string, { status: TerminalStatus; label: string }>>({})
  const [visited, setVisited] = useState<string[]>([])
  const panel = useRef<HTMLElement>(null)
  const drag = useRef<{ y: number; height: number } | null>(null)
  const dragHeight = useRef<number | null>(null)
  const dragFrame = useRef<number | null>(null)

  useEffect(() => {
    if (terminalOpen)
      setVisited((previous) => (previous.includes(activeTerminalId) ? previous : [...previous, activeTerminalId]))
  }, [terminalOpen, activeTerminalId])

  useEffect(
    () => () => {
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current)
    },
    [],
  )

  const reportStatus = useCallback((id: string, status: TerminalStatus, label: string) => {
    setStatusMap((previous) => {
      const current = previous[id]
      return current?.status === status && current.label === label ? previous : { ...previous, [id]: { status, label } }
    })
  }, [])

  function removeTerminal(id: string) {
    if (terminals.length > 1) {
      setVisited((previous) => previous.filter((terminalId) => terminalId !== id))
      setStatusMap((previous) => {
        const next = { ...previous }
        delete next[id]
        return next
      })
    }
    closeTerminal(id)
  }

  function finishDrag(save: boolean) {
    const height = dragHeight.current
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current)
    dragFrame.current = null
    drag.current = null
    dragHeight.current = null
    if (save && height !== null && height !== terminalHeight) setTerminalHeight(height)
    panel.current?.style.removeProperty('--terminal-drag-height')
  }

  if (!terminalOpen && visited.length === 0) return null

  return (
    <section
      ref={panel}
      aria-label="终端面板"
      style={{ height: terminalMaximized ? '65vh' : `var(--terminal-drag-height, ${terminalHeight}px)` }}
      className={`relative ${terminalOpen ? 'flex' : 'hidden'} max-h-[70%] shrink-0 flex-col border-t border-border bg-background`}
    >
      {/* Drag resizer */}
      {!terminalMaximized && (
        <hr
          aria-orientation="horizontal"
          aria-label="调整终端高度"
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            drag.current = { y: event.clientY, height: panel.current?.getBoundingClientRect().height ?? terminalHeight }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (!start) return
            dragHeight.current = Math.min(TERMINAL_MAX, Math.max(TERMINAL_MIN, start.height + start.y - event.clientY))
            if (dragFrame.current !== null) return
            dragFrame.current = requestAnimationFrame(() => {
              dragFrame.current = null
              panel.current?.style.setProperty('--terminal-drag-height', `${dragHeight.current}px`)
            })
          }}
          onPointerUp={() => finishDrag(true)}
          onPointerCancel={() => finishDrag(false)}
          onLostPointerCapture={() => finishDrag(false)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            setTerminalHeight(terminalHeight + (event.key === 'ArrowUp' ? 20 : -20))
          }}
          className="absolute inset-x-0 -top-1 z-20 h-2 touch-none cursor-row-resize border-0 hover:bg-primary/25 focus-visible:bg-primary/25"
        />
      )}

      {/* Terminal tab bar */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-[var(--workbench-toolbar)] px-2.5">
        <div role="tablist" aria-label="终端标签" className="scroll-x flex min-w-0 flex-1 items-center gap-1">
          {terminals.map((term, index) => {
            const active = term.id === activeTerminalId
            const meta = statusMap[term.id]
            return (
              <div
                key={term.id}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => setActiveTerminal(term.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return
                  const targetIndex = {
                    ArrowLeft: (index + terminals.length - 1) % terminals.length,
                    ArrowRight: (index + 1) % terminals.length,
                    Home: 0,
                    End: terminals.length - 1,
                  }[e.key]
                  if (targetIndex !== undefined) {
                    e.preventDefault()
                    const target =
                      e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[targetIndex]
                    setActiveTerminal(terminals[targetIndex].id)
                    target?.focus()
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setActiveTerminal(term.id)
                  }
                }}
                className={`group flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors select-none ${
                  active
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground'
                }`}
              >
                <TerminalIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
                <span>{term.title}</span>
                <span
                  title={meta?.status === 'open' ? '已连接' : meta?.status === 'connecting' ? '连接中' : '未连接'}
                  className={`size-1.5 rounded-full ${
                    meta?.status === 'open'
                      ? 'bg-success'
                      : meta?.status === 'connecting'
                        ? 'bg-warning'
                        : 'bg-muted-foreground/50'
                  }`}
                />
                {terminals.length > 1 && (
                  <button
                    type="button"
                    aria-label={`关闭 ${term.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      removeTerminal(term.id)
                    }}
                    tabIndex={active ? 0 : -1}
                    className={`flex size-5 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 ${active ? 'opacity-100' : 'opacity-0'}`}
                  >
                    <X className="size-3" strokeWidth={1.75} />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={addTerminal}
            title="新建终端"
            aria-label="新建终端"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={toggleTerminalMaximized}
            title={terminalMaximized ? '还原终端高度' : '最大化终端'}
            aria-label={terminalMaximized ? '还原终端高度' : '最大化终端'}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {terminalMaximized ? (
              <Minimize2 className="size-3.5" strokeWidth={1.5} />
            ) : (
              <Maximize2 className="size-3.5" strokeWidth={1.5} />
            )}
          </button>
          <button
            type="button"
            onClick={() => setTerminalOpen(false)}
            title={`收起终端 (${/Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘' : 'Ctrl+'}J)`}
            aria-label="收起终端"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ChevronDown className="size-4" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Keep mounted terminals alive so switching tabs preserves PTY state */}
      <div className="relative min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">加载终端…</div>
          }
        >
          {terminals
            .filter((term) => (terminalOpen && term.id === activeTerminalId) || visited.includes(term.id))
            .map((term) => (
              <TerminalPane
                key={term.id}
                id={term.id}
                active={terminalOpen && term.id === activeTerminalId}
                onStatusChange={reportStatus}
              />
            ))}
        </Suspense>
      </div>
    </section>
  )
}
