/**
 * Download, verify and stage one app update, then hand the swap to
 * `update.mjs`.
 *
 * This file runs as its own PM2 app. It must not be a child of the server:
 * PM2 kills the process tree when it restarts the app, and the updater has to
 * survive exactly that moment.
 *
 *   pm2 start deploy/self-update.mjs --name <name>-updater --no-autorestart \
 *     -- --request-file=<stateDir>/update-request.json
 *
 * The request file contains URLs and hashes only. The feed token comes from
 * the environment or `<install>/vibemobile.env` and never reaches argv.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn, spawnSync } from 'node:child_process'
import {
  ensureDir,
  fail,
  isWindows,
  log,
  ok,
  one,
  parseArgs,
  readEnvFile,
  runPm2,
  sha256,
  step,
  warn,
} from './lib/common.mjs'
import { isPidAlive, readJob, updateJob } from './lib/job.mjs'

const LOCK_STALE_MS = 45 * 60 * 1000
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000
const MAX_REDIRECTS = 5

const args = parseArgs()
const requestFile = one(args.requestFile)
if (!requestFile) fail('--request-file is required')

let request
try {
  request = JSON.parse(fs.readFileSync(String(requestFile), 'utf8'))
} catch {
  // `pm2 resurrect` can start this app from the dump with nothing to do.
  if (process.env.pm_id !== undefined || process.env.NODE_APP_INSTANCE !== undefined) process.exit(0)
  fail(`request file not found: ${requestFile}`)
}

// Consume it immediately: a resurrected updater must not replay an old request.
fs.rmSync(String(requestFile), { force: true })

const stateDir = request.stateDir
const lockFile = path.join(stateDir, 'update.lock')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemobile-update-'))
const logFile = request.logFile
const job = () => readJob(request.jobFile)

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx')
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
      fs.closeSync(fd)
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner = null
      try {
        owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      } catch {
        // Unreadable lock is treated as stale.
      }
      const alive = owner && isPidAlive(owner.pid) && Date.now() - owner.startedAt < LOCK_STALE_MS
      if (alive) return false
      fs.rmSync(lockFile, { force: true })
    }
  }
  return false
}

function note(line) {
  try {
    fs.appendFileSync(logFile, `${line}\n`)
  } catch {
    // The PM2 log still has it.
  }
  log(line)
}

function tarCommand() {
  if (isWindows) {
    const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (fs.existsSync(systemTar)) return systemTar
  }
  return 'tar'
}

async function download(url, token, dest, timeoutMs, allowHttp) {
  let current = url
  let sendToken = Boolean(token)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(current, {
      headers: sendToken && token ? { 'PRIVATE-TOKEN': token } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error('update_redirect_without_location')
      const next = new URL(location, current)
      if (!allowHttp && next.protocol !== 'https:') throw new Error('update_insecure_redirect')
      if (next.origin !== new URL(current).origin) sendToken = false
      current = next.toString()
      continue
    }
    if (!response.ok) throw new Error(`update_download_http_${response.status}`)
    if (!response.body) throw new Error('update_download_empty')
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest))
    return
  }
  throw new Error('update_too_many_redirects')
}

function extract(archive, dest) {
  const tar = tarCommand()
  const listing = spawnSync(tar, ['-tzf', archive], { encoding: 'utf8', windowsHide: true })
  if (listing.status !== 0) throw new Error('update_archive_unreadable')
  for (const entry of listing.stdout.split(/\r?\n/)) {
    if (!entry) continue
    const normalized = entry.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error('update_archive_unsafe_path')
    }
  }
  const result = spawnSync(tar, ['-xzf', archive, '-C', dest], { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) throw new Error('update_archive_extract_failed')
}

async function main() {
  if (!acquireLock()) {
    warn('another update worker holds the lock; exiting')
    return
  }

  const env = { ...readEnvFile(path.join(request.installDir, 'vibemobile.env')), ...process.env }
  const token = env.VIBEMOBILE_UPDATE_TOKEN?.trim() || readTokenFile(env.VIBEMOBILE_UPDATE_TOKEN_FILE)
  const allowHttp = env.VIBEMOBILE_UPDATE_ALLOW_HTTP === '1' || env.VIBEMOBILE_UPDATE_ALLOW_HTTP === 'true'
  const timeoutMs = Number(request.downloadTimeoutMs ?? 10 * 60 * 1000)

  updateJob(request.jobFile, request.id, {
    status: 'running',
    phase: 'downloading',
    workerPid: process.pid,
    error: null,
  })
  note(`[updater] downloading ${request.artifact.file}`)
  const archive = path.join(tempDir, request.artifact.file)
  await download(request.artifact.url, token, archive, timeoutMs, allowHttp)

  updateJob(request.jobFile, request.id, { phase: 'verifying' })
  const size = fs.statSync(archive).size
  if (size !== request.artifact.bytes) throw new Error(`update_size_mismatch_${size}`)
  if (sha256(archive) !== request.artifact.sha256) throw new Error('update_checksum_mismatch')
  note(`[updater] checksum ok (${size} bytes)`)

  updateJob(request.jobFile, request.id, { phase: 'extracting' })
  const extracted = path.join(tempDir, 'release')
  ensureDir(extracted)
  extract(archive, extracted)
  const release = JSON.parse(fs.readFileSync(path.join(extracted, 'RELEASE.json'), 'utf8'))
  if (release.format !== 1) throw new Error('update_release_format')
  if (release.contents !== request.role) throw new Error('update_release_role')
  if (release.serverVersion !== request.target.serverVersion) throw new Error('update_release_version')
  if (!fs.existsSync(path.join(extracted, 'deploy', 'update.mjs'))) throw new Error('update_release_incomplete')
  if (!fs.existsSync(path.join(extracted, 'package-lock.json'))) throw new Error('update_release_incomplete')

  step('Installing the new release (the old one keeps running)')
  const updaterLog = fs.createWriteStream(logFile, { flags: 'a' })
  const child = spawn(
    process.execPath,
    [
      path.join(extracted, 'deploy', 'update.mjs'),
      '--target',
      request.installDir,
      '--job-file',
      request.jobFile,
      '--job-id',
      request.id,
      '--replace-release',
    ],
    { cwd: extracted, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !isWindows },
  )
  child.stdout.pipe(updaterLog, { end: false })
  child.stderr.pipe(updaterLog, { end: false })

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      warn('update timed out; killing the updater')
      killTree(child)
      resolve(-1)
    }, UPDATE_TIMEOUT_MS)
    child.on('exit', (value) => {
      clearTimeout(timer)
      resolve(value ?? -1)
    })
  })
  updaterLog.end()

  const final = job()
  if (code === 0) {
    if (!final || final.status !== 'succeeded') {
      updateJob(request.jobFile, request.id, { status: 'succeeded', phase: 'done', error: null })
    }
    ok('update finished')
  } else if (final?.status !== 'rolled_back') {
    updateJob(request.jobFile, request.id, {
      status: 'failed',
      phase: 'failed',
      error: code === -1 ? 'update_timeout' : 'update_failed',
    })
    warn('update failed; see the job log')
  }
}

function killTree(child) {
  if (child.exitCode !== null) return
  try {
    if (isWindows && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    child.kill('SIGKILL')
  }
}

function readTokenFile(file) {
  if (!file) return undefined
  try {
    return fs.readFileSync(path.resolve(file), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

try {
  await main()
} catch (error) {
  warn(`update failed: ${error.message}`)
  note(`[updater] ${error.message}`)
  updateJob(request.jobFile, request.id, {
    status: 'failed',
    phase: 'failed',
    error: error.message,
  })
  process.exitCode = 1
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
  try {
    fs.rmSync(lockFile, { force: true })
  } catch {
    // Best effort.
  }
  if (request.updaterName) runPm2(['delete', request.updaterName], { allowFailure: true })
}
