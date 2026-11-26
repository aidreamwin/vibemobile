import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Columns2, Ellipsis, ListFilter, Plus, RefreshCw, Search, X } from 'lucide-react'
import type { ProviderId, ProviderStatus, SessionSummary } from '@vibemobile/protocol'
import { api, ApiError } from '../../lib/api'
import { cachedSessionList, clearSessionLists, loadSessionList } from '../../lib/sessionLists'
import { relativeTime } from '../../lib/format'
import { isPathInside, useWorkspaceStore } from '../../lib/workspace'
import { socket } from '../../lib/ws'
import NewSessionSheet from '../NewSessionSheet'
import SessionActions from '../SessionActions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

type ProviderFilter = 'all' | ProviderId
type SessionUpdate = (sessions: SessionSummary[], search: string) => SessionSummary[]

interface SessionListResult {
  key: string
  search: string
  sessions: SessionSummary[]
}

const PROVIDER_NAMES: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
}

const SESSION_STATUS: Record<SessionSummary['status'], { label: string; color: string }> = {
  idle: { label: '空闲', color: 'bg-muted-foreground/35' },
  working: { label: '运行中', color: 'bg-success motion-safe:animate-pulse' },
  waitingApproval: { label: '等待审批', color: 'bg-warning' },
  waitingInput: { label: '等待输入', color: 'bg-warning' },
  error: { label: '出错', color: 'bg-destructive' },
}

const TOOL_BUTTON =
  'relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40'

const ROW_ACTION =
  'flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

