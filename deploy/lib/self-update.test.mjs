import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPDATER = path.join(HERE, '..', 'self-update.mjs')

function tarCommand() {
  if (process.platform === 'win32') {
    const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (fs.existsSync(systemTar)) return systemTar
  }
  return 'tar'
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function makeRelease(target) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-fake-release-'))
  fs.writeFileSync(
    path.join(stage, 'RELEASE.json'),
    JSON.stringify({
      format: 1,
      contents: 'hub',
      serverVersion: target.serverVersion,
      webVersion: target.webVersion,
      commit: target.commit,
    }),
  )
  fs.mkdirSync(path.join(stage, 'deploy'))
  fs.writeFileSync(
    path.join(stage, 'deploy', 'update.mjs'),
    `import fs from 'node:fs'
const args = process.argv.slice(2)
const jobFile = args[args.indexOf('--job-file') + 1]
const id = args[args.indexOf('--job-id') + 1]
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
fs.writeFileSync(jobFile, JSON.stringify({ ...job, id, status: 'succeeded', phase: 'done', updatedAt: Date.now(), finishedAt: Date.now() }, null, 2))
`,
  )
  fs.writeFileSync(path.join(stage, 'package-lock.json'), '{}')
  // Outside the stage: tar would otherwise archive its own output.
  const tarball = path.join(os.tmpdir(), `vbm-fake-release-${crypto.randomUUID()}.tar.gz`)
  const result = spawnSync(tarCommand(), ['-czf', tarball, '-C', stage, '.'], { windowsHide: true })
  fs.rmSync(stage, { recursive: true, force: true })
  assert.equal(result.status, 0, 'tar must be available')
  return tarball
}

async function runCase({ corruptChecksum = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-self-update-'))
  const installDir = path.join(root, 'install')
  const stateDir = path.join(root, 'state')
  fs.mkdirSync(installDir, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })

  const target = { serverVersion: '9.9.9', webVersion: '9.9.9', commit: 'abc123' }
  const tarball = makeRelease(target)
  const artifactFile = 'vibemobile-hub-9.9.9.tar.gz'

  const server = http.createServer((req, res) => {
    if (req.url === `/${artifactFile}`) {
      res.writeHead(200, { 'content-type': 'application/gzip' })
      res.end(fs.readFileSync(tarball))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const jobFile = path.join(stateDir, 'update-job.json')
  const logFile = path.join(stateDir, 'update-job.log')
  const requestFile = path.join(stateDir, 'update-request.json')
  const job = {
    format: 1,
    id: 'test-job',
    scope: 'hub',
    role: 'hub',
    status: 'queued',
    phase: 'queued',
    target: { ...target, file: artifactFile, sha256: 'a'.repeat(64), bytes: 0 },
    current: { serverVersion: '9.9.8', webVersion: '9.9.8', commit: 'old', dirty: false },
    workerPid: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    error: null,
  }
  fs.writeFileSync(jobFile, JSON.stringify(job))
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      format: 1,
      id: job.id,
      installDir,
      stateDir,
      jobFile,
      logFile,
      role: 'hub',
      pm2Name: null,
      updaterName: null,
      artifact: {
        url: `http://127.0.0.1:${port}/${artifactFile}`,
        file: artifactFile,
        sha256: corruptChecksum ? 'b'.repeat(64) : sha256(tarball),
        bytes: fs.statSync(tarball).size,
      },
      downloadTimeoutMs: 30_000,
      target: job.target,
      current: job.current,
    }),
  )

  const child = spawn(process.execPath, [UPDATER, `--request-file=${requestFile}`], {
    env: { ...process.env, VIBEMOBILE_UPDATE_ALLOW_HTTP: '1' },
    windowsHide: true,
  })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  server.close()

  const result = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(tarball, { force: true })
  return { code, result, requestFile }
}

test('downloads, verifies, extracts and reports success', async () => {
  const { code, result, requestFile } = await runCase()
  assert.equal(code, 0)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.phase, 'done')
  assert.equal(fs.existsSync(requestFile), false)
})

test('rejects a checksum mismatch and reports failure', async () => {
  const { code, result } = await runCase({ corruptChecksum: true })
  assert.notEqual(code, 0)
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'update_checksum_mismatch')
})
