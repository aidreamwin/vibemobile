/**
 * Shared helpers for the PM2 release installers.
 *
 * Deliberately dependency-free: these scripts run on a fresh target machine
 * before `npm ci`, so they may only use the Node standard library.
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { reapWindowsDescendants, windowsDescendants } from './windows-process.mjs'

export const isWindows = process.platform === 'win32'

export function log(message = '') {
  process.stdout.write(`${message}\n`)
}
export function step(message) {
  log(`\n==> ${message}`)
}
export function ok(message) {
  log(`    ${message}`)
}
export function warn(message) {
  log(`    ! ${message}`)
}
export function fail(message) {
  throw new Error(message)
}

/** `--name=value`, `--name value`, and bare flags. Repeated values become arrays. */
export function parseArgs(argv = process.argv.slice(2)) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`)
    const eq = token.indexOf('=')
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    )
    let value = eq === -1 ? undefined : token.slice(eq + 1)
    if (value === undefined) {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        value = next
        index++
      } else {
        value = true
      }
    }
    if (Object.hasOwn(values, name))
      values[name] = Array.isArray(values[name]) ? [...values[name], value] : [values[name], value]
    else values[name] = value
  }
  return values
}

export function one(value) {
  return Array.isArray(value) ? value[value.length - 1] : value
}

export function many(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function quoteShellArg(arg) {
  const text = String(arg)
  if (isWindows) return /[\s&|<>^"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  return /[^\w@%+=:,./-]/.test(text) ? `'${text.replace(/'/g, `'\\''`)}'` : text
}

/**
 * Everything goes through a shell. `spawnSync('npm.cmd', …)` fails with EINVAL
 * on Windows and bare `pm2` is a .cmd shim, so the shell is the portable entry.
 */
function childEnv(options) {
  const env = { ...process.env }
  for (const key of options.unset ?? []) delete env[key]
  return { ...env, ...options.env }
}

function spawnOptions(options) {
  return {
    cwd: options.cwd,
    env: childEnv(options),
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
  }
}