export default memo(function DesktopAgentSidebar({
  activeThreadId,
  visibleThreadIds,
  canSplit,
  creating,
  setCreating,
  onSelectSession,
  onSplitSession,
}: {
  activeThreadId: string | null
  visibleThreadIds: string[]
  canSplit: boolean
  creating: boolean
  setCreating: (creating: boolean) => void
  onSelectSession: (session: SessionSummary) => void
  onSplitSession: (session: SessionSummary) => void
}) {
  const projects = useWorkspaceStore((s) => s.projects)
  const defaultCwd = useWorkspaceStore((s) => s.defaultCwd)
  const lastSessionCwd = useWorkspaceStore((s) => s.lastSessionCwd)
  const setLastSessionCwd = useWorkspaceStore((s) => s.setLastSessionCwd)

  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [result, setResult] = useState<SessionListResult | null>(null)
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ProviderFilter>('all')
  const [project, setProject] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [newSessionProvider, setNewSessionProvider] = useState<ProviderId>('codex')
  const [actionsFor, setActionsFor] = useState<SessionSummary | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const providerRequest = useRef<object | null>(null)
  const sessionRequest = useRef<SessionUpdate[] | null>(null)
  const pendingActions = useRef(new Set<string>())

  const selectedProject = projects.find((item) => item.path === project)
  const cwd = selectedProject?.path
  const filterKey = JSON.stringify([filter, cwd, showArchived])
  const filterSummary = [filter !== 'all' && PROVIDER_NAMES[filter], selectedProject?.name, showArchived && '已归档']
    .filter(Boolean)
    .join(' · ')

  useEffect(() => {
    const timeout = setTimeout(() => setSearch(query.trim()), 250)
    return () => clearTimeout(timeout)
  }, [query])

  const loadProviders = useCallback(async () => {
    const request = {}
    providerRequest.current = request
    setProviderError(null)
    try {
      const { data } = await api.providers()
      if (providerRequest.current === request) setProviders(data)
    } catch (err) {
      if (providerRequest.current === request) setProviderError((err as Error).message)
    }
  }, [])

  const loadSessions = useCallback(
    async (force = false) => {
      // A result must belong to the latest request. Changes received while it
      // was pending must also survive the response.
      const updates: SessionUpdate[] = []
      sessionRequest.current = updates
      setFetching(true)
      setError(null)
      const params = { provider: filter, cwd, archived: showArchived, limit: 60, search: search || undefined }
      const cached = cachedSessionList(params)
      if (cached && !force) setResult({ key: filterKey, search, sessions: cached })
      try {
        const data = await loadSessionList(params, force)
        if (sessionRequest.current !== updates) return
        setResult({
          key: filterKey,
          search,
          sessions: updates.reduce((sessions, update) => update(sessions, search), data),
        })
      } catch (err) {
        if (sessionRequest.current === updates) setError((err as Error).message)
      } finally {
        if (sessionRequest.current === updates) {
          sessionRequest.current = null
          setFetching(false)
        }
      }
    },
    [cwd, filter, filterKey, search, showArchived],
  )

  useEffect(() => {
    void loadProviders()
    return () => {
      providerRequest.current = null
    }
  }, [loadProviders])

  useEffect(() => {
    void loadSessions()
    return () => {
      sessionRequest.current = null
    }
  }, [loadSessions])

  const updateSessions = useCallback((update: SessionUpdate) => {
    sessionRequest.current?.push(update)
    setResult((current) => {
      if (!current) return current
      const sessions = update(current.sessions, current.search)
      return sessions === current.sessions ? current : { ...current, sessions }
    })
  }, [])

  useEffect(
    () =>
      socket.onEvent((event) => {
        if (event.kind !== 'session.status') return
        updateSessions((sessions) => {
          const session = sessions.find((item) => item.id === event.threadId)
          if (!session || session.status === event.status) return sessions
          return sessions.map((item) => (item.id === event.threadId ? { ...item, status: event.status } : item))
        })
      }),
    [updateSessions],
  )

  const visible = result?.key === filterKey ? result : null
  const groups = useMemo(() => {
    const attention: SessionSummary[] = []
    const active: SessionSummary[] = []
    const pinned: SessionSummary[] = []
    const recent: SessionSummary[] = []
    const sessions = [...(visible?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const session of sessions) {
      const { status } = session
      if (status === 'waitingApproval' || status === 'waitingInput') attention.push(session)
      else if (status === 'working') active.push(session)
      else if (session.pinned) pinned.push(session)
      else recent.push(session)
    }
    return [
      { label: '待处理', sessions: attention },
      { label: '进行中', sessions: active },
      { label: '已置顶', sessions: pinned },
      { label: '最近', sessions: recent },
    ].filter((group) => group.sessions.length > 0)
  }, [visible])

  function clearSearch() {
    setQuery('')
    setSearch('')
    searchInput.current?.focus()
  }

  useEffect(() => {
    if (!creating) return
    setNewSessionProvider((current) => {
      const preferred = filter === 'all' ? current : filter
      return (
        providers.find((item) => item.id === preferred && item.available)?.id ??
        providers.find((item) => item.available)?.id ??
        preferred
      )
    })
  }, [creating, filter, providers])

  function handleCreated(session: SessionSummary) {
    clearSessionLists()
    setCreating(false)
    setLastSessionCwd(session.cwd)
    if (
      !showArchived &&
      (filter === 'all' || session.provider === filter) &&
      (!cwd || isPathInside(session.cwd, cwd))
    ) {
      updateSessions((sessions, query) =>
        matchesTitle(session.title, query) ? [session, ...sessions.filter((item) => item.id !== session.id)] : sessions,
      )
    }
    onSelectSession(session)
  }

  function removeSession(session: SessionSummary) {
    updateSessions((sessions) => sessions.filter((item) => item.id !== session.id))
  }

  async function saveSessionChange(session: SessionSummary, save: () => Promise<unknown>, onSaved: () => void) {
    setActionsFor(null)
    pendingActions.current.add(session.id)
    setError(null)
    try {
      await save()
      clearSessionLists()
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      pendingActions.current.delete(session.id)
    }
  }

  const openSessionActions = useCallback((session: SessionSummary) => {
    if (!pendingActions.current.has(session.id)) setActionsFor(session)
  }, [])

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1.5">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" strokeWidth={1.6} />
          <input
            ref={searchInput}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              if (!event.target.value.trim()) setSearch('')
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !query) return
              event.preventDefault()
              event.stopPropagation()
              clearSearch()
            }}
            placeholder="搜索会话"
            aria-label="搜索会话标题"
            className="h-7 w-full rounded-md border border-border/70 bg-background/70 pl-7 pr-6 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="清除搜索"
              className="absolute right-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <X className="size-3" strokeWidth={1.75} />
            </button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={filterSummary ? `筛选会话 · ${filterSummary}` : '筛选会话'}
              aria-label={filterSummary ? `筛选会话 · ${filterSummary}` : '筛选会话'}
              className={`${TOOL_BUTTON} data-[state=open]:bg-secondary data-[state=open]:text-foreground ${filterSummary ? 'bg-secondary text-foreground' : ''}`}
            >
              <ListFilter className="size-3.5" strokeWidth={1.7} />
              {filterSummary && (
                <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-1 ring-secondary" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44 rounded-lg">
            {providers.length > 1 && (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">代理</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={filter} onValueChange={(value) => setFilter(value as ProviderFilter)}>
                  <DropdownMenuRadioItem value="all">全部代理</DropdownMenuRadioItem>
                  {providers.map((item) => (
                    <DropdownMenuRadioItem key={item.id} value={item.id}>
                      {item.displayName}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            )}
            {projects.length > 1 && (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">项目</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={project} onValueChange={setProject}>
                  <DropdownMenuRadioItem value="">全部项目</DropdownMenuRadioItem>
                  {projects.map((item) => (
                    <DropdownMenuRadioItem key={item.id} value={item.path}>
                      {item.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuRadioGroup
              value={showArchived ? 'archived' : 'active'}
              onValueChange={(value) => setShowArchived(value === 'archived')}
            >
              <DropdownMenuRadioItem value="active">当前会话</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="archived">已归档会话</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={() => {
            void loadSessions(true)
            void loadProviders()
          }}
          disabled={fetching}
          title="刷新会话"
          aria-label="刷新会话"
          className={TOOL_BUTTON}
        >
          <RefreshCw className={`size-3.5 ${fetching ? 'motion-safe:animate-spin' : ''}`} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={projects.length === 0}
          title="新建 Agent 会话"
          aria-label="新建 Agent 会话"
          className={`${TOOL_BUTTON} text-foreground`}
        >
          <Plus className="size-4" strokeWidth={1.8} />
        </button>
      </div>

      {filterSummary && (
        <div className="truncate px-3 pt-0.5 pb-1 text-[11px] text-muted-foreground" title={filterSummary}>
          {filterSummary}
        </div>
      )}

      <div className="scroll-y min-h-0 flex-1 space-y-2.5 px-2 py-1" aria-busy={fetching}>
        {(error || providerError) && (
          <div role="alert" className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {error || providerError}
          </div>
        )}
        {!visible && fetching ? (
          <div role="status" className="py-10 text-center text-xs text-muted-foreground">
            加载中…
          </div>
        ) : groups.length > 0 ? (
          groups.map(({ label, sessions }) => (
            <section key={label} aria-label={label}>
              {(label !== '最近' || groups.length > 1) && (
                <h3 className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-muted-foreground">{label}</h3>
              )}
              <ul className="space-y-0.5">
                {sessions.map((session) => (
                  <DesktopSessionRow
                    key={session.id}
                    session={session}
                    selected={session.id === activeThreadId}
                    secondary={visibleThreadIds.includes(session.id)}
                    canSplit={canSplit}
                    onSelectSession={onSelectSession}
                    onSplitSession={onSplitSession}
                    onActions={openSessionActions}
                  />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-xs text-muted-foreground">
            <Bot className="size-5 opacity-60" strokeWidth={1.5} />
            <span>{search ? '没有匹配的会话' : showArchived ? '暂无已归档会话' : '暂无会话'}</span>
          </div>
        )}
      </div>

      {creating && (
        <NewSessionSheet
          provider={newSessionProvider}
          providers={providers}
          onProviderChange={setNewSessionProvider}
          projects={projects}
          initialCwd={cwd || lastSessionCwd || defaultCwd || projects[0]?.path || ''}
          onCwdChange={setLastSessionCwd}
          onClose={() => setCreating(false)}
          onCreated={handleCreated}
        />
      )}

      {actionsFor && (
        <SessionActions
          session={actionsFor}
          onClose={() => setActionsFor(null)}
          onRename={(name) =>
            void saveSessionChange(
              actionsFor,
              () => api.renameSession(actionsFor.id, name),
              () =>
                updateSessions((sessions, query) =>
                  matchesTitle(name, query)
                    ? sessions.map((item) => (item.id === actionsFor.id ? { ...item, title: name } : item))
                    : sessions.filter((item) => item.id !== actionsFor.id),
                ),
            )
          }
          onDelete={() =>
            void saveSessionChange(
              actionsFor,
              () =>
                api.deleteSession(actionsFor.id).catch((err) => {
                  if (!(err instanceof ApiError && err.status === 404)) throw err
                }),
              () => removeSession(actionsFor),
            )
          }
          onArchived={() => {
            clearSessionLists()
            setActionsFor(null)
            removeSession(actionsFor)
          }}
          onPinned={(pinned) => {
            clearSessionLists()
            setActionsFor(null)
            updateSessions((sessions) =>
              sessions.map((item) => (item.id === actionsFor.id ? { ...item, pinned } : item)),
            )
          }}
        />
      )}
    </div>
  )
})

const DesktopSessionRow = memo(function DesktopSessionRow({
  session,
  selected,
  secondary,
  canSplit,
  onSelectSession,
  onSplitSession,
  onActions,
}: {
  session: SessionSummary
  selected: boolean
  secondary: boolean
  canSplit: boolean
  onSelectSession: (session: SessionSummary) => void
  onSplitSession: (session: SessionSummary) => void
  onActions: (session: SessionSummary) => void
}) {
  const title = session.title || '未命名会话'
  const status = SESSION_STATUS[session.status]
  const time = relativeTime(session.updatedAt)
  return (
    <li
      className={`group relative flex items-center rounded-md transition-colors ${
        selected
          ? 'bg-[var(--workbench-selection)] text-foreground'
          : secondary
            ? 'bg-secondary text-foreground'
            : 'text-foreground/85 hover:bg-secondary/55'
      }`}
    >
      <button
        type="button"
        aria-current={selected || undefined}
        title={title}
        onClick={() => onSelectSession(session)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 pr-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${status.color}`} title={status.label} />
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] leading-4 font-medium">{title}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[11px] leading-3.5 text-muted-foreground">
            <span className="sr-only">{status.label}，</span>
            <span className="truncate">{PROVIDER_NAMES[session.provider] ?? session.provider}</span>
            {time && <span className="shrink-0">· {time}</span>}
          </span>
        </span>
      </button>
      <div
        className={`flex shrink-0 items-center gap-0.5 pr-1 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${selected || secondary ? 'opacity-100' : 'opacity-0'}`}
      >
        <button
          type="button"
          title={canSplit ? '分屏打开' : '已达到四分屏上限'}
          aria-label={`分屏打开 ${title}`}
          disabled={!canSplit}
          onClick={() => onSplitSession(session)}
          className={ROW_ACTION + ' disabled:opacity-30'}
        >
          <Columns2 className="size-3" strokeWidth={1.7} />
        </button>
        <button
          type="button"
          title="更多操作"
          aria-label={`${title} 的更多操作`}
          aria-haspopup="dialog"
          onClick={() => onActions(session)}
          className={ROW_ACTION}
        >
          <Ellipsis className="size-3.5" strokeWidth={1.7} />
        </button>
      </div>
    </li>
  )
})

function matchesTitle(title: string, query: string) {
  return title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
}
