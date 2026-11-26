import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent } from '@vibemobile/protocol'
import { api, ApiError } from './api'
import { clearFileSnapshots, getFileSnapshot, readFileSnapshot, rememberFileSnapshot } from './fileSnapshots'

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