function finish(command, args, result, options) {
  const output = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`)
  if (options.allowFailure) return output
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
  return output
}

/** Direct spawn: executable paths (node.exe, git, openssl, tar) need no shell. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args.map(String), spawnOptions(options))
  return finish(command, args, result, options)
}

/**
 * Fallback for .cmd shims when the JS entry could not be resolved. `cmd.exe
 * /s /c` with verbatim arguments is the only form that does not re-quote the
 * whole command line (which turns `"C:\Program Files\nodejs\node.exe"` into a
 * literal and fails with "not recognized as an internal or external command").
 */
function runShellLine(command, args, options = {}) {
  const line = [command, ...args].map(quoteShellArg).join(' ')
  const result = isWindows
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
        ...spawnOptions(options),
        windowsVerbatimArguments: true,
      })
    : spawnSync('sh', ['-c', line], spawnOptions(options))
  return finish(command, args, result, options)
}

/**
 * `npm` may be a .cmd shim, and on Windows it is not always on PATH for the
 * account that runs a service. Prefer the npm-cli.js that shipped with the
 * Node binary we are already executing.
 */
export function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ]
  for (const candidate of candidates) {
    if (candidate && candidate.endsWith('npm-cli.js') && fs.existsSync(candidate)) return candidate
  }
  return null
}

export function runNpm(args, options = {}) {
  const cli = npmCliPath()
  if (cli) return run(process.execPath, [cli, ...args], options)
  return runShellLine('npm', args, options)
}

let cachedGlobalRoot

export function globalNodeModules() {
  if (cachedGlobalRoot !== undefined) return cachedGlobalRoot
  const result = runNpm(['root', '-g'], { capture: true, allowFailure: true })
  const root = result.status === 0 ? result.stdout.trim().split(/\r?\n/).pop() : ''
  cachedGlobalRoot = root && fs.existsSync(root) ? root : null
  return cachedGlobalRoot
}

export function pm2BinPath() {
  const root = globalNodeModules()
  if (!root) return null
  const bin = path.join(root, 'pm2', 'bin', 'pm2')
  return fs.existsSync(bin) ? bin : null
}

/** PM2 is commonly installed globally; resolve its JS entry to avoid .cmd. */
export function runPm2(args, options = {}) {
  // PM2 exposes application metadata as environment variables. When a command
  // is launched inside a managed app (including our updater), PM2 can merge
  // these values into a new application and override its name, cwd and script.
  const managed =
    process.env.pm_id !== undefined || process.env.NODE_APP_INSTANCE !== undefined || process.env.pm_exec_path
  if (managed) {
    const metadata = new Set([
      'name',
      'namespace',
      'cwd',
      'script',
      'args',
      'interpreter',
      'exec_interpreter',
      'exec_mode',
      'node_args',
      'instances',
      'instance_var',
      'NODE_APP_INSTANCE',
      'status',
      'created_at',
      'version',
      'username',
      'time',
      'unique_id',
      'windowsHide',
      'autorestart',
      'autostart',
      'max_restarts',
      'restart_delay',
      'restart_time',
      'unstable_restarts',
      'prev_restart_delay',
      'kill_timeout',
      'kill_retry_time',
      'shutdown_with_message',
      'treekill',
      'merge_logs',
      'log_date_format',
      'out_file',
      'error_file',
      'log_file',
      'watch',
      'ignore_watch',
      'watch_options',
      'versioning',
      'vizion',
      'vizion_running',
      'pmx',
      'pmx_module',
      'automation',
      'exit_code',
      'filter_env',
      'stop_exit_codes',
      'max_memory_restart',
      'min_uptime',
      'wait_ready',
      'listen_timeout',
    ])
    const inherited = Object.keys(process.env).filter(
      (key) =>
        metadata.has(key) ||
        key.startsWith('pm_') ||
        key.startsWith('axm_') ||
        (args[0] === 'start' &&
          (/^VIBEMOBILE_/.test(key) || ['PORT', 'CODEX_PORT', 'OPENCODE_PORT', 'CODEX_WS_URL'].includes(key))),
    )
    options = { ...options, unset: [...(options.unset ?? []), ...inherited] }
  }
  const bin = pm2BinPath()
  if (bin) return run(process.execPath, [bin, ...args], options)
  return runShellLine('pm2', args, options)
}

export function pm2Available() {
  return runPm2(['-v'], { capture: true, allowFailure: true }).status === 0
}

export function hasCommand(command) {
  if (isWindows) {
    const result = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
    return result.status === 0
  }
  const result = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' })
  return result.status === 0
}

export function nodeMajor() {
  return Number(process.versions.node.split('.')[0])
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeAtomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content, { mode })
  fs.renameSync(temporary, file)
  if (!isWindows) fs.chmodSync(file, mode)
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

function quote(value) {
  const text = String(value)
  return /[\s#"'\\]/.test(text) ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : text
}

/** Minimal KEY=VALUE reader; the file is also valid for `node --env-file`. */
export function readEnvFile(file) {
  const values = {}
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return values
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    values[trimmed.slice(0, eq).trim()] = unquote(trimmed.slice(eq + 1).trim())
  }
  return values
}

export function writeEnvFile(file, values, header = []) {
  const lines = [
    ...header.map((line) => `# ${line}`),
    ...Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`),
  ]
  writeAtomic(file, `${lines.join('\n')}\n`)
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Copy a directory tree with an exclusion predicate on absolute paths. */
export function copyTree(source, destination, exclude = () => false) {
  if (exclude(source)) return
  const stat = fs.statSync(source)
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true })
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyTree(path.join(source, entry.name), path.join(destination, entry.name), exclude)
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
}

export function lanAddresses() {
  const addresses = new Set()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.internal) continue
      const family = typeof address.family === 'string' ? address.family : `IPv${address.family}`
      if (family === 'IPv4' && !address.address.startsWith('169.254.')) addresses.add(address.address)
    }
  }
  return [...addresses]
}

/** Lowercase origins, no trailing slash — the Hub rejects anything else at startup. */
export function publicOrigins(port, extraHosts = [], scheme = 'https') {
  const hosts = [os.hostname().toLowerCase(), '127.0.0.1', 'localhost', '[::1]', ...lanAddresses(), ...extraHosts]
  return [
    ...new Set(
      hosts.filter(Boolean).map((host) => `${scheme}://${String(host).toLowerCase().replace(/\/+$/, '')}:${port}`),
    ),
  ]
}

