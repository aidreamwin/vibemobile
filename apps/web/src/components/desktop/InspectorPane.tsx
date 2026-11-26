import { Activity, AlertTriangle, GitBranch, Layers, X } from 'lucide-react'
import type { SessionSummary } from '@vibemobile/protocol'
import { useApprovalStore } from '../../lib/approvals'
import { useMountedChat } from '../../lib/store'
import { useWorkbenchStore } from '../../lib/workbench'

export default function InspectorPane({
  sessions,
  loading,
  error,
  threadId,
  onSelectSession,
  onSelectSessionId,
}: {
  sessions: SessionSummary[]
  loading: boolean
  error: boolean
  threadId?: string
  onSelectSession: (session: SessionSummary) => void
  onSelectSessionId: (id: string) => void
}) {
  const inspectorOpen = useWorkbenchStore((s) => s.inspectorOpen)
  const setInspectorOpen = useWorkbenchStore((s) => s.setInspectorOpen)
  const openDiffTab = useWorkbenchStore((s) => s.openDiffTab)

  const approvals = useApprovalStore((s) => s.pending)
  const diff = useMountedChat(threadId, (s) => s.diff)
  const plan = useMountedChat(threadId, (s) => s.plan)

  if (!inspectorOpen) return null

  const activeAgents = sessions.filter(
    (s) => s.status === 'working' || s.status === 'waitingApproval' || s.status === 'waitingInput',
  )

  return (
    <aside
      aria-label="检查器"
      className="flex w-[248px] shrink-0 flex-col border-l border-border bg-[var(--workbench-sidebar)]"
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium tracking-wide text-foreground">检查器</span>
        <button
          type="button"
          onClick={() => setInspectorOpen(false)}
          aria-label="关闭检查器"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="size-3.5" strokeWidth={1.5} />
        </button>
      </div>

      <div className="scroll-y min-h-0 flex-1 space-y-4 p-3">
        {/* Pending Approvals */}
        <section className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 text-warning" strokeWidth={1.5} />
              待审批
            </span>
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-foreground">
              {approvals.length}
            </span>
          </div>
          {approvals.length === 0 ? (
            <p className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-[11px] text-muted-foreground">
              当前没有待审批请求。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {approvals.map((item) => (
                <li key={item.requestId} className="rounded-lg border border-warning/35 bg-warning/8">
                  <button
                    type="button"
                    onClick={() => onSelectSessionId(item.threadId)}
                    className="block w-full rounded-lg px-2.5 py-2 text-left text-xs hover:bg-warning/10"
                  >
                    <span className="block truncate font-medium text-warning">
                      {sessions.find((session) => session.id === item.threadId)?.title || '打开待审批会话'}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {item.reason || '等待授权'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Active Agents */}
        <section className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Activity className="size-3.5 text-success" strokeWidth={1.5} />
              活跃 Agent
            </span>
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-foreground">
              {activeAgents.length || (loading ? '…' : error ? '–' : 0)}
            </span>
          </div>
          {activeAgents.length === 0 ? (
            <p className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-[11px] text-muted-foreground">
              {loading ? '正在读取 Agent 状态…' : error ? '暂时无法读取 Agent 状态。' : '所有 Agent 均处于空闲状态。'}
            </p>
          ) : (
            <ul className="space-y-1">
              {activeAgents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => onSelectSession(agent)}
                    className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background/50 px-2.5 py-1.5 text-left transition-colors hover:bg-secondary"
                  >
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        agent.status === 'working' ? 'motion-safe:animate-pulse bg-success' : 'bg-warning'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">{agent.title || '未命名'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Current Plan */}
        {plan.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <Layers className="size-3.5" strokeWidth={1.5} />
              执行计划
            </div>
            <ul className="space-y-1 rounded-lg border border-border/60 bg-background/40 p-2 text-[11px]">
              {plan.map((step, idx) => (
                <li key={`${step.step}-${idx}`} className="flex items-start gap-2">
                  <span
                    className={`mt-1 size-1.5 shrink-0 rounded-full ${
                      step.status === 'completed'
                        ? 'bg-success'
                        : step.status === 'inProgress'
                          ? 'motion-safe:animate-pulse bg-warning'
                          : 'bg-muted-foreground/40'
                    }`}
                  />
                  <span
                    className={step.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}
                  >
                    {step.step}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Workspace Diff Quick Action */}
        <section className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <GitBranch className="size-3.5" strokeWidth={1.5} />
            代码改动
          </div>
          <button
            type="button"
            onClick={() => openDiffTab(undefined, { inSecondary: true })}
            className="flex w-full items-center justify-between rounded-lg border border-border/70 bg-background/50 px-2.5 py-2 text-xs text-foreground transition-colors hover:bg-secondary"
          >
            <span>分屏查看工作区改动</span>
            {diff ? <span className="size-1.5 rounded-full bg-warning" /> : null}
          </button>
        </section>
      </div>
    </aside>
  )
}
