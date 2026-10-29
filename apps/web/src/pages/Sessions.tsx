import { Bot, MessagesSquare } from 'lucide-react'
import ToolbarRow, { ToolbarIdentity } from '../components/ToolbarRow'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  ApprovalPolicy,
  ModelInfo,
  Project,
  ProviderId,
  ProviderStatus,
  SandboxMode,
  SessionSummary,
} from '@vibemobile/protocol'
import { api, ApiError } from '../lib/api'
import { useWorkspaceStore } from '../lib/workspace'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from '../components/ui/select'
import RunnerSelector from '../components/RunnerSelector'
import NewSessionSheet from '../components/NewSessionSheet'
import SessionActions from '../components/SessionActions'
import SessionList from '../components/SessionList'
import SessionListEmpty from '../components/SessionListEmpty'

/** `'all'` is a first-class value, not "no provider selected". */
type ProviderFilter = 'all' | ProviderId

const FILTER_STORAGE_KEY = 'vibemobile.sessionProviderFilter'

// Read at module scope, not in an effect, so the first paint already shows the
// remembered filter. Reading it after mount would render "全部" and then swap
// to the real selection on the next frame.
function readStoredFilter(): ProviderFilter {
  try {
    return (globalThis.localStorage?.getItem(FILTER_STORAGE_KEY) as ProviderFilter) || 'all'
  } catch {
    // Private browsing and locked-down WebViews may reject storage reads.
    return 'all'
  }
}

function persistFilter(filter: ProviderFilter): void {
  try {
    globalThis.localStorage?.setItem(FILTER_STORAGE_KEY, filter)
  } catch {
    // …and writes. A filter that does not survive a reload is not worth an error.
  }
}

/**
 * How long typing settles before the list is refetched.
 *
 * The request is a round trip to a backend that, for Claude, walks every
 * session the CLI knows about, so a keystroke-per-request would put the list
 * behind the typing. Short enough that the result feels like it followed the
 * keystroke, long enough that a word is one request.
 */
const SEARCH_DEBOUNCE_MS = 250

/** Which list this position belongs to — the rows only mean the same thing
 *  under the same filter and the same project. */
function listKey(cwd: string | undefined, archived: boolean, provider: ProviderFilter): string {
  return `${cwd ?? ''}|${archived}|${provider}`
}

/**
 * Where the list was scrolled to, remembered across a detour into a chat.
 *
 * In memory rather than in storage: the case this exists for is "tapped a
 * session, came back", which is a remount inside one page load — the client
 * side router replaces the element, so the browser's own scroll restoration
 * (which only knows about the window) never sees this container at all.
 *
 * The anchor is a session ID, not just a pixel offset, because the list is
 * sorted by "recently touched": the session you just visited can be at the top
 * when you come back, so every row above the fold shifts by one and the same
 * `scrollTop` then frames the wrong conversation. `offset` is how far that row
 * was scrolled past the top edge (0 or a little negative), which is what makes
 * the restore land on the same pixel instead of on the row's edge. `top` is
 * only the fallback for when that row is gone from the (60-row) page.
 */
type ListScroll = { key: string; id: string | null; offset: number; top: number }

let listScroll: ListScroll | null = null

