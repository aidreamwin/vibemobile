import type { FileContent, FileEntry } from '@vibemobile/protocol'
import { api, ApiError } from './api'
import { filePathKey } from './fileLink'

// This module belongs to the current runner. Switching runners reloads the app.
const MAX_FILES = 12
const FRESH_MS = 2_000
const snapshots = new Map<string, { content: FileContent; fetchedAt: number }>()
const pending = new Map<string, Promise<FileContent>>()
const MAX_DIRECTORIES = 12
const DIRECTORY_FRESH_MS = 5_000
const directories = new Map<string, { entries: FileEntry[]; fetchedAt: number }>()
const pendingDirectories = new Map<string, Promise<FileEntry[]>>()

export const fileDrafts = new Map<string, { text: string; base: FileContent }>()
export const savingFiles = new Set<string>()

export function hasFileEdits(path: string): boolean {
  const key = filePathKey(path)
  return [...fileDrafts.keys(), ...savingFiles].some((candidate) => filePathKey(candidate) === key)
}

export function getFileSnapshot(path: string): FileContent | null {
  return snapshots.get(path)?.content ?? null
}

export function rememberFileSnapshot(path: string, content: FileContent) {
  pending.delete(path)
  snapshots.delete(path)
  snapshots.set(path, { content, fetchedAt: Date.now() })
  if (snapshots.size > MAX_FILES) {
    const oldest = snapshots.keys().next().value
    if (oldest !== undefined) snapshots.delete(oldest)
  }
}

export function clearFileSnapshots() {
  snapshots.clear()
  pending.clear()
  directories.clear()
  pendingDirectories.clear()
}

export function invalidateFileSnapshot(path: string) {
  const key = filePathKey(path)
  for (const candidate of new Set([...snapshots.keys(), ...pending.keys()])) {
    if (filePathKey(candidate) === key) {
      snapshots.delete(candidate)
      pending.delete(candidate)
    }
  }
}

export function getDirectorySnapshot(path: string): FileEntry[] | null {
  return directories.get(path)?.entries ?? null
}

export function invalidateDirectorySnapshot(path: string) {
  directories.delete(path)
  pendingDirectories.delete(path)
}

export function readDirectorySnapshot(path: string, force = false): Promise<FileEntry[]> {
  const inFlight = pendingDirectories.get(path)
  if (inFlight) return inFlight

  const cached = directories.get(path)
  if (cached) {
    directories.delete(path)
    directories.set(path, cached)
    if (!force && Date.now() - cached.fetchedAt < DIRECTORY_FRESH_MS) return Promise.resolve(cached.entries)
  }

  const request = api.files(path).then(
    ({ data }) => {
      if (pendingDirectories.get(path) !== request) return getDirectorySnapshot(path) ?? data
      pendingDirectories.delete(path)
      const previous = directories.get(path)?.entries
      // Retain row identities so background refresh doesn't redraw identical entries.
      const byPath = new Map(previous?.map((entry) => [entry.path, entry]))
      const next = data.map((entry) => {
        const old = byPath.get(entry.path)
        return old?.name === entry.name && old.type === entry.type && old.size === entry.size ? old : entry
      })
      const entries =
        previous?.length === next.length && previous.every((entry, index) => entry === next[index]) ? previous : next
      directories.delete(path)
      directories.set(path, { entries, fetchedAt: Date.now() })
      if (directories.size > MAX_DIRECTORIES) {
        const oldest = directories.keys().next().value
        if (oldest !== undefined) directories.delete(oldest)
      }
      return entries
    },
    (error: unknown) => {
      if (pendingDirectories.get(path) === request) {
        pendingDirectories.delete(path)
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) directories.delete(path)
      }
      throw error
    },
  )
  pendingDirectories.set(path, request)
  return request
}

export function readFileSnapshot(path: string, force = false): Promise<FileContent> {
  const inFlight = pending.get(path)
  if (inFlight) return inFlight

  const cached = snapshots.get(path)
  if (!force && cached && Date.now() - cached.fetchedAt < FRESH_MS) {
    snapshots.delete(path)
    snapshots.set(path, cached)
    return Promise.resolve(cached.content)
  }

  const request = api.fileContent(path).then(
    (response) => {
      if (pending.get(path) !== request) return getFileSnapshot(path) ?? response
      // Preserve object identity when revalidation returns identical content.
      const previous = snapshots.get(path)?.content
      const unchanged =
        previous &&
        previous.rev === response.rev &&
        previous.text === response.text &&
        previous.bytes === response.bytes &&
        previous.truncated === response.truncated &&
        previous.path === response.path
      const content = unchanged ? previous : response
      rememberFileSnapshot(path, content)
      return content
    },
    (error: unknown) => {
      if (pending.get(path) === request) {
        pending.delete(path)
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) snapshots.delete(path)
      }
      throw error
    },
  )
  pending.set(path, request)
  return request
}
