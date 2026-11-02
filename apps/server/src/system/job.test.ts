import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isTerminal, logPath, newJob, patchJob, readJob, readLogTail, reconcileJob, writeJob } from './job.js'

const dirs: string[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-job-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const target = {
  serverVersion: '0.1.32',
  webVersion: '0.1.58',
  commit: 'abc',
  file: 'x.tar.gz',
  sha256: 'a'.repeat(64),
  bytes: 10,
}
const current = { serverVersion: '0.1.31', webVersion: '0.1.57', commit: 'def', dirty: false }

describe('update job file', () => {
  it('round-trips a job and stamps a terminal finish time', () => {
    const dir = temp()
    const job = newJob({ id: 'job-1', scope: 'hub', role: 'hub', target, current })
    writeJob(dir, job)
    expect(readJob(dir)?.id).toBe('job-1')

    const patched = patchJob(dir, 'job-1', { status: 'succeeded', phase: 'done' })
    expect(patched?.finishedAt).not.toBeNull()
    expect(isTerminal(patched!.status)).toBe(true)
    expect(patchJob(dir, 'other-job', { status: 'failed' })).toBeNull()
  })

  it('infers success after a restart from the running build', () => {
    const dir = temp()
    const job = { ...newJob({ id: 'job-2', scope: 'hub', role: 'hub', target, current }), phase: 'restarting' as const }
    const reconciled = reconcileJob(job, '0.1.32')
    expect(reconciled).toMatchObject({ status: 'succeeded', phase: 'done', error: null })
  })

  it('does not infer success while the old build is still running', () => {
    const job = { ...newJob({ id: 'job-3', scope: 'hub', role: 'hub', target, current }), phase: 'restarting' as const }
    expect(reconcileJob(job, '0.1.31')?.status).not.toBe('succeeded')
  })

  it('marks a dead worker as lost, but only after the grace period', () => {
    const job = {
      ...newJob({ id: 'job-4', scope: 'hub', role: 'hub', target, current }),
      workerPid: 999_999,
      updatedAt: Date.now() - 120_000,
    }
    expect(reconcileJob(job, '0.1.31')).toMatchObject({ status: 'failed', error: 'update_lost' })

    const fresh = { ...job, updatedAt: Date.now() }
    expect(reconcileJob(fresh, '0.1.31')?.status).not.toBe('failed')
  })

  it('reads only the tail of the updater log', () => {
    const dir = temp()
    fs.writeFileSync(logPath(dir), `${'x'.repeat(20_000)}END`)
    const tail = readLogTail(dir, 32)
    expect(tail?.endsWith('END')).toBe(true)
    expect(tail?.length).toBe(32)
  })
})
