import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { LoaderCircle, RotateCcw, WifiOff } from 'lucide-react'
import { api, ApiError } from './lib/api'
import { socket } from './lib/ws'
import Sessions from './pages/Sessions'
import BottomNav from './components/BottomNav'
import UpdateBanner from './components/UpdateBanner'
import { Button } from './components/ui/button'
import { useWorkspaceStore } from './lib/workspace'
import { pathAfterScope, runnerId, runnerSwitchUrl } from './lib/runner'
import { routeTitle, useDocumentTitle } from './lib/title'
import { useIsDesktop } from './lib/viewport'
import { clearSessionLists, updateSessionListsStatus } from './lib/sessionLists'
import { clearFileSnapshots } from './lib/fileSnapshots'
import { clearRunnerSnapshot, readRunnerSnapshot } from './lib/runnerSnapshot'
import { clearProviderSnapshot } from './lib/providerSnapshot'

// The landing page stays eager; everything else is fetched when its route is
// opened. That keeps xterm (Terminal) and react-markdown (Chat / Files) out of
// the first load.
const Login = lazy(() => import('./pages/Login'))
const Chat = lazy(() => import('./pages/Chat'))
const Files = memo(lazy(() => import('./pages/Files')))
const Terminal = memo(lazy(() => import('./pages/Terminal')))
const Settings = lazy(() => import('./pages/Settings'))
const DesktopWorkbenchShell = lazy(() => import('./components/desktop/DesktopWorkbenchShell'))

function PageFallback({ full = false }: { full?: boolean }) {
  return (
    <div className={`${full ? 'app-height' : 'h-full'} flex items-center justify-center text-muted-foreground`}>
      加载中…
    </div>
  )
}

const MAX_MOBILE_CHATS = 2

function MobilePages({ onLogout }: { onLogout: () => void }) {
  const pathname = useLocation().pathname.replace(/\/+$/, '').toLowerCase() || '/'
  const navigate = useNavigate()
  const threadId = useMatch('/chat/:threadId')?.params.threadId
  const navigateRef = useRef(navigate)
  useLayoutEffect(() => {
    navigateRef.current = navigate
  }, [navigate])
  const [recentChats, setRecentChats] = useState<string[]>([])
  const [terminalVisited, setTerminalVisited] = useState(pathname === '/terminal')
  const [filesVisited, setFilesVisited] = useState(pathname === '/files')
  const chatIds = [...new Set([...(threadId ? [threadId] : []), ...recentChats])].slice(0, MAX_MOBILE_CHATS)
  const exitChat = useCallback(() => navigateRef.current('/'), [])
  const selectChat = useCallback(
    (id: string) => navigateRef.current(`/chat/${encodeURIComponent(id)}`, { replace: true }),
    [],
  )

  useEffect(() => {
    if (threadId)
      setRecentChats((previous) =>
        previous[0] === threadId
          ? previous
          : [threadId, ...previous.filter((id) => id !== threadId)].slice(0, MAX_MOBILE_CHATS),
      )
  }, [threadId])
  useEffect(() => {
    if (pathname === '/terminal') setTerminalVisited(true)
    if (pathname === '/files') setFilesVisited(true)
  }, [pathname])

  if (!threadId && !['/', '/files', '/terminal', '/settings'].includes(pathname)) return <Navigate to="/" replace />

  return (
    <div className="app-height flex flex-col overflow-hidden">
      <UpdateBanner />
      <main className="relative min-h-0 flex-1">
        {pathname === '/' && <Sessions />}
        {chatIds.map((id) => (
          <div key={id} hidden={id !== threadId} inert={id !== threadId} className="h-full">
            <Suspense fallback={<PageFallback />}>
              <Chat threadId={id} visible={threadId === id} onExit={exitChat} onSelectSession={selectChat} />
            </Suspense>
          </div>
        ))}
        {(filesVisited || pathname === '/files') && (
          <div hidden={pathname !== '/files'} inert={pathname !== '/files'} className="h-full">
            <Suspense fallback={<PageFallback />}>
              <Files visible={pathname === '/files'} />
            </Suspense>
          </div>
        )}
        {(terminalVisited || pathname === '/terminal') && (
          <div hidden={pathname !== '/terminal'} inert={pathname !== '/terminal'} className="h-full">
            <Suspense fallback={<PageFallback />}>
              <Terminal visible={pathname === '/terminal'} />
            </Suspense>
          </div>
        )}
        {pathname === '/settings' && (
          <Suspense fallback={<PageFallback />}>
            <Settings onLogout={onLogout} />
          </Suspense>
        )}
      </main>
      {!threadId && <BottomNav />}
    </div>
  )
}

type AuthState = 'checking' | 'authed' | 'anonymous' | 'offline'

