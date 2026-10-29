/**
 * Full-replacement updater. Run from a *newly extracted* update package:
 *
 *   node deploy/update.mjs --target=/opt/vibemobile
 *
 * The old release keeps running while the new one is installed and built under
 * <target>/releases/<stamp>. Only then is the PM2 process swapped. PIN, JWT
 * secret, sessions, images, certs and vibemobile.env live outside the release
 * directory and are never touched.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ecosystemSource,
  ensureDir,
  fail,
  generatedPin,
  hasCommand,
  isWindows,
  log,
  nodeMajor,
  npmCliPath,
  ok,
  one,
  parseArgs,
  pm2Available,
  pm2Delete,
  pm2Start,
  readEnvFile,
  readJson,
  readRelease,
  run,
  runNpm,
  sanitizeSegment,
  step,
  waitForHub,
  waitForPortListening,
  waitForPortsFree,
  warn,
  writeAtomic,
  copyTree,
} from './lib/common.mjs'

const SOURCE = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = parseArgs()
const dryRun = args.dryRun === true || args.dryRun === 'true'
const noStart = args.noStart === true || args.noStart === 'true'
const keep = Math.max(2, Number(one(args.keep) ?? 2))

if (args.help === true) {
  log(`Usage: node deploy/update.mjs --target=<install-root> [options]

  --target=<dir>     install root created by deploy/install.mjs (required)
  --keep=<n>         releases to keep, including the active one (default 2)
  --no-start         stage and build, write the ecosystem file, do not restart PM2
  --dry-run          validate and print the plan, change nothing
  --name=<pm2-name>  override the name recorded in vibemobile.env
`)
  process.exit(0)
}

const target = one(args.target)
if (!target) fail('--target=<install-root> is required')
const TARGET = path.resolve(String(target))
const sourceRelease = readRelease(SOURCE)
if (!sourceRelease) fail('RELEASE.json is missing — run update.mjs from an extracted update/hub/runner package')
if (!['update', 'hub', 'runner'].includes(sourceRelease.contents))
  fail(`unexpected package kind: ${sourceRelease.contents}`)
if (path.resolve(SOURCE) === TARGET)
  fail('extract the update package somewhere else; running it in place would copy the target into itself')

const envFile = path.join(TARGET, 'vibemobile.env')
const env = readEnvFile(envFile)
if (!Object.keys(env).length)
  fail(`${envFile} not found or empty; is --target an install created by deploy/install.mjs?`)
const role = env.VIBEMOBILE_ROLE === 'runner' || env.VIBEMOBILE_HUB_URL ? 'runner' : 'hub'
if (sourceRelease.contents === 'runner' && role !== 'runner') fail('this is a runner package, but the target is a Hub')
if (sourceRelease.contents !== 'runner' && role === 'runner')
  fail('this is a Hub update package, but the target is a runner')

const pm2Name = String(
  one(args.name) ?? env.VIBEMOBILE_PM2_NAME ?? (role === 'hub' ? 'vibemobile' : 'vibemobile-runner'),
)
const hubPort = Number(env.PORT ?? 3000)
const runnerPort = Number(env.VIBEMOBILE_RUNNER_PORT ?? 5901)
const codexPort = Number(env.CODEX_PORT ?? 6900)
const tls = env.VIBEMOBILE_HUB_TLS === 'on'
const stateDir = path.resolve(env.VIBEMOBILE_STATE_DIR ?? path.join(TARGET, 'data', role === 'hub' ? 'hub' : 'state'))
const certDir = path.join(TARGET, 'data', 'certs')

const stamp = sanitizeSegment(
  [
    sourceRelease.serverVersion,
    role === 'hub' && sourceRelease.webVersion ? `w${sourceRelease.webVersion}` : null,
    sourceRelease.commit ?? 'unknown',
  ]
    .filter(Boolean)
    .join('-'),
)
const releaseDir = path.join(TARGET, 'releases', stamp)
const ecosystemFile = path.join(TARGET, 'ecosystem.config.cjs')
const activeFile = path.join(TARGET, 'active-release.json')
const logsDir = path.join(TARGET, 'data', 'logs')
const backupDir = path.join(TARGET, 'data', 'backups', stamp)

if (path.resolve(releaseDir).startsWith(`${SOURCE}${path.sep}`))
  fail(
    'the target release directory would be inside the extracted package; extract the package outside the install root',
  )

step('Update plan')
for (const [key, value] of Object.entries({
  source: SOURCE,
  target: TARGET,
  role,
  stamp,
  releaseDir,
  pm2Name,
  ports: role === 'hub' ? `${hubPort}/${runnerPort}/${codexPort}` : `${runnerPort}/${codexPort}`,
  tls,
  stateDir,
}))
  ok(`${key}: ${value}`)

if (nodeMajor() < 20) fail(`Node >= 20 is required, found ${process.versions.node}`)
if (!npmCliPath() && !hasCommand('npm')) fail('npm not found')
if (!dryRun && !noStart && !pm2Available()) fail('PM2 is not available to the current user')
if (!dryRun && fs.existsSync(releaseDir) && fs.readdirSync(releaseDir).length) {
  fail(`${releaseDir} already exists; remove it or ship a release with a different commit`)
}

if (dryRun) {
  step('Dry run: no files written, no process touched')
  process.exit(0)
}

if (process.platform === 'linux') {
  const missingTools = ['python3', 'make', 'g++'].filter((tool) => !hasCommand(tool))
  if (missingTools.length)
    fail(
      `Linux needs a C++ toolchain for node-pty (missing: ${missingTools.join(', ')}); install build-essential or gcc-c++/make/python3`,
    )
}

// ------------------------------------------------------------- build first

step('Staging the new release (the old one keeps running)')
ensureDir(path.dirname(releaseDir))
fs.rmSync(releaseDir, { recursive: true, force: true })
copyTree(SOURCE, releaseDir, (source) => {
  const relative = path.relative(SOURCE, source)
  if (!relative) return false
  const top = relative.split(path.sep)[0]
  return ['node_modules', 'dist', '.git', '.vibemobile', '.multi-runner', 'certs', 'release'].includes(top)
})

step('Installing dependencies')
runNpm(['ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund', '--foreground-scripts'], {
  cwd: releaseDir,
  unset: ['NODE_ENV', 'npm_config_production', 'npm_config_omit', 'npm_config_build_from_source'],
})
if (!fs.existsSync(path.join(releaseDir, 'node_modules', '@openai', 'codex', 'package.json')))
  fail('Codex CLI was not installed; `npm ci` must include devDependencies')
if (!fs.existsSync(path.join(releaseDir, 'node_modules', 'node-pty'))) fail('node-pty was not installed')

step('Building')
runNpm(['run', 'build', '--workspace=@vibemobile/server'], { cwd: releaseDir })
run(process.execPath, ['-e', "require('node-pty')"], { cwd: releaseDir })
run(process.execPath, ['-e', "require.resolve('@openai/codex/package.json')"], { cwd: releaseDir })
const entry =
  role === 'hub'
    ? path.join(releaseDir, 'apps/server/dist/distributed/hub.js')
    : path.join(releaseDir, 'apps/server/dist/distributed/runner.js')
if (!fs.existsSync(entry)) fail(`build output missing: ${entry}`)
if (role === 'hub') {
  runNpm(['run', 'build', '--workspace=@vibemobile/web'], { cwd: releaseDir })
  if (!fs.existsSync(path.join(releaseDir, 'apps/web/dist/index.html'))) fail('web build output missing')
}
const built = readJson(path.join(releaseDir, 'apps/server/dist/version.json'), undefined)
if (
  built?.commit &&
  sourceRelease.commit &&
  built.commit !== String(sourceRelease.commit).slice(0, built.commit.length)
) {
  warn(`build stamp ${built.commit} differs from package commit ${sourceRelease.commit}`)
}
ok(`new build: server ${built?.version ?? 'unknown'} ${built?.commit ?? '(no git)'}`)

// --------------------------------------------------------------- swap

const oldEcosystem = fs.existsSync(ecosystemFile) ? fs.readFileSync(ecosystemFile, 'utf8') : null
const previousDir = ecosystemCwd(oldEcosystem)
step('Writing the new ecosystem file')
ensureDir(logsDir)
writeAtomic(
  ecosystemFile,
  ecosystemSource({
    name: pm2Name,
    cwd: releaseDir,
    script: `apps/server/dist/distributed/${role === 'hub' ? 'hub' : 'runner'}.js`,
    envFile,
    outFile: path.join(logsDir, `${role}-out.log`),
    errorFile: path.join(logsDir, `${role}-err.log`),
  }),
)
ok(`${ecosystemFile} -> ${releaseDir}`)

if (noStart) {
  writeActive(previousDir)
  step('Staged (--no-start). Start when ready:')
  log(`  pm2 delete ${pm2Name}; pm2 start ${ecosystemFile} --update-env; pm2 save`)
  process.exit(0)
}

step('Backing up the current configuration')
ensureDir(backupDir)
if (oldEcosystem) writeAtomic(path.join(backupDir, 'ecosystem.config.cjs'), oldEcosystem)
if (fs.existsSync(activeFile)) fs.copyFileSync(activeFile, path.join(backupDir, 'active-release.json'))
ok(backupDir)

step('Swapping the PM2 process')
try {
  pm2Delete(pm2Name)
  await waitForPortsFree(role === 'hub' ? [hubPort, runnerPort, codexPort] : [runnerPort, codexPort])
  pm2Start({ ecosystemFile, cwd: TARGET })
  await healthy()
  writeActive(previousDir)
  prune()
  step('Updated')
  log(`    active:  ${releaseDir}`)
  if (role === 'hub') {
    log(`    Open:    http${tls ? 's' : ''}://<this-machine>:${hubPort}/`)
    const pin = generatedPin(stateDir)
    if (pin) log(`    PIN:     ${pin} (unchanged)`)
  } else {
    log(`    Check:   pm2 logs ${pm2Name} --lines 50`)
  }
} catch (error) {
  warn(`the new release did not come up: ${error.message}`)
  step('Rolling back')
  if (oldEcosystem) {
    try {
      writeAtomic(ecosystemFile, oldEcosystem)
      pm2Delete(pm2Name)
      await waitForPortsFree(role === 'hub' ? [hubPort, runnerPort, codexPort] : [runnerPort, codexPort])
      pm2Start({ ecosystemFile, cwd: TARGET })
      await healthy()
      ok('rolled back; the previous release is running')
    } catch (rollbackError) {
      warn(`rollback also failed: ${rollbackError.message}`)
      warn(`inspect: pm2 logs ${pm2Name}; ecosystem backup at ${backupDir}`)
    }
  } else {
    warn(`no previous ecosystem file to restore; backup dir: ${backupDir}`)
  }
  process.exit(1)
}

// -------------------------------------------------------------- helpers

function ecosystemCwd(source) {
  if (!source) return null
  const match = source.match(/\bcwd:\s*("(?:[^"\\]|\\.)*")/)
  if (!match) return null
  try {
    const value = JSON.parse(match[1])
    return path.resolve(value)
  } catch {
    return null
  }
}

function writeActive(previous) {
  writeAtomic(
    activeFile,
    `${JSON.stringify(
      {
        active: releaseDir,
        previous: previous && path.resolve(previous) !== releaseDir ? previous : null,
        commit: sourceRelease.commit ?? null,
        serverVersion: sourceRelease.serverVersion ?? null,
        webVersion: sourceRelease.webVersion ?? null,
        updatedAt: new Date().toISOString(),
        manager: noStart ? 'none' : 'pm2',
      },
      null,
      2,
    )}\n`,
    0o600,
  )
}

async function healthy() {
  if (role === 'hub') {
    await waitForHub({ port: hubPort, tls, caPath: tls ? path.join(certDir, 'ca.pem') : undefined })
  } else {
    await waitForPortListening(runnerPort)
  }
}

function prune() {
  const releasesDir = path.join(TARGET, 'releases')
  if (!fs.existsSync(releasesDir)) return
  const keepDirs = new Set([path.resolve(releaseDir)])
  const previous = ecosystemCwd(oldEcosystem)
  if (previous && previous.startsWith(`${releasesDir}${path.sep}`)) keepDirs.add(previous)
  const entries = fs
    .readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(releasesDir, entry.name))
    .filter((dir) => !keepDirs.has(dir))
    .sort()
  const remove = entries.slice(0, Math.max(0, entries.length - Math.max(0, keep - keepDirs.size)))
  for (const dir of remove) {
    fs.rmSync(dir, { recursive: true, force: true })
    ok(`pruned ${dir}`)
  }
}
