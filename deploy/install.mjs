/**
 * First-time installer for a VibeMobile Hub or runner, run from an *extracted*
 * release package:
 *
 *   node deploy/install.mjs --role=hub --workspace=/srv/code --pin=123456 --tls
 *   node deploy/install.mjs --role=runner --workspace=/srv/code \
 *     --hub-url=wss://hub.lan:3000 --runner-id=runner-b --runner-token-file=token.txt
 *
 * The package contains source only. This script does the `npm ci` and the build
 * on the target machine, because the Codex CLI, node-pty and the Claude CLI are
 * resolved per platform at install time.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertOrigin,
  checkPort,
  ecosystemSource,
  ensureDir,
  fail,
  generatedPin,
  hasCommand,
  isWindows,
  log,
  many,
  nodeMajor,
  npmCliPath,
  ok,
  one,
  parseArgs,
  pm2Available,
  pm2Delete,
  pm2Start,
  publicOrigins,
  readJson,
  readRelease,
  run,
  runNpm,
  runPm2,
  step,
  waitForHub,
  waitForPortListening,
  waitForPortsFree,
  warn,
  writeAtomic,
  writeEnvFile,
} from './lib/common.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = parseArgs()
const role = one(args.role)
const dryRun = args.dryRun === true || args.dryRun === 'true'
const noStart = args.noStart === true || args.noStart === 'true'
const tls = args.tls === true || args.tls === 'on' || args.tls === 'true'

if (role !== 'hub' && role !== 'runner')
  fail('usage: node deploy/install.mjs --role=hub|runner --workspace=/path/to/code')
if (args.help === true) {
  log(`Usage: node deploy/install.mjs --role=hub|runner --workspace=<dir> [options]

Hub options:
  --port=3000              browser port
  --runner-port=3001       private loopback port of the default runner
  --codex-port=6900        codex app-server port of the default runner
  --pin=123456             fixed PIN (omit to auto-generate on first start)
  --pin-file=<file>        read the PIN from a file instead of argv
  --tls                    generate a private CA and serve HTTPS/WSS
  --public-host=<host>     extra SAN / allowed origin (repeatable)
  --public-origin=<list>   comma-separated allowlist, overrides auto-detection
  --runners-file=<file>    existing remote runner list (hub only)
  --no-default-runner      do not spawn the local runner (requires --runners-file)

Runner options:
  --hub-url=wss://hub:3000
  --runner-id=runner-b
  --runner-token-file=<file>   (or --runner-token=...)
  --hub-ca=<ca.pem>            required for a private CA

Common:
  --data-dir=<dir>         defaults to <package>/data
  --pm2-name=<name>        defaults to vibemobile / vibemobile-runner
  --install-pm2            run \`npm i -g pm2\` when PM2 is missing
  --no-start               install and write config, do not touch PM2
  --dry-run                print the plan and exit
  --force                  overwrite an existing vibemobile.env
  --force-certs            regenerate certificates even if present
  --no-terminal            disable the shell feature
  --allow-root             permit installing as root (not recommended)
  --force-dev              allow running from a git checkout (destroys its node_modules)
`)
  process.exit(0)
}

const workspaceRaw = one(args.workspace) ?? one(args.roots)
if (!workspaceRaw) fail('--workspace=<dir> is required: the agent may only operate inside this directory')
const workspaces = String(workspaceRaw)
  .split(isWindows ? ';' : ':')
  .map((value) => path.resolve(value.trim()))
  .filter(Boolean)
if (!workspaces.length) fail('--workspace must name at least one directory')
for (const workspace of workspaces) {
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) fail(`workspace does not exist: ${workspace}`)
}

const dataDir = path.resolve(one(args.dataDir) ?? path.join(ROOT, 'data'))
const pm2Name = String(one(args.pm2Name) ?? (role === 'hub' ? 'vibemobile' : 'vibemobile-runner'))
const hubPort = role === 'hub' ? checkPort(Number(one(args.port) ?? 3000), 'port') : undefined
const runnerPort = checkPort(Number(one(args.runnerPort) ?? (role === 'hub' ? hubPort + 1 : 5901)), 'runner port')
const codexPort = checkPort(Number(one(args.codexPort) ?? 6900), 'codex port')
if (role === 'hub' && new Set([hubPort, runnerPort, codexPort]).size !== 3) fail('ports must all be different')
if (role === 'runner' && runnerPort === codexPort) fail('runner port and codex port must be different')

const release = readRelease(ROOT)
if (!release) {
  if (!args.forceDev)
    fail(
      'RELEASE.json is missing — this looks like a git checkout, not an extracted package. `npm ci` would delete its node_modules; re-run with --force-dev only if that is intended.',
    )
  warn('RELEASE.json missing; continuing as a development checkout (--force-dev)')
} else if (role === 'runner' && release.contents !== 'runner') {
  fail(`this is a "${release.contents}" package; install the runner package on a runner machine`)
} else if (role === 'hub' && release.contents === 'runner') {
  fail('this is a runner package; install the hub or update package on the Hub machine')
}

const missing = [path.join(ROOT, 'package-lock.json'), path.join(ROOT, 'apps/server/src/index.ts')].filter(
  (file) => !fs.existsSync(file),
)
if (missing.length) fail(`package is incomplete, missing: ${missing.join(', ')}`)

const stateDir = path.join(dataDir, role === 'hub' ? 'hub' : 'state')
const defaultRunnerStateDir = path.join(dataDir, 'default-runner')
const certDir = path.join(dataDir, 'certs')
const logsDir = path.join(dataDir, 'logs')
const envFile = path.join(ROOT, 'vibemobile.env')
const ecosystemFile = path.join(ROOT, 'ecosystem.config.cjs')
const runnersFile = path.resolve(one(args.runnersFile) ?? path.join(dataDir, 'runners', 'runners.json'))
const noDefaultRunner = args.noDefaultRunner === true || args.noDefaultRunner === 'true'

// ---------------------------------------------------------------- preflight

step(`Preflight (${role})`)
if (nodeMajor() < 20) fail(`Node >= 20 is required, found ${process.versions.node}`)
ok(`Node ${process.versions.node}`)
if (!npmCliPath() && !hasCommand('npm')) fail('npm not found; install Node.js with npm first')
ok(`npm ${npmCliPath() ?? '(PATH)'}`)
if (isWindows && !['x64', 'arm64'].includes(process.arch)) warn(`untested Windows architecture: ${process.arch}`)
if (process.platform === 'linux' && !['x64', 'arm64'].includes(process.arch))
  warn(`untested Linux architecture: ${process.arch}`)
if (!['linux', 'win32', 'darwin'].includes(process.platform)) warn(`untested platform: ${process.platform}`)

if (process.platform === 'linux') {
  // node-pty 1.1.0 ships prebuilds only for darwin/win32; Linux always compiles.
  const missingTools = ['python3', 'make', 'g++'].filter((tool) => !hasCommand(tool))
  if (missingTools.length) {
    fail(`Linux needs a C++ toolchain for node-pty (missing: ${missingTools.join(', ')}).
  Debian/Ubuntu: sudo apt-get install -y build-essential python3
  Fedora/RHEL:   sudo dnf install -y gcc-c++ make python3
  Alpine:        sudo apk add --no-cache build-base python3`)
  }
  ok('node-pty build toolchain: python3, make, g++')
}

let pm2Ready = pm2Available()
if (!pm2Ready && args.installPm2) {
  step('Installing PM2')
  runNpm(['install', '-g', 'pm2'])
  pm2Ready = pm2Available()
}
if (!dryRun && !noStart && !pm2Ready) {
  fail('PM2 is not available. Run `npm i -g pm2` or add --install-pm2. To prepare files only, use --no-start.')
}
if (pm2Ready) ok(`PM2 ${runPm2(['-v'], { capture: true }).stdout.trim()}`)

if (role === 'hub') {
  const codexAuth = path.join(os.homedir(), '.codex', 'auth.json')
  const claudeDir = path.join(os.homedir(), '.claude')
  if (!fs.existsSync(codexAuth))
    warn(
      `Codex CLI does not look logged in (${codexAuth} missing); the agent will fail until you run \`codex login\` as the user that runs PM2`,
    )
  if (!fs.existsSync(claudeDir))
    warn(`Claude CLI config not found (${claudeDir}); run \`claude\` once as the PM2 user if you plan to use it`)
  if (process.getuid?.() === 0 && !args.allowRoot)
    fail(
      'refusing to install as root: PM2 and the agent CLIs must belong to the user whose projects will be edited (add --allow-root to override)',
    )
}

// --------------------------------------------------------------- installer

const plan = {
  root: ROOT,
  role,
  release: release
    ? `${release.contents} ${release.serverVersion ?? ''} ${release.commit ?? ''}`.trim()
    : 'development checkout',
  dataDir,
  stateDir,
  defaultRunnerStateDir,
  certDir,
  logsDir,
  envFile,
  ecosystemFile,
  runnersFile,
  pm2Name,
  hubPort,
  runnerPort,
  codexPort,
  workspaces,
  tls,
  noDefaultRunner,
  noStart,
  dryRun,
}

step('Plan')
for (const [key, value] of Object.entries(plan)) {
  if (value === undefined || value === false || (Array.isArray(value) && !value.length)) continue
  ok(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
}

if (dryRun) {
  step('Dry run: no files written, no commands executed')
  const env = role === 'hub' ? hubEnv({ pin: pinFromArgs() }) : runnerEnv()
  for (const [key, value] of Object.entries(env)) ok(`${key}=${/PIN|TOKEN|SECRET/.test(key) ? '***' : value}`)
  process.exit(0)
}

// ------------------------------------------------------------------ install

// Checked before the expensive steps: re-installing over an existing install is
// an upgrade, and `npm ci` + a full build would otherwise run before failing.
if (fs.existsSync(envFile) && !args.force)
  fail(
    `${envFile} already exists. Use deploy/update.mjs to upgrade, or re-run with --force to rebuild the config (state in data/ is preserved).`,
  )

step('Installing dependencies (this includes devDependencies: the Codex CLI is one)')
runNpm(['ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund', '--foreground-scripts'], {
  cwd: ROOT,
  unset: ['NODE_ENV', 'npm_config_production', 'npm_config_omit', 'npm_config_build_from_source'],
})
if (!fs.existsSync(path.join(ROOT, 'node_modules', '@openai', 'codex', 'package.json')))
  fail('Codex CLI was not installed; `npm ci` must include devDependencies')
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'node-pty'))) fail('node-pty was not installed')
ok('dependencies installed')

step('Building')
runNpm(['run', 'build', '--workspace=@vibemobile/server'], { cwd: ROOT })
run(process.execPath, ['-e', "require('node-pty')"], { cwd: ROOT })
run(process.execPath, ['-e', "require.resolve('@openai/codex/package.json')"], { cwd: ROOT })
const entry =
  role === 'hub'
    ? path.join(ROOT, 'apps/server/dist/distributed/hub.js')
    : path.join(ROOT, 'apps/server/dist/distributed/runner.js')
if (!fs.existsSync(entry)) fail(`build output missing: ${entry}`)
if (role === 'hub') {
  runNpm(['run', 'build', '--workspace=@vibemobile/web'], { cwd: ROOT })
  if (!fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')))
    fail('web build output missing: apps/web/dist/index.html')
}
const stamp = readJson(path.join(ROOT, 'apps/server/dist/version.json'), undefined)
if (stamp?.commit && release?.commit && stamp.commit !== release.commit.slice(0, stamp.commit.length)) {
  warn(`build stamp ${stamp.commit} differs from package commit ${release.commit}`)
}
ok(`server ${stamp?.version ?? 'unknown'} ${stamp?.commit ?? '(no git)'}`)

step('Writing configuration')
ensureDir(dataDir)
ensureDir(stateDir)
ensureDir(logsDir)
if (role === 'hub') {
  ensureDir(defaultRunnerStateDir)
  ensureDir(certDir)
  ensureDir(path.dirname(runnersFile))
}
if (role === 'hub' && tls) {
  const certFile = path.join(certDir, 'hub-cert.pem')
  const keyFile = path.join(certDir, 'hub-key.pem')
  const caFile = path.join(certDir, 'ca.pem')
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile) || !fs.existsSync(caFile) || args.forceCerts) {
    if (!hasCommand('openssl'))
      fail('openssl is required to generate certificates (or pass existing certs via vibemobile.env after install)')
    const sanArgs = many(args.publicHost).flatMap((host) => ['--san', String(host)])
    step('Generating a private CA and Hub certificate')
    run(process.execPath, [path.join(ROOT, 'scripts', 'generate-hub-certs.mjs'), `--out=${certDir}`, ...sanArgs], {
      cwd: ROOT,
    })
  } else {
    ok(`reusing certificates in ${certDir}`)
  }
}

if (role === 'hub' && noDefaultRunner) {
  if (!fs.existsSync(runnersFile) || readJson(runnersFile, []).length === 0) {
    fail(
      `--no-default-runner needs a non-empty runner list at ${runnersFile} (create one with scripts/create-runner.mjs)`,
    )
  }
}
if (role === 'hub' && !noDefaultRunner) {
  if (!fs.existsSync(runnersFile)) {
    writeAtomic(runnersFile, '[]\n', 0o600)
    ok(`created empty runner list ${runnersFile}`)
  }
}

const env = role === 'hub' ? hubEnv({ pin: pinFromArgs() }) : runnerEnv()
writeEnvFile(envFile, env, [
  'Generated by deploy/install.mjs. This file contains the PIN / runner token.',
  'Keep it 0600. Edit, then: pm2 restart ' + pm2Name + ' --update-env',
])
writeAtomic(
  ecosystemFile,
  ecosystemSource({
    name: pm2Name,
    cwd: ROOT,
    script: `apps/server/dist/distributed/${role === 'hub' ? 'hub' : 'runner'}.js`,
    envFile,
    outFile: path.join(logsDir, `${role}-out.log`),
    errorFile: path.join(logsDir, `${role}-err.log`),
  }),
)
ok(`wrote ${envFile}`)
ok(`wrote ${ecosystemFile}`)

if (noStart) {
  step('Configuration written (--no-start)')
  log(`Start manually with:`)
  log(`  node --env-file=${envFile} ${path.relative(ROOT, entry)}`)
  log(`Or under PM2:`)
  log(`  pm2 start ${ecosystemFile} && pm2 save`)
  if (role === 'hub') {
    if (pinFromArgs()) log(`PIN: configured by VIBEMOBILE_PIN (${envFile})`)
    else if (!fs.existsSync(path.join(stateDir, 'state.json')))
      log(`The PIN will be generated on first start and printed in the Hub log.`)
  } else {
    log(`Runner settings (hub URL, ID, token) are in ${envFile}; the log reports "runner <id>: connected".`)
  }
  process.exit(0)
}

step('Starting under PM2')
// A re-install may be replacing a running app of the same name; remove only
// that app, then prove the ports are actually free before binding.
pm2Delete(pm2Name)
await waitForPortsFree(role === 'hub' ? [hubPort, runnerPort, codexPort] : [runnerPort, codexPort])
pm2Start({ ecosystemFile, cwd: ROOT })

if (role === 'hub') {
  step('Waiting for the Hub to answer')
  await waitForHub({ port: hubPort, tls, caPath: tls ? path.join(certDir, 'ca.pem') : undefined })
  ok(`http${tls ? 's' : ''}://127.0.0.1:${hubPort}/api/hub is alive`)
} else {
  step('Waiting for the runner to listen')
  await waitForPortListening(runnerPort)
  ok(`runner service listening on 127.0.0.1:${runnerPort}`)
}

step('Installed')
if (role === 'hub') {
  log(`    Open:  http${tls ? 's' : ''}://<this-machine>:${hubPort}/`)
  const pin = generatedPin(stateDir)
  if (pin) log(`    PIN:   ${pin}`)
  else log(`    PIN:   configured by VIBEMOBILE_PIN (or see ${path.join(stateDir, 'state.json')})`)
  if (tls) {
    log(`    Phone: install ${path.join(certDir, 'ca.crt')} as a trusted CA (iOS: enable full trust after installing)`)
    const origins = String(env.VIBEMOBILE_PUBLIC_ORIGIN ?? '')
      .split(',')
      .filter(Boolean)
    if (origins.length) log(`    Allowed origins: ${origins.join(', ')}`)
    log(`    If the LAN address changes, update VIBEMOBILE_PUBLIC_ORIGIN (lowercase, no trailing slash) and restart.`)
  }
  log(`    Runner: add remote machines with`)
  log(`      node ${path.join(ROOT, 'scripts', 'create-runner.mjs')} --id=runner-b --file=${runnersFile}`)
  log(`      (restart the Hub after the list changes: pm2 restart ${pm2Name} --update-env)`)
} else {
  log(`    Check the Hub:  pm2 logs ${pm2Name} --lines 50`)
  log(`    The runner connects out to ${env.VIBEMOBILE_HUB_URL}; no inbound port is required.`)
}
log(`    Logs:  pm2 logs ${pm2Name}`)
if (isWindows) {
  log(`    Boot:  PM2 has no working \`pm2 startup\` on Windows. Use Task Scheduler`)
  log(`           (run at startup: pm2 resurrect) or run PM2 as a service.`)
} else {
  log(`    Boot:  pm2 startup  (run the printed command once), then pm2 save`)
}

// ------------------------------------------------------- env construction

function pinFromArgs() {
  const file = one(args.pinFile)
  if (file) {
    const value = fs.readFileSync(path.resolve(String(file)), 'utf8').trim()
    if (!value) fail(`${file} is empty`)
    return value
  }
  return one(args.pin) === undefined ? undefined : String(one(args.pin))
}

function joinRoots(list) {
  return list.join(isWindows ? ';' : ':')
}

function openOrigins(scheme) {
  if (args.publicOrigin)
    return String(one(args.publicOrigin))
      .split(',')
      .map((value) => assertOrigin(value.trim()))
      .join(',')
  const hosts = many(args.publicHost).map(String)
  if (!tls && !hosts.length) return undefined
  return publicOrigins(hubPort, hosts, scheme).join(',')
}

function hubEnv({ pin }) {
  const values = {
    VIBEMOBILE_ROLE: 'hub',
    VIBEMOBILE_PM2_NAME: pm2Name,
    PORT: String(hubPort),
    VIBEMOBILE_HOST: '0.0.0.0',
    VIBEMOBILE_STATE_DIR: stateDir,
    VIBEMOBILE_DEFAULT_RUNNER: noDefaultRunner ? 'off' : 'on',
    VIBEMOBILE_DEFAULT_RUNNER_ID: 'local',
    VIBEMOBILE_DEFAULT_RUNNER_STATE_DIR: defaultRunnerStateDir,
    VIBEMOBILE_RUNNERS_FILE: runnersFile,
    VIBEMOBILE_ROOTS: joinRoots(workspaces),
    VIBEMOBILE_RUNNER_PORT: String(runnerPort),
    CODEX_PORT: String(codexPort),
    VIBEMOBILE_TERMINAL: args.noTerminal ? 'off' : 'on',
    VIBEMOBILE_LOG: 'info',
  }
  if (pin) values.VIBEMOBILE_PIN = pin
  if (tls) {
    values.VIBEMOBILE_HUB_TLS = 'on'
    values.VIBEMOBILE_HUB_TLS_CERT_FILE = path.join(certDir, 'hub-cert.pem')
    values.VIBEMOBILE_HUB_TLS_KEY_FILE = path.join(certDir, 'hub-key.pem')
    values.VIBEMOBILE_HUB_CA_FILE = path.join(certDir, 'ca.pem')
    values.VIBEMOBILE_SECURE_COOKIE = '1'
  } else {
    values.VIBEMOBILE_HUB_TLS = 'off'
    values.VIBEMOBILE_SECURE_COOKIE = '0'
  }
  const origins = openOrigins(tls ? 'https' : 'http')
  if (origins) values.VIBEMOBILE_PUBLIC_ORIGIN = origins
  return values
}

function runnerEnv() {
  const hubUrl = one(args.hubUrl)
  if (!hubUrl) fail('--hub-url=ws://host:port or wss://host:port is required for a runner')
  const parsed = new URL(String(hubUrl))
  if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('--hub-url must use ws:// or wss:// without embedded credentials')
  }
  const runnerId = one(args.runnerId)
  if (!runnerId || !/^[a-zA-Z0-9_-]{1,64}$/.test(String(runnerId)))
    fail('--runner-id is required (letters, digits, _ and -; max 64)')
  const tokenFile = one(args.runnerTokenFile)
  const token = tokenFile ? fs.readFileSync(path.resolve(String(tokenFile)), 'utf8').trim() : one(args.runnerToken)
  if (!token || String(token).length < 32) fail('--runner-token or --runner-token-file is required (32+ characters)')
  const hubCa = one(args.hubCa)
  if (hubCa && !fs.existsSync(path.resolve(String(hubCa)))) fail(`--hub-ca does not exist: ${hubCa}`)
  const values = {
    VIBEMOBILE_ROLE: 'runner',
    VIBEMOBILE_PM2_NAME: pm2Name,
    VIBEMOBILE_HUB_URL: String(hubUrl),
    VIBEMOBILE_RUNNER_ID: String(runnerId),
    VIBEMOBILE_RUNNER_TOKEN: String(token),
    VIBEMOBILE_RUNNER_PORT: String(runnerPort),
    CODEX_PORT: String(codexPort),
    VIBEMOBILE_STATE_DIR: stateDir,
    VIBEMOBILE_ROOTS: joinRoots(workspaces),
    VIBEMOBILE_TERMINAL: args.noTerminal ? 'off' : 'on',
    VIBEMOBILE_LOG: 'info',
  }
  if (hubCa) values.VIBEMOBILE_HUB_CA_FILE = path.resolve(String(hubCa))
  return values
}