export default function App() {
  const [auth, setAuth] = useState<AuthState>('checking')
  const logout = useCallback(() => {
    clearSessionLists()
    clearFileSnapshots()
    clearRunnerSnapshot()
    clearProviderSnapshot()
    setAuth('anonymous')
  }, [])
  const [bootError, setBootError] = useState<string | null>(null)
  /** Bumped by the retry button; the effect below re-runs on it. */
  const [bootAttempt, setBootAttempt] = useState(0)
  const location = useLocation()
  const isDesktop = useIsDesktop()
  // A runner prefix is part of every path under /r/<id>; the title is the same
  // page either way. Pages with real content override this below.
  const routePath = pathAfterScope(location.pathname).replace(/\/+$/, '').toLowerCase() || '/'
  useDocumentTitle(
    auth === 'authed' && (isDesktop || routePath.startsWith('/chat/') || routePath === '/files')
      ? null
      : routeTitle(routePath),
  )
  const loadWorkspace = useWorkspaceStore((state) => state.load)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Hub discovery is public, and can run while authentication is checked.
        const hubProbe = api.hubMode().then(
          () => ({ available: true as const }),
          (error: unknown) => ({ available: false as const, error }),
        )
        // The deployment's own flag first, because it is authoritative about
        // whether a PIN exists at all: with `authDisabled`, `requireAuth` lets
        // every request through, so a PIN form can only ever be a dead end —
        // and anything that answers 401 for `/api/auth/me` on such a server is
        // a proxy or a stale cookie talking, not this server's policy. Asking
        // is one cheap unauthenticated GET.
        const { authDisabled } = await api.authMode()
        if (cancelled) return
        if (!authDisabled) await api.me()
        // The old standalone server has no Hub endpoint; preserve that mode.
        const hub = await hubProbe
        if (cancelled) return
        if (!hub.available && !(hub.error instanceof ApiError && hub.error.status === 404)) {
          throw hub.error
        }
        if (hub.available) {
          const runners = await readRunnerSnapshot()
          if (cancelled) return
          if (!runners.data.some((runner) => runner.id === runnerId)) {
            // A known scope that no longer exists keeps its page; a URL with no
            // scope at all is an old bookmark and goes to the default root.
            window.location.replace(
              runnerId ? runnerSwitchUrl(runners.default) : `/r/${encodeURIComponent(runners.default)}/`,
            )
            return
          }
        }
        if (!cancelled) setAuth('authed')
      } catch (err) {
        if (cancelled) return
        // Three outcomes, and they used to be one: a 401 is the only one that
        // means "type your PIN". A server that is down, unreachable, or
        // broken is not a login problem, and dropping the user on the PIN page
        // for it is what made "the app is asking for my PIN again" the
        // reported symptom of a server that was merely restarting.
        if (err instanceof ApiError && err.status === 401) {
          logout()
          return
        }
        setBootError(err instanceof Error ? err.message : String(err))
        setAuth('offline')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bootAttempt, logout])

  useEffect(() => {
    if (auth !== 'authed') return
    const unsubscribe = socket.onEvent((event) => {
      if (event.kind === 'session.status') updateSessionListsStatus(event.threadId, event.status)
    })
    socket.connect()
    return unsubscribe
  }, [auth])

  useEffect(() => {
    if (auth === 'authed') void loadWorkspace()
  }, [auth, loadWorkspace])

  if (auth === 'checking') {
    return (
      <div role="status" className="app-height flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> 连接中…
      </div>
    )
  }

  if (auth === 'offline') {
    // Deliberately not the PIN page and deliberately not a spinner: a phone
    // that was asleep when the server restarted lands here, and the only thing
    // it can be told is the truth plus a way to try again.
    return (
      <main className="app-height safe-top safe-bottom flex flex-col items-center justify-center gap-5 px-6 text-center">
        <div className="max-w-sm">
          <span className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
            <WifiOff aria-hidden="true" className="size-7" strokeWidth={1.6} />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">连不上服务器</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            检查网络连接，确认开发机上的服务已启动，然后重试。
          </p>
          <p className="mt-3 break-all font-mono text-xs text-muted-foreground">{window.location.host}</p>
          {bootError && (
            <p role="status" className="mt-1 wrap-break-word text-xs text-muted-foreground">
              {bootError}
            </p>
          )}
        </div>
        <Button
          type="button"
          size="lg"
          onClick={() => {
            setBootError(null)
            setAuth('checking')
            setBootAttempt((attempt) => attempt + 1)
          }}
          className="h-12 w-full max-w-xs rounded-xl text-sm"
        >
          <RotateCcw aria-hidden="true" className="size-4" /> 重试
        </Button>
        {/* The escape hatch for the one case the flag cannot cover: a server
            that reports a PIN but will not accept the session it is holding. */}
        <button
          type="button"
          onClick={logout}
          className="tap rounded-lg px-4 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          去登录页
        </button>
      </main>
    )
  }

  if (auth === 'anonymous') {
    return (
      <Suspense fallback={<PageFallback full />}>
        <Routes>
          <Route
            path="/login"
            element={
              <Login
                onSuccess={() => {
                  setAuth('checking')
                  setBootAttempt((attempt) => attempt + 1)
                }}
              />
            }
          />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    )
  }

  if (isDesktop) {
    return (
      <Suspense fallback={<PageFallback full />}>
        <DesktopWorkbenchShell onLogout={logout} />
      </Suspense>
    )
  }

  return <MobilePages onLogout={logout} />
}
