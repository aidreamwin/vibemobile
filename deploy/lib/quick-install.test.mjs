import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hasCommand, readEnvFile, readJson, sha256 } from './common.mjs'

const DEPLOY = fileURLToPath(new URL('..', import.meta.url))
const windows = process.platform === 'win32'
const canBuild = process.platform !== 'linux' || ['python3', 'make', 'g++'].every(hasCommand)

// Exercise the real installation and update scripts without installing npm
// dependencies, changing the system toolchain or starting production services.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-quick-install-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'my projects')
  const dataHome = path.join(root, 'user data')
  const globalRoot = path.join(root, 'global modules')
  const userHome = path.join(root, 'home')
  for (const dir of [workspace, dataHome, userHome, path.join(globalRoot, 'pm2', 'bin')]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(
    path.join(globalRoot, 'pm2', 'bin', 'pm2'),
    `
const fs = require('node:fs')
if (process.argv[2] === 'jlist') console.log(fs.readFileSync(process.env.VBM_TEST_APPS, 'utf8'))
else if (process.argv[2] === 'start') {
  const keys = ['name', 'cwd', 'pm_exec_path', 'pm_id', 'NODE_APP_INSTANCE', 'VIBEMOBILE_ROLE', 'VIBEMOBILE_NO_AUTH', 'VIBEMOBILE_RUNNER_TOKEN', 'PORT', 'PM2_HOME', 'HTTPS_PROXY']
  console.log(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))))
}
else console.log('test-pm2')
`,
  )
  const appsFile = path.join(root, 'pm2-apps.json')
  fs.writeFileSync(appsFile, '[]')
  const npm = path.join(root, 'npm-cli.js')
  fs.writeFileSync(
    npm,
    `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
function write(file, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}
if (args[0] === 'root') console.log(process.env.VBM_TEST_GLOBAL)
else if (args[0] === 'ci') {
  write('node_modules/node-pty/index.cjs', 'module.exports = {}')
  write('node_modules/node-pty/package.json', '{"main":"index.cjs"}')
  write('node_modules/@openai/codex/package.json', '{}')
} else if (args[0] === 'run' && args[1] === 'build') {
  write('apps/server/dist/distributed/hub.js')
  write('apps/server/dist/distributed/runner.js')
  write('apps/web/dist/index.html')
} else process.exit(1)
`,
  )
  const env = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    XDG_DATA_HOME: dataHome,
    LOCALAPPDATA: dataHome,
    PM2_HOME: path.join(root, 'pm2'),
    npm_execpath: npm,
    VBM_TEST_GLOBAL: globalRoot,
    VBM_TEST_APPS: appsFile,
    NO_PROXY: '127.0.0.1,localhost',
  }
  for (const key of ['VIBEMOBILE_INSTALL_DIR', 'VIBEMOBILE_PM2_NAME', 'NODE_APP_INSTANCE', 'pm_id']) delete env[key]

  function makeRelease(role, version) {
    const source = path.join(root, `${role}-${version}`)
    fs.mkdirSync(path.join(source, 'apps/server/src'), { recursive: true })
    fs.cpSync(DEPLOY, path.join(source, 'deploy'), { recursive: true })
    fs.writeFileSync(path.join(source, 'package.json'), '{"type":"module"}')
    fs.writeFileSync(path.join(source, 'package-lock.json'), '{}')
    fs.writeFileSync(path.join(source, 'apps/server/src/index.ts'), '')
    fs.writeFileSync(
      path.join(source, 'RELEASE.json'),
      JSON.stringify({
        format: 1,
        contents: role,
        serverVersion: version,
        webVersion: version,
        commit: `test-${version}`,
      }),
    )
    return source
  }

  function run(source, args = []) {
    return spawnSync(
      process.execPath,
      [path.join(source, 'deploy/quick-install.mjs'), '--no-start', '--allow-root', ...args],
      {
        cwd: workspace,
        env,
        encoding: 'utf8',
        windowsHide: true,
      },
    )
  }
  return { root, workspace, env, appsFile, makeRelease, run, target: (role) => path.join(dataHome, 'vibemobile', role) }
}

