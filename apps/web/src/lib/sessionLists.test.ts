import type { SessionSummary } from '@vibemobile/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { cachedSessionList, clearSessionLists, loadSessionList, updateSessionListsStatus } from './sessionLists'

const query = { provider: 'all', limit: 60 }
const session: SessionSummary = {
  id: 'session-1',
  provider: 'codex',
  title: 'Session',
  preview: '',
  cwd: '/workspace',
  status: 'idle',
  needsAttention: false,
  createdAt: 0,
  updatedAt: 0,
}

afterEach(() => {
  clearSessionLists()
  vi.restoreAllMocks()
})

describe('session list snapshots', () => {
  it('shares a request and reuses its result until refresh', async () => {
    const fetch = vi.spyOn(api, 'sessions').mockResolvedValue({ data: [session] })
    const first = loadSessionList(query)
    expect(loadSessionList({ ...query, archived: false })).toBe(first)
    const result = await first
    expect(cachedSessionList(query)).toBe(result)
    expect(await loadSessionList(query)).toBe(result)
    expect(fetch).toHaveBeenCalledTimes(1)

    await loadSessionList(query, true)
    await loadSessionList({ ...query, search: 'different' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps live status when it arrives before the response or before returning to the list', async () => {
    const fetch = vi.spyOn(api, 'sessions').mockResolvedValue({ data: [session] })
    const request = loadSessionList(query)
    updateSessionListsStatus(session.id, 'working')
    expect(await request).toMatchObject([{ status: 'working' }])

    updateSessionListsStatus(session.id, 'idle')
    expect(cachedSessionList(query)).toMatchObject([{ status: 'idle' }])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not restore snapshots from requests cleared by a logout or mutation', async () => {
    vi.spyOn(api, 'sessions').mockResolvedValue({ data: [session] })
    const request = loadSessionList(query)
    clearSessionLists()
    await request
    expect(cachedSessionList(query)).toBeUndefined()
  })
})