export default function Sessions() {
  const navigate = useNavigate()

  const projects = useWorkspaceStore((state) => state.projects)
  const defaultCwd = useWorkspaceStore((state) => state.defaultCwd)
  // This preference belongs to the creation form, not to the global workspace
  // used by Files, Git diff, and Terminal.
  const lastSessionCwd = useWorkspaceStore((state) => state.lastSessionCwd)
  const setLastSessionCwd = useWorkspaceStore((state) => state.setLastSessionCwd)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [actionsFor, setActionsFor] = useState<SessionSummary | null>(null)

  // `searchOpen` and `search` are deliberately NOT persisted and deliberately
  // NOT part of the remembered scroll position's key, even though typing does
  // re-query the list. A search is a temporary look-up on top of a list, and it
  // dies with the page (navigate into a chat and back and the box is gone), so
  // the position worth remembering is the one the list has without it. That is
  // also why `rememberScroll` refuses to record anything while a query is
  // active — see there.
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')

  /**
   * Clearing is immediate where typing is debounced, and the asymmetry is the
   * point: waiting out the debounce is what keeps the list from chasing a
   * keystroke, but nobody types "empty". Left debounced, closing the box would
   * leave the list filtered for a quarter of a second with nothing on screen
   * saying why.
   *
   * Setting both is not a race — the effect that runs afterwards schedules the
   * same value 250 ms later, which by then changes nothing.
   */
  function clearSearch() {
    setSearch('')
    setQuery('')
  }

  const [filter, setFilter] = useState<ProviderFilter>(readStoredFilter)

  /** Only the filter is persisted. The rest of the page is deliberately fresh. */
  function chooseFilter(next: ProviderFilter) {
    persistFilter(next)
    setFilter(next)
  }

  const listRef = useRef<HTMLDivElement>(null)
  const queryKey = listKey(activeProject?.path, showArchived, filter)
  // Read once, on mount: a position belonging to another filter/project is not
  // a position in this list, so it is dropped rather than clamped into it.
  const pendingScroll = useRef(listScroll?.key === queryKey ? listScroll : null)

  function rememberScroll() {
    const el = listRef.current
    if (!el) return
    // Refused while a search is narrowing the list, and this is the same trap as
    // the one in Files.tsx: a shorter list is clamped by the browser to its own
    // new height, which fires a scroll event and would write that clamped
    // position — usually 0 — as "where the user was". The row they were actually
    // looking at is gone from the results, so the position cannot be expressed
    // in this list at all; the one worth keeping is the one the unfiltered list
    // has, and not recording here is what leaves it intact.
    if (query) return
    const box = el.getBoundingClientRect().top
    // The first row still (even partly) below the top edge is the one the user
    // sees first, so that is what "the position" means.
    let id: string | null = null
    let offset = 0
    for (const row of el.querySelectorAll<HTMLElement>('[data-session-id]')) {
      if (row.getBoundingClientRect().bottom > box) {
        id = row.dataset.sessionId ?? null
        offset = row.getBoundingClientRect().top - box
        break
      }
    }
    listScroll = { key: queryKey, id, offset, top: el.scrollTop }
  }

  // Laid out, not painted: the rows only exist after the fetch has answered, and
  // restoring in an effect would show the top of the list for one frame first.
  useLayoutEffect(() => {
    const el = listRef.current
    const target = pendingScroll.current
    if (!el || !target || loading) return
    pendingScroll.current = null
    if (target.id !== null) {
      for (const row of el.querySelectorAll<HTMLElement>('[data-session-id]')) {
        if (row.dataset.sessionId !== target.id) continue
        // Put that row back where it was on screen, not merely at the top edge.
        el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - target.offset
        return
      }
    }
    el.scrollTop = target.top
  }, [loading, sessions])

  // Which provider new sessions go to. The LIST shows every provider's
  // sessions at once — the page is "my coding agents", not "one agent" — but
  // creating still needs a single answer, so it defaults to the first provider
  // that is actually usable. Deliberately NOT coupled to the filter: narrowing
  // the list to read old Claude work should not quietly change where the next
  // session goes, and the sheet already offers an explicit choice.
  const [newSessionProvider, setNewSessionProvider] = useState<ProviderId | null>(null)
  const usable = providers.filter((p) => p.available)
  const createWith = providers.find((p) => p.id === newSessionProvider) ?? usable[0] ?? providers[0]

  /** The label for a session's provider, falling back to the raw id. */
  function providerName(id: string): string {
    return providers.find((p) => p.id === id)?.displayName ?? id
  }

  // The browser remembers a filter across deploys; the server does not. A
  // stored id that no longer exists would otherwise pin the list to a provider
  // that will never answer, so drop it once we know what actually exists.
  useEffect(() => {
    if (providers.length === 0) return
    if (filter !== 'all' && !providers.some((p) => p.id === filter)) chooseFilter('all')
  }, [providers, filter])

  /**
   * Answers are only allowed to land in the order they were asked for.
   *
   * Two callers can now be in flight at once (a debounced keystroke and a
   * refresh, or two keystrokes whose round trips cross), and the list is
   * unconditionally replaced by whatever comes back — so without this the older
   * answer wins whenever it is the slower one, and the list settles on results
   * for a query the user has already changed. Counting rather than aborting:
   * the request has already been sent, and a bounced response is cheaper to
   * discard here than to cancel.
   */
  const requestSeq = useRef(0)

  const loadSessions = useCallback(
    async (cwd: string | undefined, archived: boolean, provider: ProviderFilter, search: string) => {
      // ONE request, not one per provider: 'all' asks the server to merge and
      // sort them ("recently touched" is the useful order, and interleaving
      // Codex and Claude by time is the point of 全部 being the default).
      //
      // Fanning out here is what made this page slow. It could not name the
      // providers to fan out to until /api/providers had answered, and probing
      // is the expensive part — Claude's spawns a ~230 MB native CLI binary —
      // so the page sat on 加载中 for as long as the slowest provider took to
      // probe. Nothing about listing sessions needs to know whether a provider
      // is healthy.
      const seq = ++requestSeq.current
      const { data } = await api.sessions({
        provider,
        cwd,
        archived,
        limit: 60,
        search: search || undefined,
      })
      if (seq !== requestSeq.current) return
      setSessions(data)
    },
    [],
  )

  // Debounced so the list follows the typing rather than racing it. Note what
  // this effect does NOT do: set `loading`. `加载中…` is a short block, so
  // putting it up on every keystroke would collapse the scroll container to its
  // new height on each one — see the note in `rememberScroll`.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  // Provider status changes rarely, so it is fetched once; only the session
  // list is re-fetched on filter changes. The default workspace is deliberately
  // not a filter: changing it must not hide sessions from other directories.
  useEffect(() => {
    let cancelled = false
    api
      .providers()
      .then((providerRes) => {
        if (cancelled) return
        setProviders(providerRes.data)
      })
      .catch((err) => !cancelled && setError((err as Error).message))
    return () => {
      cancelled = true
    }
  }, [])

  // Fires on mount and on every filter change, and deliberately does NOT wait
  // for /api/providers: the filter already names the provider it wants, and
  // 'all' is a complete answer the server can act on by itself.
  useEffect(() => {
    let cancelled = false
    setError(null)
    loadSessions(activeProject?.path, showArchived, filter, query)
      .catch((err) => {
        if (cancelled) return
        // No special case for a remembered filter naming a provider this server
        // no longer has: an unknown `provider` is answered with the DEFAULT
        // provider's sessions (200), not a 404 — verified against the running
        // server. So the worst case is the wrong list for as long as the effect
        // above takes to notice and correct the filter, not an error to show.
        setError((err as Error).message)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [activeProject, showArchived, loadSessions, filter, query])

  async function refresh() {
    setRefreshing(true)
    try {
      await loadSessions(activeProject?.path, showArchived, filter, query)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  async function handleCreated(session: SessionSummary) {
    // Inserted rather than re-fetched: a brand-new session has no history for
    // the server to return yet, so a reload here would show an empty list.
    setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)])
    setLastSessionCwd(session.cwd)
    setCreating(false)
    navigate(`/chat/${session.id}`)
  }

  async function handleRename(session: SessionSummary, name: string) {
    setActionsFor(null)
    // Optimistic — the list is cheap to reload if the server disagrees.
    setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, title: name } : s)))
    try {
      await api.renameSession(session.id, name)
    } catch (err) {
      setError((err as Error).message)
      void refresh()
    }
  }

  /**
   * A row changes hands between two lists, and neither direction is a no-op
   * here: archiving removes it from view (this is not the archive) and so does
   * unarchiving from the archive view. Both are removals, because the page
   * shows one of the two sets at a time and the row now belongs to the other.
   *
   * Which of the two happened is not needed to draw the result, so it is not
   * taken: the row leaves either way.
   */
  function handleArchived(session: SessionSummary) {
    setActionsFor(null)
    setSessions((prev) => prev.filter((s) => s.id !== session.id))
  }

  function handlePinned(session: SessionSummary, pinned: boolean) {
    setActionsFor(null)
    // Optimistic, and applied here rather than by refetching: the sort below is
    // what puts the row at the top, so a pin that worked is visible immediately.
    setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, pinned } : s)))
  }

  async function handleDelete(session: SessionSummary) {
    setActionsFor(null)
    setSessions((prev) => prev.filter((s) => s.id !== session.id))
    try {
      await api.deleteSession(session.id)
    } catch (err) {
      // A 404 means it was already gone — the list was stale, and what the user
      // asked for is true now. The row is off the screen already; reporting an
      // error and refreshing would put a red banner on a successful outcome.
      if (err instanceof ApiError && err.status === 404) return
      setError((err as Error).message)
      void refresh()
    }
  }

  /**
   * Pinned first, then "recently touched".
   *
   * Sorted here rather than by the server, and that is a decision rather than
   * laziness: `updatedAt` ordering is produced in three places (each provider's
   * own listing, plus the merge in `routes/sessions.ts` for `provider=all`), and
   * a fourth rule spread across them is three chances to disagree. The pin is
   * the page's own presentation, so it is applied where the rows are drawn.
   *
   * `sort` is stable, so rows that tie keep the order the server sent — which is
   * the recency order, unchanged.
   */
  const visible = useMemo(
    () =>
      [...sessions].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt),
    [sessions],
  )

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="safe-top shrink-0 border-b border-border bg-background/95 backdrop-blur-xl">
        {/* Keep the runner and provider selectors in the same header row. */}
        <ToolbarRow>
          <ToolbarIdentity icon={MessagesSquare} label="会话" />
          <RunnerSelector compact />

          {providers.length > 1 ? (
            <Select
              value={filter}
              // Radix only ever reports a value that exists as an item below,
              // and those are exactly 'all' and the provider ids.
              onValueChange={(next) => chooseFilter(next as ProviderFilter)}
            >
              <SelectTrigger
                aria-label="筛选代理"
                title={`筛选代理：${filter === 'all' ? '全部' : (providers.find((p) => p.id === filter)?.displayName ?? filter)}`}
                className={`relative h-11 w-11 shrink-0 justify-center gap-1.5 rounded-xl border-0 bg-transparent px-2 text-xs font-medium shadow-none focus-visible:ring-2 data-[size=default]:h-11 dark:bg-transparent dark:hover:bg-transparent [&>svg:last-child]:hidden ${
                  filter === 'all' ? 'text-muted-foreground' : 'text-foreground'
                }`}
              >
                <Bot aria-hidden="true" className="size-[18px]" strokeWidth={1.8} />
                {filter !== 'all' && (
                  <span aria-hidden="true" className="absolute right-2 top-2 size-1.5 rounded-full bg-primary" />
                )}
              </SelectTrigger>
              <SelectContent
                position="popper"
                align="start"
                className="min-w-48 rounded-xl border-border bg-popover p-1 shadow-xl"
              >
                <SelectGroup>
                  <SelectLabel className="px-2 pb-2 text-[11px] font-normal">筛选代理</SelectLabel>
                  <SelectItem value="all" className="min-h-11 rounded-lg">
                    全部
                  </SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="min-h-11 rounded-lg">
                      {/* Provider availability remains visible in the menu. */}
                      <span
                        className={`inline-block size-1.5 shrink-0 rounded-full ${
                          p.available ? 'bg-success' : 'bg-warning'
                        }`}
                      />
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            // No choice to offer, but the row still needs something to push the
            // refresh button to the right edge.
            <div className="flex-1" />
          )}

          <button
            type="button"
            onClick={() => {
              // Closing also clears: leaving a query behind a hidden box would
              // have the next open silently show a filtered list with nothing on
              // screen explaining why.
              if (searchOpen) clearSearch()
              setSearchOpen((v) => !v)
            }}
            className={`tap ml-auto rounded-xl active:bg-white/5 ${
              searchOpen ? 'text-foreground' : 'text-muted-foreground'
            }`}
            aria-label={searchOpen ? '关闭搜索' : '搜索会话'}
            aria-expanded={searchOpen}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="h-5 w-5"
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16 16l4.5 4.5" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="tap rounded-xl text-muted-foreground active:bg-white/5"
            aria-label="刷新"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`}
            >
              <path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </ToolbarRow>

        {/* Second row, only while searching: this is the field the magnifier
            button above opens. It has its own row because the first one has no
            room left for it (see there), and because a search is a mode — one
            that should be visible as one for as long as it is narrowing the
            list, which a collapsed field with a query in it would not be. */}
        {searchOpen && (
          <div className="flex items-center gap-2 px-4 pb-2">
            <input
              // biome-ignore lint/a11y/noAutofocus: the field is opened by an explicit tap and should be ready to type
              autoFocus
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标题…"
              aria-label="搜索会话标题"
              className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-secondary px-3 text-[15px] text-foreground placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={clearSearch}
                className="tap rounded-xl px-2 text-xs text-muted-foreground active:bg-white/5"
              >
                清除
              </button>
            )}
          </div>
        )}

        {projects.length > 1 && (
          <div className="scroll-x flex gap-1.5 px-4 pb-2">
            <Chip active={activeProject === null} onClick={() => setActiveProject(null)}>
              全部项目
            </Chip>
            {projects.map((project) => (
              <Chip
                key={project.id}
                active={activeProject?.id === project.id}
                onClick={() => setActiveProject(project)}
              >
                {project.name}
                {project.gitBranch ? ` · ${project.gitBranch}` : ''}
              </Chip>
            ))}
          </div>
        )}

        {/* Named, because with two providers "代理不可用" no longer says which
            one to go fix.

            An unauthenticated provider is listed here too, and that is the
            point of this banner: a CLI with no credentials is still perfectly
            `available` — it answers initialization and even lists models — so
            it showed up green while every turn died. The model list is the tell
            (`tokenSource: none` also reverts it to the CLI's built-in
            catalogue), which is why the wording mentions it. Settings has the
            same check with a longer explanation; this is the page people
            actually sit on. */}
        {providers
          .filter((p) => !p.available || p.authenticated === false)
          .map((p) => (
            <div key={p.id} className="border-t border-border bg-warning/15 px-4 py-1.5 text-[11px] text-warning">
              <span className="font-medium">{p.displayName}</span>
              {p.available
                ? ' · 未登录：请在服务器上为它配置凭据（模型列表可能也是 CLI 内置的）'
                : ` · ${p.detail ?? '不可用'}`}
            </div>
          ))}
      </header>

      <div ref={listRef} onScroll={rememberScroll} className="scroll-y min-h-0 flex-1 pb-20">
        {error && (
          <div className="border-b border-destructive/50 bg-destructive/15 px-4 py-2 text-[12px] text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-20 text-center text-sm text-muted-foreground/70">加载中…</div>
        ) : visible.length === 0 ? (
          <SessionListEmpty query={query} showArchived={showArchived} filter={filter} providerName={providerName} />
        ) : (
          <SessionList
            sessions={visible}
            providerName={providerName}
            onOpen={(session) => navigate('/chat/' + session.id)}
            onActions={setActionsFor}
          />
        )}

        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="w-full py-4 text-center text-[12px] text-muted-foreground/70"
        >
          {showArchived ? '隐藏已归档会话' : '显示已归档会话'}
        </button>
      </div>

      <button
        type="button"
        onClick={() => setCreating(true)}
        disabled={projects.length === 0}
        /* text-primary-foreground, not text-white: --primary is oklch(0.922),
           so white-on-white would leave the + invisible. */
        className="tap fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-30 h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-xl shadow-black/50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="新建会话"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          className="h-6 w-6"
        >
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
      </button>

      {creating && (
        <NewSessionSheet
          provider={createWith?.id ?? 'codex'}
          providers={providers}
          onProviderChange={setNewSessionProvider}
          projects={projects}
          initialCwd={lastSessionCwd || defaultCwd || projects[0]?.path || ''}
          onCwdChange={setLastSessionCwd}
          onClose={() => setCreating(false)}
          onCreated={handleCreated}
        />
      )}

      {actionsFor && (
        <SessionActions
          session={actionsFor}
          onClose={() => setActionsFor(null)}
          onRename={(name) => handleRename(actionsFor, name)}
          onDelete={() => handleDelete(actionsFor)}
          onArchived={() => handleArchived(actionsFor)}
          onPinned={(pinned) => handlePinned(actionsFor, pinned)}
        />
      )}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tap shrink-0 min-h-[38px] rounded-full px-3.5 py-1.5 text-xs font-medium whitespace-nowrap transition-all ${
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'bg-secondary text-muted-foreground border border-border active:bg-raised active:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
