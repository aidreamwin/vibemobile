import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  UpdateCurrentInfo,
  UpdateJob,
  UpdateReleaseInfo,
  UpdateStatus,
  UpdateTargetInfo,
} from '@vibemobile/protocol'
import { build } from '../buildInfo.js'
import type { Config } from '../config.js'
import { FeedError, UpdateFeed, type FeedRelease } from './feed.js'
import { deploymentInfo, type DeploymentInfo } from './manager.js'
import {
  isPidAlive,
  isTerminal,
  jobPath,
  logPath,
  newJob,
  readJob,
  readLogTail,
  reconcileJob,
  requestPath,
  writeJob,
} from './job.js'
import { runPm2 } from './pm2.js'
import { readWebVersion, updateAvailable } from './version.js'

export class UpdateError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code)
    this.name = 'UpdateError'
  }
}

export interface UpdateService {
  status(force?: boolean): Promise<UpdateStatus>
  start(): Promise<UpdateJob>
  /** Remove a finished updater PM2 app; safe to call on every startup. */
  cleanup(): void
}

export interface UpdateServiceOptions {
  buildVersion?: string
  deployment?: DeploymentInfo
  feed?: UpdateFeed
  runPm2?: typeof runPm2
}

export function createUpdateService(config: Config, options: UpdateServiceOptions = {}): UpdateService {
  const buildVersion = options.buildVersion ?? build.version
  const deployment = options.deployment ?? deploymentInfo(config, build)
  const feed = options.feed ?? new UpdateFeed(config, deployment.role)
  const pm2 = options.runPm2 ?? runPm2
  let starting = false

  const currentInfo = (): UpdateCurrentInfo => ({
    serverVersion: buildVersion,
    webVersion: readWebVersion(config.releaseDir),
    commit: build.commit,
    dirty: build.dirty,
  })

  const updaterName = (): string | null => (deployment.pm2Name ? `${deployment.pm2Name}-updater` : null)

  async function status(force = false): Promise<UpdateStatus> {
    const stored = readJob(config.stateDir)
    const job = reconcileJob(stored, buildVersion)
    if (job && job !== stored) writeJob(config.stateDir, job)

    const current = currentInfo()
    let latest: UpdateReleaseInfo | null = null
    let feedError: string | null = null
    let available = false

    if (deployment.supported) {
      if (!feed.configured()) {
        feedError = 'update_not_configured'
      } else {
        try {
          const release = await feed.latest(force)
          latest = release.info
          available = updateAvailable(deployment.role, current, release.info)
        } catch (error) {
          feedError = error instanceof FeedError ? error.code : 'feed_unreachable'
        }
      }
    }

    return {
      scope: deployment.scope,
      role: deployment.role,
      sharedInstall: deployment.sharedInstall,
      supported: deployment.supported,
      manager: deployment.manager,
      reason: deployment.reason,
      manualCommand: deployment.manualCommand,
      current,
      latest,
      updateAvailable: available,
      checking: false,
      feedError,
      job,
      logTail: readLogTail(config.stateDir),
    }
  }

  async function start(): Promise<UpdateJob> {
    if (starting) throw new UpdateError('update_running', 409)
    starting = true
    try {
      if (!deployment.supported) {
        throw new UpdateError(deployment.reason === 'update_via_hub' ? 'update_via_hub' : 'update_not_supported', 409)
      }
      const previous = reconcileJob(readJob(config.stateDir), buildVersion)
      if (previous && !isTerminal(previous.status)) throw new UpdateError('update_running', 409)
      if (!feed.configured()) throw new UpdateError('update_not_configured', 503)

      let release: FeedRelease
      try {
        release = await feed.latest(true)
      } catch (error) {
        const code = error instanceof FeedError ? error.code : 'feed_unreachable'
        if (code === 'feed_dirty') throw new UpdateError('update_dirty_release', 409)
        throw new UpdateError('feed_unavailable', 503)
      }

      const current = currentInfo()
      if (!updateAvailable(deployment.role, current, release.info)) {
        throw new UpdateError('update_not_available', 409)
      }
      const name = updaterName()
      if (!name) throw new UpdateError('update_not_supported', 409)

      const script = path.join(config.releaseDir, 'deploy', 'self-update.mjs')
      if (!fs.existsSync(script)) throw new UpdateError('update_not_supported', 409)

      const id = crypto.randomUUID()
      const target: UpdateTargetInfo = {
        serverVersion: release.info.serverVersion,
        webVersion: release.info.webVersion,
        commit: release.info.commit,
        file: release.info.artifact.file,
        sha256: release.info.artifact.sha256,
        bytes: release.info.artifact.bytes,
      }
      const job = newJob({ id, scope: deployment.scope, role: deployment.role, target, current })
      writeJob(config.stateDir, job)

      const requestFile = requestPath(config.stateDir)
      writeJsonAtomic(requestFile, {
        format: 1,
        id,
        installDir: config.installDir,
        stateDir: config.stateDir,
        jobFile: jobPath(config.stateDir),
        logFile: logPath(config.stateDir),
        role: deployment.role,
        pm2Name: deployment.pm2Name,
        updaterName: name,
        artifact: {
          url: release.url,
          file: release.info.artifact.file,
          sha256: release.info.artifact.sha256,
          bytes: release.info.artifact.bytes,
        },
        downloadTimeoutMs: config.update.downloadTimeoutMs,
        target,
        current,
      })

      await pm2(['delete', name]).catch(() => undefined)
      const result = await pm2([
        'start',
        script,
        '--name',
        name,
        '--no-autorestart',
        '--interpreter',
        process.execPath,
        '--',
        `--request-file=${requestFile}`,
      ])
      if (result.code !== 0) {
        throw new UpdateError('update_start_failed', 500)
      }
      return job
    } catch (error) {
      if (error instanceof UpdateError) {
        // Nothing consumed the request if PM2 never started the worker.
        try {
          fs.rmSync(requestPath(config.stateDir), { force: true })
        } catch {
          // Best effort.
        }
        const job = readJob(config.stateDir)
        if (job && !isTerminal(job.status)) {
          writeJob(config.stateDir, {
            ...job,
            status: 'failed',
            phase: 'failed',
            error: error.code,
            updatedAt: Date.now(),
            finishedAt: Date.now(),
          })
        }
      }
      throw error
    } finally {
      starting = false
    }
  }

  function cleanup(): void {
    // The Hub's default runner inherits the Hub's PM2 name; deleting
    // `<hub>-updater` from this child would kill the Hub's worker.
    if (deployment.sharedInstall) return
    const name = updaterName()
    if (!name) return
    const job = readJob(config.stateDir)
    const finished = !job || isTerminal(job.status) || !job.workerPid || !isPidAlive(job.workerPid)
    if (!finished) return
    const timer = setTimeout(() => {
      void pm2(['delete', name])
        .then(() => pm2(['save']))
        .catch(() => undefined)
    }, 15_000)
    timer.unref()
  }

  return { status, start, cleanup }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
}