export function assertOrigin(origin) {
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    fail(`invalid origin: ${origin}`)
  }
  if (parsed.origin !== origin) fail(`origin must be lowercase and have no trailing slash: ${origin}`)
  return origin
}

export function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const finish = (occupied) => {
      socket.destroy()
      resolve(!occupied)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(800, () => finish(true))
  })
}

export function checkPort(port, label) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`${label} must be an integer between 1024 and 65535`)
  if (port === 8788) fail(`${label} 8788 is reserved for the single-process deployment`)
  return port
}

export async function waitForPortsFree(ports, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let busy = ports
  while (Date.now() < deadline) {
    busy = []
    for (const port of ports) if (!(await portIsFree(port))) busy.push(port)
    if (!busy.length) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  fail(`port(s) still occupied after ${timeoutMs / 1000}s: ${busy.join(', ')}`)
}

export async function waitForPortListening(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portIsFree(port))) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  fail(`nothing is listening on 127.0.0.1:${port} after ${timeoutMs / 1000}s`)
}

function request(url, caPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const client = parsed.protocol === 'https:' ? https : http
    const options = { host: parsed.hostname, port: parsed.port, path: parsed.pathname, timeout: 4000 }
    if (parsed.protocol === 'https:') {
      options.ca = caPath ? fs.readFileSync(caPath) : undefined
      options.rejectUnauthorized = true
    }
    const req = client.get(options, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

/**
 * The Hub's own liveness endpoint. Deliberately `/api/hub` (public, no auth):
 * the auth-protected `/r/<runner>/api/health` needs a PIN login, which the
 * installer does not need to perform.
 */
export async function waitForHub({ port, tls, caPath, timeoutMs = 30_000 }) {
  const url = `${tls ? 'https' : 'http'}://127.0.0.1:${port}/api/hub`
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await request(url, caPath)
      const body = JSON.parse(response.body)
      if (response.status === 200 && body.mode === 'hub') return body
      lastError = new Error(`unexpected response ${response.status}: ${response.body}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Hub did not answer ${url} within ${timeoutMs / 1000}s: ${lastError?.message ?? 'unknown error'}`)
}

/** The generated PIN lives only in state.json until an explicit PIN is configured. */
export function generatedPin(stateDir) {
  const state = readJson(path.join(stateDir, 'state.json'), {})
  return typeof state.generatedPin === 'string' ? state.generatedPin : undefined
}

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode })
  if (!isWindows) fs.chmodSync(dir, mode)
}

/**
 * The env file is read at PM2 start, not inlined: editing vibemobile.env and
 * running `pm2 restart <name> --update-env` must actually take effect, and the
 * file stays the single source of truth across updates.
 */