function assertSuccess(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

test('PM2 launch drops inherited application metadata before starting another deployment', (t) => {
  const f = fixture(t)
  const env = {
    ...f.env,
    name: 'previous-runner',
    cwd: f.workspace,
    pm_exec_path: path.join(f.workspace, 'old-runner.js'),
    pm_id: '0',
    NODE_APP_INSTANCE: '0',
    VIBEMOBILE_ROLE: 'runner',
    VIBEMOBILE_NO_AUTH: 'true',
    VIBEMOBILE_RUNNER_TOKEN: 'test-secret',
    PORT: '5901',
    HTTPS_PROXY: 'http://localhost:8080',
  }
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { runPm2 } from ${JSON.stringify(new URL('./common.mjs', import.meta.url).href)}
    process.stdout.write(runPm2(['start', 'ecosystem.config.cjs'], { capture: true }).stdout)
  `,
    ],
    { env, encoding: 'utf8', windowsHide: true },
  )
  assertSuccess(result)
  assert.deepEqual(JSON.parse(result.stdout), { PM2_HOME: f.env.PM2_HOME, HTTPS_PROXY: env.HTTPS_PROXY })
})

test('PM2 start refuses a process pointing to another release directory', (t) => {
  const f = fixture(t)
  fs.writeFileSync(f.appsFile, JSON.stringify([{ name: 'vibemobile', pm2_env: { pm_cwd: f.workspace } }]))
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { pm2Start } from ${JSON.stringify(new URL('./common.mjs', import.meta.url).href)}
    pm2Start({ ecosystemFile: 'ecosystem.config.cjs', cwd: process.cwd(), name: 'vibemobile', releaseDir: 'new-release' })
  `,
    ],
    { env: f.env, cwd: f.workspace, encoding: 'utf8', windowsHide: true },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /expected release directory/)
})

test('installs Hub by default, upgrades in a separate release directory and retains configuration', {
  skip: !canBuild,
}, (t) => {
  const f = fixture(t)
  const first = f.makeRelease('hub', '1.0.0')
  const second = f.makeRelease('hub', '1.0.1')
  const target = f.target('hub')
  assertSuccess(f.run(first, ['--pin=123456']))
  const envFile = path.join(target, 'vibemobile.env')
  const original = fs.readFileSync(envFile, 'utf8')
  assert.equal(readEnvFile(envFile).VIBEMOBILE_ROOTS, f.workspace)
  assert.equal(readEnvFile(envFile).VIBEMOBILE_INSTALL_DIR, target)
  const metadata = path.join(target, 'active-release.json')
  const active = readJson(metadata).active
  assert.ok(active.startsWith(path.join(target, 'releases') + path.sep))
  const state = path.join(target, 'data', 'hub', 'test-state')
  fs.writeFileSync(state, 'preserve me')

  const unconfirmed = f.run(second)
  assert.equal(unconfirmed.status, 1)
  assert.match(unconfirmed.stderr, /pass --yes/)
  assert.equal(readJson(metadata).active, active)
  assertSuccess(f.run(second, ['--yes']))
  assert.equal(readJson(metadata).previous, active)
  assert.equal(readJson(metadata).serverVersion, '1.0.1')
  assert.equal(fs.readFileSync(envFile, 'utf8'), original)
  assert.equal(fs.readFileSync(state, 'utf8'), 'preserve me')
  const updated = fs.readFileSync(metadata, 'utf8')
  assertSuccess(f.run(second, ['--yes']))
  assert.equal(fs.readFileSync(metadata, 'utf8'), updated)
  assert.equal(fs.existsSync(path.join(target, 'install.lock')), false)
})

test('discovers a custom PM2 installation and refuses an unrelated nonempty target', { skip: !canBuild }, (t) => {
  const f = fixture(t)
  const first = f.makeRelease('hub', '1.0.0')
  const second = f.makeRelease('hub', '1.0.1')
  const target = path.join(f.root, 'custom install')
  assertSuccess(f.run(first, [`--target=${target}`]))
  fs.writeFileSync(f.appsFile, JSON.stringify([{ name: 'vibemobile', pm2_env: { VIBEMOBILE_INSTALL_DIR: target } }]))
  assertSuccess(f.run(second, ['--yes']))
  assert.equal(readJson(path.join(target, 'active-release.json')).serverVersion, '1.0.1')
  assert.equal(fs.existsSync(f.target('hub')), false)
  const other = path.join(f.root, 'unrelated files')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'keep.txt'), 'keep')
  const rejected = f.run(second, [`--target=${other}`, '--pm2-name=other-app'])
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /not empty/)
  assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep')
})

