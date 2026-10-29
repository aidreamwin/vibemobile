import { create } from 'zustand'
import type { Project } from '@vibemobile/protocol'
import { api } from './api'
import { runnerStorageKey } from './runner'

const STORAGE_KEY = runnerStorageKey('vibemobile.defaultCwd')
const LAST_SESSION_STORAGE_KEY = runnerStorageKey('vibemobile.lastSessionCwd')

function comparablePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized && value.startsWith('/')) return '/'
  // The UI may run on a phone while the server runs on Windows. Comparing
  // case-insensitively keeps a persisted Windows path valid across reloads.
  return normalized.toLocaleLowerCase('en-US')
}

export function isPathInside(candidate: string, root: string): boolean {
  const child = comparablePath(candidate)
  const parent = comparablePath(root)
  if (!child || !parent) return false
  if (child === parent) return true
  if (parent === '/') return child.startsWith('/')
  return child.startsWith(`${parent}/`)
}

export function workspaceRootFor(projects: Project[], candidate: string): Project | undefined {
  return projects
    .filter((project) => isPathInside(candidate, project.path))
    .sort((a, b) => comparablePath(b.path).length - comparablePath(a.path).length)[0]
}

export function parentPath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (separator < 0) return value
  if (separator === 0) return trimmed.slice(0, 1)
  // Preserve the separator in a Windows drive root (`D:\\`).
  if (separator === 2 && /^[a-z]:/i.test(trimmed)) return trimmed.slice(0, 3)
  return trimmed.slice(0, separator)
}

export function chooseDefaultCwd(projects: Project[], preferred: string): string {
  return preferred && workspaceRootFor(projects, preferred) ? preferred : (projects[0]?.path ?? '')
}

function readStoredCwd(): string {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function readStoredLastSessionCwd(): string {
  try {
    return globalThis.localStorage?.getItem(LAST_SESSION_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function persistCwd(cwd: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, cwd)
  } catch {
    // Private browsing and locked-down WebViews may reject storage writes.
  }
}

function persistLastSessionCwd(cwd: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_SESSION_STORAGE_KEY, cwd)
  } catch {
    // Private browsing and locked-down WebViews may reject storage writes.
  }
}

interface WorkspaceState {
  projects: Project[]
  defaultCwd: string
  lastSessionCwd: string
  loading: boolean
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  setDefaultCwd: (cwd: string) => void
  setLastSessionCwd: (cwd: string) => void
}

let pendingLoad: Promise<void> | null = null

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  projects: [],
  defaultCwd: readStoredCwd(),
  lastSessionCwd: readStoredLastSessionCwd(),
  loading: false,
  loaded: false,
  error: null,

  async load() {
    if (get().loaded) return
    if (pendingLoad) return pendingLoad

    set({ loading: true, error: null })
    pendingLoad = api
      .projects()
      .then(({ data }) => {
        const defaultCwd = chooseDefaultCwd(data, get().defaultCwd || readStoredCwd())
        const lastSessionCwd = chooseDefaultCwd(data, get().lastSessionCwd || readStoredLastSessionCwd() || defaultCwd)
        persistCwd(defaultCwd)
        persistLastSessionCwd(lastSessionCwd)
        set({ projects: data, defaultCwd, lastSessionCwd, loaded: true })
      })
      .catch((err) => {
        set({ error: (err as Error).message })
      })
      .finally(() => {
        set({ loading: false })
        pendingLoad = null
      })

    return pendingLoad
  },

  setDefaultCwd(cwd) {
    const next = chooseDefaultCwd(get().projects, cwd)
    persistCwd(next)
    set({ defaultCwd: next })
  },

  setLastSessionCwd(cwd) {
    const next = chooseDefaultCwd(get().projects, cwd)
    persistLastSessionCwd(next)
    set({ lastSessionCwd: next })
  },
}))
