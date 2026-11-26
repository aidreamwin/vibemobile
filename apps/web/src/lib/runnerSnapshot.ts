import { api } from './api'

type RunnerSnapshot = Awaited<ReturnType<typeof api.runners>>
let snapshot: RunnerSnapshot | undefined
let expiresAt = 0
let pending: Promise<RunnerSnapshot> | undefined

export function getRunnerSnapshot() {
  return snapshot
}

export function readRunnerSnapshot(): Promise<RunnerSnapshot> {
  if (pending) return pending
  if (snapshot && Date.now() < expiresAt) return Promise.resolve(snapshot)
  const request = api
    .runners()
    .then((result) => {
      if (pending === request) {
        snapshot = result
        expiresAt = Date.now() + 5_000
      }
      return result
    })
    .finally(() => {
      if (pending === request) pending = undefined
    })
  pending = request
  return request
}

export function clearRunnerSnapshot() {
  snapshot = undefined
  expiresAt = 0
  pending = undefined
}
