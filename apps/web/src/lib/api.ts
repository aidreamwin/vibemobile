import type {
  CreateSessionOptions,
  FileContent,
  FileEntry,
  HealthResponse,
  LoginResponse,
  ModelInfo,
  Project,
  ProviderStatus,
  RunnerTokenResponse,
  SessionSummary,
  Transcript,
} from '@vibemobile/protocol'
import { runnerPath, type RunnerInfo } from './runner'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Hub-level endpoints: auth, mode detection and runner management. Everything
  // else belongs to the runner currently in the URL scope.
  const hubLevel =
    path.startsWith('/api/auth/') || path === '/api/hub' || path === '/api/runners' || path.startsWith('/api/runners/')
  const scoped = hubLevel ? path : runnerPath(path)
  const res = await fetch(scoped, {
    // The session lives in an httpOnly cookie.
    credentials: 'include',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })

  if (res.status === 401) {
    throw new ApiError('unauthorized', 401, 'unauthorized')
  }

  const text = await res.text()
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!res.ok) {
    const code = typeof body === 'object' && typeof body?.error === 'string' ? body.error : undefined
    const message =
      typeof body === 'object' && typeof body?.message === 'string' ? body.message : (code ?? `HTTP ${res.status}`)
    throw new ApiError(message, res.status, code)
  }
  return body as T
}

/**
 * Where an image token on a transcript message resolves to.
 *
 * A relative URL, so the httpOnly session cookie rides along on the `<img>`
 * request without anything having to attach it. Not part of `api` below
 * because it is not a JSON call — it returns bytes to an `<img>`, never to
 * `request()`.
 */
export const imageUrl = (token: string) => runnerPath(`/api/images/${encodeURIComponent(token)}`)

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') search.set(k, String(v))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

export const api = {
  hubMode: () => request<{ mode: 'hub' }>('/api/hub'),
  runners: () => request<{ default: string; data: RunnerInfo[] }>('/api/runners'),
  createRunner: (name: string) =>
    request<RunnerTokenResponse>('/api/runners', { method: 'POST', body: JSON.stringify({ name }) }),
  refreshRunnerToken: (id: string) =>
    request<RunnerTokenResponse>(`/api/runners/${encodeURIComponent(id)}/token`, { method: 'POST' }),
  deleteRunner: (id: string) => request<{ ok: true }>(`/api/runners/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // ---- auth ----
  authMode: () => request<{ authDisabled: boolean }>('/api/auth/mode'),
  login: (pin: string) => request<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  logoutAll: () => request<{ ok: true }>('/api/auth/logout-all', { method: 'POST' }),
  me: () => request<{ authenticated: boolean }>('/api/auth/me'),

  // ---- features ----
  features: () => request<{ terminal: boolean; terminalReason: string | null }>('/api/features'),

  // ---- health & build ----
  // Unauthenticated on the server side, and deliberately called on every visit to
  // Settings rather than cached: its whole point is to report what the process
  // loaded *right now*, and a cached answer would keep saying "old" after a restart.
  health: () => request<HealthResponse>('/api/health'),

  // ---- providers ----
  providers: () => request<{ data: ProviderStatus[]; default: string | null }>('/api/providers'),
  models: (provider: string) => request<{ data: ModelInfo[] }>(`/api/providers/${encodeURIComponent(provider)}/models`),

  // ---- projects & sessions ----
  projects: () => request<{ data: Project[] }>('/api/projects'),
  sessions: (params: { provider?: string; cwd?: string; limit?: number; archived?: boolean; search?: string } = {}) =>
    request<{ data: SessionSummary[] }>(`/api/sessions${qs(params)}`),
  session: (id: string, opts: { limit?: number; cursor?: string; items?: number } = {}) =>
    request<Transcript>(`/api/sessions/${id}${qs({ limit: opts.limit, cursor: opts.cursor, items: opts.items })}`),
  createSession: (opts: CreateSessionOptions) =>
    request<SessionSummary>('/api/sessions', { method: 'POST', body: JSON.stringify(opts) }),
  renameSession: (id: string, name: string) =>
    request<{ ok: true }>(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteSession: (id: string) => request<{ ok: true }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  archiveSession: (id: string, archived = true) =>
    request<{ ok: true }>(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),
  pinSession: (id: string, pinned: boolean) =>
    request<{ ok: true }>(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    }),
  openSession: (id: string) => request<SessionSummary>(`/api/sessions/${id}/open`, { method: 'POST' }),
  forkSession: (id: string) => request<SessionSummary>(`/api/sessions/${id}/fork`, { method: 'POST' }),

  // ---- files ----
  files: (path?: string, hidden = false) => request<{ data: FileEntry[] }>(`/api/files${qs({ path, hidden })}`),
  fileContent: (path: string) => request<FileContent>(`/api/files/content${qs({ path })}`),
  /**
   * Save a file. `rev` is the digest of the text being replaced; the server
   * answers 409 `file_changed` if the file is no longer that revision, which
   * the editor resolves by re-reading rather than by overwriting.
   */
  saveFile: (path: string, text: string, rev?: string) =>
    request<FileContent>('/api/files/content', {
      method: 'PUT',
      body: JSON.stringify({ path, text, ...(rev ? { rev } : {}) }),
    }),
  fileDiff: (root?: string, path?: string) => request<{ diff: string }>(`/api/files/diff${qs({ root, path })}`),
}
