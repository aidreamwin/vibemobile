import type { SessionStatus, SessionSummary } from '@vibemobile/protocol'
import { api } from './api'

type SessionQuery = NonNullable<Parameters<typeof api.sessions>[0]>

const MAX_CACHED_LISTS = 12
const FRESH_FOR_MS = 15_000
const snapshots = new Map<string, { data: SessionSummary[]; loadedAt: number }>()
const requests = new Map<string, { promise: Promise<SessionSummary[]>; statuses: Map<string, SessionStatus> }>()

function keyFor(query: SessionQuery) {
  return JSON.stringify([query.provider, query.cwd, Boolean(query.archived), query.limit, query.search || ''])
}

export function cachedSessionList(query: SessionQuery) {
  return snapshots.get(keyFor(query))?.data
}

export function loadSessionList(query: SessionQuery, force = false): Promise<SessionSummary[]> {
  const key = keyFor(query)
  const pending = requests.get(key)
  if (pending) return pending.promise
  const cached = snapshots.get(key)
  if (!force && cached && Date.now() - cached.loadedAt < FRESH_FOR_MS) return Promise.resolve(cached.data)

  const statuses = new Map<string, SessionStatus>()
  const promise = api
    .sessions(query)
    .then(({ data }) => {
      const sessions = statuses.size
        ? data.map((session) => {
            const status = statuses.get(session.id)
            return status && status !== session.status ? { ...session, status } : session
          })
        : data
      if (requests.get(key)?.promise === promise) {
        snapshots.delete(key)
        snapshots.set(key, { data: sessions, loadedAt: Date.now() })
        if (snapshots.size > MAX_CACHED_LISTS) {
          const oldest = snapshots.keys().next().value
          if (oldest !== undefined) snapshots.delete(oldest)
        }
      }
      return sessions
    })
    .finally(() => {
      if (requests.get(key)?.promise === promise) requests.delete(key)
    })
  requests.set(key, { promise, statuses })
  return promise
}

export function withSessionStatus(sessions: SessionSummary[], id: string, status: SessionStatus) {
  const index = sessions.findIndex((session) => session.id === id)
  if (index === -1 || sessions[index].status === status) return sessions
  const next = [...sessions]
  next[index] = { ...next[index], status }
  return next
}

export function updateSessionListsStatus(id: string, status: SessionStatus) {
  for (const snapshot of snapshots.values()) {
    snapshot.data = withSessionStatus(snapshot.data, id, status)
  }
  for (const request of requests.values()) request.statuses.set(id, status)
}

export function clearSessionLists() {
  snapshots.clear()
  requests.clear()
}
