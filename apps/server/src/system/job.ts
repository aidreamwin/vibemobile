import fs from 'node:fs'
import path from 'node:path'
import type {
  UpdateCurrentInfo,
  UpdateJob,
  UpdateScope,
  UpdateStatusName,
  UpdateTargetInfo,
} from '@vibemobile/protocol'

const FORMAT = 1
const TERMINAL: UpdateStatusName[] = ['succeeded', 'failed', 'rolled_back']

export function jobPath(stateDir: string): string {
  return path.join(stateDir, 'update-job.json')
}

export function logPath(stateDir: string): string {
  return path.join(stateDir, 'update-job.log')
}

export function requestPath(stateDir: string): string {
  return path.join(stateDir, 'update-request.json')
}

export function lockPath(stateDir: string): string {
  return path.join(stateDir, 'update.lock')
}

export function isTerminal(status: UpdateStatusName): boolean {
  return TERMINAL.includes(status)
}

export function newJob(input: {
  id: string
  scope: UpdateScope
  role: 'hub' | 'runner'
  target: UpdateTargetInfo
  current: UpdateCurrentInfo
}): UpdateJob {
  const now = Date.now()
  return {
    format: FORMAT,
    id: input.id,
    scope: input.scope,
    role: input.role,
    status: 'queued',
    phase: 'queued',
    target: input.target,
    current: input.current,
    workerPid: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
  }
}

export function readJob(stateDir: string): UpdateJob | null {
  try {
    const raw = JSON.parse(fs.readFileSync(jobPath(stateDir), 'utf8')) as Partial<UpdateJob> | null
    if (!raw || raw.format !== FORMAT || typeof raw.id !== 'string' || !raw.target || !raw.current) return null
    return raw as UpdateJob
  } catch {
    return null
  }
}

export function writeJob(stateDir: string, job: UpdateJob): void {
  const file = jobPath(stateDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
}

export function patchJob(
  stateDir: string,
  id: string,
  patch: Partial<Pick<UpdateJob, 'status' | 'phase' | 'workerPid' | 'error' | 'finishedAt'>>,
): UpdateJob | null {
  const job = readJob(stateDir)
  if (!job || job.id !== id) return null
  const next: UpdateJob = {
    ...job,
    ...patch,
    updatedAt: Date.now(),
    ...(patch.status && isTerminal(patch.status) && !patch.finishedAt ? { finishedAt: Date.now() } : {}),
  }
  writeJob(stateDir, next)
  return next
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Turn a job left behind by a restart into something the UI can trust.
 *
 * The new process cannot see the updater, so it infers success from the one
 * fact both halves agree on: the running build. A dead worker or an ancient
 * job is a loss, not a hang.
 */
export function reconcileJob(job: UpdateJob | null, buildVersion: string, now = Date.now()): UpdateJob | null {
  if (!job || isTerminal(job.status)) return job
  if ((job.phase === 'restarting' || job.phase === 'healthcheck') && job.target.serverVersion === buildVersion) {
    return { ...job, status: 'succeeded', phase: 'done', updatedAt: now, finishedAt: now, error: null }
  }
  if (job.workerPid && !isPidAlive(job.workerPid) && now - job.updatedAt > 60_000) {
    return {
      ...job,
      status: 'failed',
      phase: 'failed',
      updatedAt: now,
      finishedAt: now,
      error: 'update_lost',
    }
  }
  if (!job.workerPid && job.phase === 'queued' && now - job.startedAt > 2 * 60 * 1000) {
    return {
      ...job,
      status: 'failed',
      phase: 'failed',
      updatedAt: now,
      finishedAt: now,
      error: 'update_not_started',
    }
  }
  if (now - job.startedAt > 45 * 60 * 1000) {
    return {
      ...job,
      status: 'failed',
      phase: 'failed',
      updatedAt: now,
      finishedAt: now,
      error: 'update_timeout',
    }
  }
  return job
}

/** Last few KB of the updater log, for the Settings details pane. */
export function readLogTail(stateDir: string, maxBytes = 8192): string | null {
  try {
    const file = logPath(stateDir)
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size))
      fs.readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}
