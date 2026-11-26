import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ChevronDown, Maximize2, Minimize2, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import { useWorkbenchStore } from '../../lib/workbench'

const TerminalPage = lazy(() => import('../../pages/Terminal'))

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

  const [statusMap, setStatusMap] = useState<Record<string, { status: string; label: string }>>({})
  const [openedBefore, setOpenedBefore] = useState(terminalOpen)
  const drag = useRef<{ y: number; height: number } | null>(null)

  useEffect(() => {
    if (terminalOpen) setOpenedBefore(true)
  }, [terminalOpen])

  if (!terminalOpen && !openedBefore) return null

  return (
    <section
      aria-label="终端面板"
      style={{ height: terminalMaximized ? '65vh' : terminalHeight }}
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
            drag.current = { y: event.clientY, height: terminalHeight }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (start) setTerminalHeight(start.height + start.y - event.clientY)
          }}
          onLostPointerCapture={() => {
            drag.current = null
          }}
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
        <div className="scroll-x flex min-w-0 flex-1 items-center gap-1">
          {terminals.map((term) => {
            const active = term.id === activeTerminalId
            const meta = statusMap[term.id]
            return (
              <div
                key={term.id}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                onClick={() => setActiveTerminal(term.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
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
                      closeTerminal(term.id)
                    }}
                    className="flex size-4 items-center justify-center rounded text-muted-foreground/70 opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
                  >
                    <X className="size-3" strokeWidth={1.75} />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            onClick={addTerminal}
            title="新建终端"
            aria-label="新建终端"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1">
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
            title="收起终端 (⌘J)"
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
          {terminals.map((term) => (
            <div key={term.id} className={term.id === activeTerminalId ? 'h-full w-full' : 'hidden h-full w-full'}>
              <TerminalPage
                terminalKey={term.id}
                embedded
                onStatusChange={(status, label) => {
                  setStatusMap((prev) => {
                    const current = prev[term.id]
                    if (current?.status === status && current?.label === label) return prev
                    return { ...prev, [term.id]: { status, label } }
                  })
                }}
              />
            </div>
          ))}
        </Suspense>
      </div>
    </section>
  )
}