export function ecosystemSource({ name, cwd, script, envFile, outFile, errorFile }) {
  const lines = [
    '// Generated by deploy/install.mjs / deploy/update.mjs.',
    '// Edit vibemobile.env, not this file; then `pm2 restart <name> --update-env`.',
    "const fs = require('node:fs')",
    `const ENV_FILE = ${JSON.stringify(envFile)}`,
    'function readEnv(file) {',
    '  const values = {}',
    "  for (const line of fs.readFileSync(file, 'utf8').split(/\\r?\\n/)) {",
    '    const trimmed = line.trim()',
    "    if (!trimmed || trimmed.startsWith('#')) continue",
    "    const eq = trimmed.indexOf('=')",
    '    if (eq === -1) continue',
    '    const raw = trimmed.slice(eq + 1).trim()',
    '    values[trimmed.slice(0, eq).trim()] =',
    "      raw.length >= 2 && raw.startsWith('\"') && raw.endsWith('\"') ? JSON.parse(raw) : raw",
    '  }',
    '  return values',
    '}',
    'module.exports = {',
    '  apps: [{',
    `    name: ${JSON.stringify(name)},`,
    `    cwd: ${JSON.stringify(cwd)},`,
    `    script: ${JSON.stringify(script)},`,
    `    interpreter: ${JSON.stringify(process.execPath)},`,
    "    exec_mode: 'fork',",
    '    instances: 1,',
    '    env: readEnv(ENV_FILE),',
    '    time: true,',
    '    autorestart: true,',
    '    max_restarts: 10,',
    '    restart_delay: 3000,',
    '    // The Hub reaps its default runner on SIGINT (up to 10 s); PM2 must not',
    '    // kill the process before that, or the runner child keeps the ports.',
    '    kill_timeout: 20000,',
    '    shutdown_with_message: true,',
    '    treekill: true,',
    '    windowsHide: true,',
    `    out_file: ${JSON.stringify(outFile)},`,
    `    error_file: ${JSON.stringify(errorFile)},`,
    '    merge_logs: true,',
    '  }],',
    '}',
    '',
  ]
  return lines.join('\n')
}

export function pm2Delete(name) {
  // Old Windows installs may only kill the Node parent. Capture its own
  // descendants first so an orphaned CLI cannot keep the replacement's port.
  const app = isWindows ? pm2Describe(name) : undefined
  const descendants = app?.pid ? windowsDescendants(app.pid) : []
  const result = runPm2(['delete', name], { allowFailure: true })
  if (app && result.status !== 0) fail(`could not delete PM2 app ${name}`)
  if (result.status === 0) reapWindowsDescendants(descendants)
}

export function pm2Start({ ecosystemFile, cwd, name, releaseDir }) {
  runPm2(['start', ecosystemFile, '--update-env'], { cwd })
  const app = pm2Describe(name)
  if (!app || (releaseDir && path.relative(releaseDir, app.pm2_env?.pm_cwd ?? '') !== '')) {
    fail(`PM2 did not start ${name} from the expected release directory`)
  }
  runPm2(['save'])
}

export function pm2Describe(name) {
  const result = runPm2(['jlist'], { capture: true, allowFailure: true })
  if (result.status !== 0) return undefined
  try {
    const apps = JSON.parse(result.stdout)
    return apps.find((app) => app.name === name)
  } catch {
    return undefined
  }
}

export function readRelease(root) {
  return readJson(path.join(root, 'RELEASE.json'), undefined)
}

export function sanitizeSegment(value) {
  return String(value).replace(/[^\w.-]+/g, '-')
}

export function releaseStamp(release, role) {
  return sanitizeSegment(
    [
      release.serverVersion,
      role === 'hub' && release.webVersion ? `w${release.webVersion}` : null,
      release.commit ?? 'unknown',
    ]
      .filter(Boolean)
      .join('-'),
  )
}

export function ecosystemCwd(source) {
  const match = source?.match(/\bcwd:\s*("(?:[^"\\]|\\.)*")/)
  if (!match) return null
  try {
    return path.resolve(JSON.parse(match[1]))
  } catch {
    return null
  }
}

export function writeActiveRelease(installDir, releaseDir, release, previous, noStart) {
  writeAtomic(
    path.join(installDir, 'active-release.json'),
    `${JSON.stringify(
      {
        active: releaseDir,
        previous: previous && path.resolve(previous) !== releaseDir ? previous : null,
        commit: release.commit ?? null,
        serverVersion: release.serverVersion ?? null,
        webVersion: release.webVersion ?? null,
        updatedAt: new Date().toISOString(),
        manager: noStart ? 'none' : 'pm2',
      },
      null,
      2,
    )}\n`,
  )
}
