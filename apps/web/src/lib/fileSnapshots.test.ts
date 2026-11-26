import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent, FileEntry } from '@vibemobile/protocol'
import { api, ApiError } from './api'
import {
  clearFileSnapshots,
  getDirectorySnapshot,
  getFileSnapshot,
  invalidateDirectorySnapshot,
  readDirectorySnapshot,
  readFileSnapshot,
  rememberFileSnapshot,
} from './fileSnapshots'

const path = '/example.ts'
const initial: FileContent = { path, text: 'initial', rev: '1', bytes: 7, truncated: false }
const saved: FileContent = { ...initial, text: 'saved', rev: '2', bytes: 5 }

function deferredRead() {
  let resolve!: (content: FileContent) => void
  const promise = new Promise<FileContent>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

beforeEach(clearFileSnapshots)
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('file snapshots', () => {
  it('shares concurrent reads, reuses fresh content and preserves identity when revalidated', async () => {
    vi.useFakeTimers()
    const request = vi.spyOn(api, 'fileContent').mockResolvedValue({ ...initial })
    const pending = readFileSnapshot(path)
    expect(readFileSnapshot(path)).toBe(pending)
    const snapshot = await pending
    expect(await readFileSnapshot(path)).toBe(snapshot)
    expect(request).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_001)
    expect(await readFileSnapshot(path)).toBe(snapshot)
    expect(request).toHaveBeenCalledTimes(2)

    await readFileSnapshot(path, true)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('preserves saved content when an earlier read finishes afterwards', async () => {
    const { promise, resolve } = deferredRead()
    vi.spyOn(api, 'fileContent').mockReturnValue(promise)
    const pending = readFileSnapshot(path)
    rememberFileSnapshot(path, saved)
    resolve(initial)
    expect(await pending).toBe(saved)
    expect(getFileSnapshot(path)).toBe(saved)
  })

  it('discards revoked snapshots and drops pending reads when the cache is cleared', async () => {
    rememberFileSnapshot(path, initial)
    const request = vi.spyOn(api, 'fileContent').mockRejectedValue(new ApiError('forbidden', 403))
    await expect(readFileSnapshot(path, true)).rejects.toThrow('forbidden')
    expect(getFileSnapshot(path)).toBeNull()

    const { promise, resolve } = deferredRead()
    request.mockReturnValue(promise)
    const pending = readFileSnapshot(path)
    clearFileSnapshots()
    resolve(initial)
    await pending
    expect(getFileSnapshot(path)).toBeNull()
  })
})

describe('directory snapshots', () => {
  const root = '/workspace'
  const entries: FileEntry[] = [
    { path: '/workspace/main.ts', name: 'main.ts', type: 'file', size: 5 },
    { path: '/workspace/next', name: 'next', type: 'directory' },
  ]

  it('deduplicates concurrent requests, uses a fresh directory and preserves identical row references', async () => {
    vi.useFakeTimers()
    const request = vi.spyOn(api, 'files').mockImplementation(async () => ({
      data: entries.map((entry) => ({ ...entry })),
    }))
    const pending = readDirectorySnapshot(root)
    expect(readDirectorySnapshot(root)).toBe(pending)
    const snapshot = await pending
    expect(await readDirectorySnapshot(root)).toBe(snapshot)
    expect(request).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5_001)
    expect(await readDirectorySnapshot(root)).toBe(snapshot)
    expect(request).toHaveBeenCalledTimes(2)

    request.mockResolvedValue({ data: [{ ...entries[0], size: 10 }, { ...entries[1] }] })
    const refreshed = await readDirectorySnapshot(root, true)
    expect(request).toHaveBeenCalledTimes(3)
    expect(refreshed[0]).not.toBe(snapshot[0])
    expect(refreshed[1]).toBe(snapshot[1])
    expect(refreshed[0].size).toBe(10)
  })

  it('invalidates a directory when saved file metadata changes and when access is revoked', async () => {
    const request = vi.spyOn(api, 'files').mockResolvedValue({ data: entries })
    await readDirectorySnapshot(root)
    invalidateDirectorySnapshot(root)
    expect(getDirectorySnapshot(root)).toBeNull()
    await readDirectorySnapshot(root)
    expect(request).toHaveBeenCalledTimes(2)

    request.mockRejectedValue(new ApiError('forbidden', 403))
    await expect(readDirectorySnapshot(root, true)).rejects.toThrow('forbidden')
    expect(getDirectorySnapshot(root)).toBeNull()
  })

  it('does not let a cleared or invalidated request repopulate the cache', async () => {
    let finish!: (response: { data: FileEntry[] }) => void
    const request = vi.spyOn(api, 'files').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = readDirectorySnapshot(root)
    invalidateDirectorySnapshot(root)
    finish({ data: entries })
    await pending
    expect(getDirectorySnapshot(root)).toBeNull()

    const afterInvalidation = readDirectorySnapshot(root)
    clearFileSnapshots()
    finish({ data: entries })
    await afterInvalidation
    expect(getDirectorySnapshot(root)).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
  })
})
