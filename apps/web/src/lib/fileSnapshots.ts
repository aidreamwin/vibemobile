import type { FileContent } from '@vibemobile/protocol'
import { api, ApiError } from './api'

// This module belongs to the current runner. Switching runners reloads the app.
const MAX_FILES = 12
const FRESH_MS = 2_000
const snapshots = new Map<string, { content: FileContent; fetchedAt: number }>()
const pending = new Map<string, Promise<FileContent>>()

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
