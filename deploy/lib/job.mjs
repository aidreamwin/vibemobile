/**
 * Job-file helper shared by `self-update.mjs` and `update.mjs`.
 *
 * The file is the only channel between the updater process, the old server and
 * the new server, so every write is atomic and carries the id it belongs to.
 * A stale writer must not overwrite a newer job.
 */
import fs from 'node:fs'
import { writeAtomic } from './common.mjs'

const TERMINAL = new Set(['succeeded', 'failed', 'rolled_back'])

export function readJob(file) {
  try {
    const job = JSON.parse(fs.readFileSync(file, 'utf8'))
    return job && job.format === 1 && typeof job.id === 'string' ? job : null
  } catch {
    return null
  }
}

export function writeJob(file, job) {
  writeAtomic(file, `${JSON.stringify(job, null, 2)}\n`, 0o600)
}

export function updateJob(file, id, patch) {
  const job = readJob(file)
  if (!job || job.id !== id) return null
  const next = { ...job, ...patch, updatedAt: Date.now() }
  if (patch.status && TERMINAL.has(patch.status) && !patch.finishedAt) next.finishedAt = Date.now()
  writeJob(file, next)
  return next
}

export function isTerminal(status) {
  return TERMINAL.has(status)
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
