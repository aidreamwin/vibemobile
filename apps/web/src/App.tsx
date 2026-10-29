import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { api, ApiError } from './lib/api'
import { socket } from './lib/ws'
import Sessions from './pages/Sessions'
import BottomNav from './components/BottomNav'
import { Button } from './components/ui/button'
import { useWorkspaceStore } from './lib/workspace'
import { runnerId, runnerSwitchUrl } from './lib/runner'

// The landing page stays eager; everything else is fetched when its route is
// opened. That keeps xterm (Terminal) and react-markdown (Chat / Files) out of
// the first load.
const Login = lazy(() => import('./pages/Login'))
const Chat = lazy(() => import('./pages/Chat'))
const Files = lazy(() => import('./pages/Files'))
const Terminal = lazy(() => import('./pages/Terminal'))
const Settings = lazy(() => import('./pages/Settings'))

function PageFallback({ full = false }: { full?: boolean }) {
  return (
    <div className={`${full ? 'app-height' : 'h-full'} flex items-center justify-center text-muted-foreground`}>
      加载中…
    </div>
  )
}

type AuthState = 'checking' | 'authed' | 'anonymous' | 'offline'

export default function App() {
  const [auth, setAuth] = useState<AuthState>('checking')
  const [bootError, setBootError] = useState<string | null>(null)
  /** Bumped by the retry button; the effect below re-runs on it. */
  const [bootAttempt, setBootAttempt] = useState(0)
  const location = useLocation()
  const loadWorkspace = useWorkspaceStore((state) => state.load)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
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
        let isHub = false
        try {
          await api.hubMode()
          isHub = true
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err
        }
        if (isHub) {
          const runners = await api.runners()
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
          setAuth('anonymous')
          return
        }
        setBootError(err instanceof Error ? err.message : String(err))
        setAuth('offline')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bootAttempt])

  useEffect(() => {
    if (auth === 'authed') socket.connect()
  }, [auth])

  useEffect(() => {
    if (auth === 'authed') void loadWorkspace()
  }, [auth, loadWorkspace])

  // The chat view owns the full height and hides the bottom nav.
  const isChat = location.pathname.startsWith('/chat/')

  if (auth === 'checking') {
    return <div className="app-height flex items-center justify-center text-muted-foreground">连接中…</div>
  }

  if (auth === 'offline') {
    // Deliberately not the PIN page and deliberately not a spinner: a phone
    // that was asleep when the server restarted lands here, and the only thing
    // it can be told is the truth plus a way to try again.
    return (
      <div className="app-height flex flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="max-w-sm">
          <h1 className="text-base font-semibold text-foreground">连不上服务器</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            请确认手机和电脑在同一个网络里，电脑上的服务已经启动，然后重试。
          </p>
          {bootError && <p className="mt-2 wrap-break-word text-xs text-muted-foreground/70">{bootError}</p>}
        </div>
        <Button
          type="button"
          size="lg"
          onClick={() => {
            setBootError(null)
            setAuth('checking')
            setBootAttempt((attempt) => attempt + 1)
          }}
          className="min-h-11 rounded-lg px-4 text-sm"
        >
          重试
        </Button>
        {/* The escape hatch for the one case the flag cannot cover: a server
            that reports a PIN but will not accept the session it is holding. */}
        <button
          type="button"
          onClick={() => setAuth('anonymous')}
          className="text-xs text-muted-foreground underline underline-offset-2"
        >
          去登录页
        </button>
      </div>
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

  return (
    <div className="app-height flex flex-col overflow-hidden">
      <main className="min-h-0 flex-1">
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Sessions />} />
            <Route path="/chat/:threadId" element={<Chat />} />
            <Route path="/files" element={<Files />} />
            <Route path="/terminal" element={<Terminal />} />
            <Route path="/settings" element={<Settings onLogout={() => setAuth('anonymous')} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
      {!isChat && <BottomNav />}
    </div>
  )
}
