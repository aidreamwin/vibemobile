/**
 * Job-file helper shared by `self-update.mjs` and `update.mjs`.
 *
 * The file is the only channel between the updater process, the old server and
 * the new server, so every write is atomic and carries the id it belongs to.
 * A stale writer must not overwrite a newer job.
 */
import fs from 'node:fs'
import path from 'node:path'
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

/** Serialize installations and updates that write the same deployment root. */
export function lockInstall(root) {
  const file = path.join(root, 'install.lock')
  const owner = JSON.stringify({ pid: process.pid })
  try {
    fs.writeFileSync(file, owner, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const current = fs.readFileSync(file, 'utf8')
    let pid
    try {
      pid = JSON.parse(current).pid
    } catch {
      // Another process may still be writing its PID.
    }
    if (!Number.isInteger(pid) || isPidAlive(pid) || fs.readFileSync(file, 'utf8') !== current) {
      throw new Error(`An installation or update is already in progress: ${root}`)
    }
    fs.unlinkSync(file)
    fs.writeFileSync(file, owner, { flag: 'wx', mode: 0o600 })
  }
  process.once('exit', () => {
    try {
      if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file)
    } catch {
      // Best effort after a failed or interrupted installation.
    }
  })
}
