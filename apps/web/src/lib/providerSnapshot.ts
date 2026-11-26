import { api } from './api'

type ProviderSnapshot = Awaited<ReturnType<typeof api.providers>>
const FRESH_FOR_MS = 15_000
let snapshot: ProviderSnapshot | undefined
let expiresAt = 0
let pending: Promise<ProviderSnapshot> | undefined

export function getProviderSnapshot() {
  return Date.now() < expiresAt ? snapshot : undefined
}

export function readProviderSnapshot(force = false): Promise<ProviderSnapshot> {
  if (pending) return pending
  if (!force && snapshot && Date.now() < expiresAt) return Promise.resolve(snapshot)
  const request = api
    .providers()
    .then((result) => {
      if (pending === request) {
        snapshot = result
        expiresAt = Date.now() + FRESH_FOR_MS
      }
      return result
    })
    .finally(() => {
      if (pending === request) pending = undefined
    })
  pending = request
  return request
}

export function clearProviderSnapshot() {
  snapshot = undefined
  expiresAt = 0
  pending = undefined
}
