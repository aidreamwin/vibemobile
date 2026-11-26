import { afterEach, expect, it, vi } from 'vitest'
import { api } from './api'
import { clearProviderSnapshot, getProviderSnapshot, readProviderSnapshot } from './providerSnapshot'

const result = { data: [], default: null }

afterEach(() => {
  clearProviderSnapshot()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('reuses concurrent and fresh provider reads, with an explicit refresh and expiry', async () => {
  vi.useFakeTimers()
  const fetch = vi.spyOn(api, 'providers').mockResolvedValue(result)
  const pending = readProviderSnapshot()
  expect(readProviderSnapshot()).toBe(pending)
  await pending
  expect(getProviderSnapshot()).toBe(result)
  expect(await readProviderSnapshot()).toBe(result)
  expect(fetch).toHaveBeenCalledTimes(1)

  vi.advanceTimersByTime(15_001)
  expect(getProviderSnapshot()).toBeUndefined()
  await readProviderSnapshot()
  await readProviderSnapshot(true)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('discards pending responses when provider configuration or authentication changes', async () => {
  vi.spyOn(api, 'providers').mockResolvedValue(result)
  const pending = readProviderSnapshot()
  clearProviderSnapshot()
  await pending
  expect(getProviderSnapshot()).toBeUndefined()
})