function runTerminal(command, args, options, exchanges) {
  // Run the PTY driver in its own process: on Windows the native console
  // handles can outlive the shell, even after node-pty has emitted onExit.
  const driver = `
const pty = require('node-pty')
const { command, args, options, exchanges } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
const terminal = pty.spawn(command, args, { ...options, cols: 110, rows: 30, useConptyDll: true })
let output = ''
let next = 0
const timer = setTimeout(() => {
  terminal.kill()
  console.error('Installer timed out: ' + output.slice(-6000))
  process.exit(1)
}, 45000)
terminal.onData(data => {
  output += data
  if (next < exchanges.length && output.includes(exchanges[next][0])) {
    terminal.write(exchanges[next][1] + '\\r')
    next++
  }
})
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer)
  process.stdout.write(JSON.stringify({ exitCode, output, next }), () => process.exit(0))
})
`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', driver], { cwd: path.dirname(DEPLOY), windowsHide: true })
    let output = ''
    let error = ''
    child.stdout.on('data', (data) => {
      output += data
    })
    child.stderr.on('data', (data) => {
      error += data
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(error.slice(-6000)))
      else resolve(JSON.parse(output))
    })
    child.stdin.end(JSON.stringify({ command, args, options, exchanges }))
  })
}

test('one-line runner installation reads credentials from a terminal and hides the token', {
  skip: !canBuild,
  timeout: 60_000,
}, async (t) => {
  const f = fixture(t)
  const source = f.makeRelease('runner', '1.0.0')
  const archive = path.join(f.root, 'runner.tar.gz')
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', source, '.']).status, 0)
  const extension = windows ? 'ps1' : 'sh'
  const installer = fs.readFileSync(path.join(DEPLOY, `bootstrap.${extension}`), 'utf8').replace(/\r\n/g, '\n')
  const server = http.createServer((req, res) => {
    if (req.url === '/runner.tar.gz') res.end(fs.readFileSync(archive))
    else {
      const values = {
        ROLE: 'runner',
        ARCHIVE_URL: `http://127.0.0.1:${server.address().port}/runner.tar.gz`,
        ARCHIVE_SHA256: sha256(archive),
        NODE_VERSION: process.version,
      }
      res.end(installer.replace(/@([A-Z0-9_]+)@/g, (_, key) => `'${values[key]}'`))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/runner-install.${extension}`
  const credential = crypto.randomBytes(32).toString('hex')
  const command = windows ? 'powershell.exe' : '/bin/sh'
  const args = windows
    ? ['-NoProfile', '-Command', `& ([scriptblock]::Create((curl.exe -LsSf '${url}' | Out-String))) '--no-start'`]
    : ['-c', `curl -LsSf '${url}' | sh -s -- --no-start`]
  const options = { cwd: f.workspace, env: f.env }
  const result = await runTerminal(command, args, options, [
    ['Hub address:', 'http://127.0.0.1:3000'],
    ['Connection token', `runner-test:${credential}`],
  ])
  assert.equal(result.exitCode, 0, result.output)
  assert.equal(result.next, 2)
  assert.ok(!result.output.includes(credential), 'the connection token must not appear in installer output')
  const envFile = path.join(f.target('runner'), 'vibemobile.env')
  const installed = fs.readFileSync(envFile, 'utf8')
  const env = readEnvFile(envFile)
  assert.equal(env.VIBEMOBILE_HUB_URL, 'ws://127.0.0.1:3000')
  assert.equal(env.VIBEMOBILE_RUNNER_ID, 'runner-test')
  assert.equal(env.VIBEMOBILE_RUNNER_TOKEN, credential)

  const declined = await runTerminal(command, args, options, [['Upgrade this installation?', 'n']])
  assert.equal(declined.exitCode, 0, declined.output)
  assert.match(declined.output, /Installation kept as is/)
  assert.equal(fs.readFileSync(envFile, 'utf8'), installed)
})
