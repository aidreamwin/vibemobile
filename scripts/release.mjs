/**
 * Build the three distributable PM2 packages:
 *
 *   npm run release                       # release/
 *   npm run release -- --kind=runner      # only the runner package
 *   npm run release -- --allow-dirty      # include uncommitted work
 *   npm run release -- --skip-verify      # skip tests/build (not recommended)
 *
 * Artifacts contain source only. `node_modules`, `dist` and every secret are
 * excluded, and the actual `npm ci` + build happens on the target machine so
 * that node-pty, the Codex CLI and the Claude CLI match that platform.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = parseArgs()
const outDir = path.resolve(ROOT, String(one(args.out) ?? 'release'))
const kind = String(one(args.kind) ?? 'all')
const allowDirty = flag('allow-dirty')
const skipVerify = flag('skip-verify')
const force = flag('force')
const keepStage = flag('keep-stage')
const targets = ['linux-x64', 'win32-x64', 'linux-arm64']

const HUB_ENTRIES = [
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  '.env.example',
  '.nvmrc',
  'apps/server/package.json',
  'apps/server/tsconfig.json',
  'apps/server/tsconfig.build.json',
  'apps/server/vitest.config.ts',
  'apps/server/src',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
  'apps/web/vite.config.ts',
  'apps/web/index.html',
  'apps/web/components.json',
  'apps/web/public',
  'apps/web/src',
  'packages/protocol/package.json',
  'packages/protocol/src',
  'scripts/build-info.mjs',
  'scripts/build-info.d.mts',
  'scripts/generate-hub-certs.mjs',
  'scripts/create-runner.mjs',
  'deploy',
  'docs/pm2-release.md',
  'docs/hub-tls.md',
  'docs/multi-runner.md',
  'docs/architecture.md',
  'docs/deployment.md',
  'docs/limitations.md',
  'docs/releasing.md',
  'docs/error-reporting.md',
  'docs/Caddyfile.multi-runner.example',
]

const RUNNER_ENTRIES = HUB_ENTRIES.filter((entry) => {
  if (entry === 'apps/web/package.json') return true
  return !entry.startsWith('apps/web/') && !entry.startsWith('docs/')
})

if (!['all', 'hub', 'update', 'runner'].includes(kind)) fail('--kind must be all, hub, update or runner')

const serverPackage = readJson(path.join(ROOT, 'apps/server/package.json'))
const webPackage = readJson(path.join(ROOT, 'apps/web/package.json'))
const rootPackage = readJson(path.join(ROOT, 'package.json'))
const serverVersion = String(serverPackage.version)
const webVersion = String(webPackage.version)
const codexVersion = String(rootPackage.devDependencies?.['@openai/codex'] ?? 'unknown')

step('Checking the source tree')
if (!fs.existsSync(path.join(ROOT, 'package-lock.json')))
  fail('package-lock.json is missing; npm ci cannot run on the target')
const status = git(['status', '--porcelain'])
const dirty = status !== null && status.trim().length > 0
if (dirty && !allowDirty) {
  fail(
    `working tree is dirty:\n${status.trim()}\nCommit first, or pass --allow-dirty (the artifact name will be marked dirty).`,
  )
}
const commit = git(['rev-parse', '--short=12', 'HEAD']) ?? 'nogit'
const dirtySuffix = dirty ? `-dirty-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}` : ''
ok(`commit ${commit}${dirty ? ' (dirty)' : ''}`)
ok(`server ${serverVersion} / web ${webVersion} / codex ${codexVersion}`)

if (!skipVerify) {
  step('Running tests and a full build')
  npm(['test'])
  npm(['run', 'build:all'])
} else {
  warn('--skip-verify: tests and build were not run')
}

fs.mkdirSync(outDir, { recursive: true })

const artifacts = []
const hubName = `vibemobile-hub-${serverVersion}-w${webVersion}-${commit}${dirtySuffix}.tar.gz`
const updateName = `vibemobile-update-${serverVersion}-w${webVersion}-${commit}${dirtySuffix}.tar.gz`
const runnerName = `vibemobile-runner-${serverVersion}-${commit}${dirtySuffix}.tar.gz`

const writeHub = kind === 'all' || kind === 'hub'
const writeUpdate = kind === 'all' || kind === 'update'

if (writeHub || writeUpdate) {
  const stage = path.join(outDir, `.stage-hub-${process.pid}`)
  try {
    stagePackage(stage, 'hub')
    writeReleaseJson(stage, 'hub')
    let hubArchive
    if (writeHub) {
      hubArchive = path.join(outDir, hubName)
      ensureNew(hubArchive)
      archiveDirectory(stage, hubArchive)
      artifacts.push({
        key: 'hub',
        file: hubName,
        bytes: fs.statSync(hubArchive).size,
        sha256: sha256(hubArchive),
        contents: 'hub',
      })
      ok(`${hubName} (${formatBytes(fs.statSync(hubArchive).size)})`)
    }
    if (writeUpdate) {
      const updateArchive = path.join(outDir, updateName)
      ensureNew(updateArchive)
      if (hubArchive) fs.copyFileSync(hubArchive, updateArchive)
      else archiveDirectory(stage, updateArchive)
      artifacts.push({
        key: 'update',
        file: updateName,
        bytes: fs.statSync(updateArchive).size,
        sha256: sha256(updateArchive),
        contents: 'hub',
        ...(hubArchive ? { identicalTo: 'hub' } : {}),
      })
      ok(`${updateName} (${hubArchive ? 'same bytes as hub' : 'complete hub payload'})`)
    }
  } finally {
    if (!keepStage) fs.rmSync(stage, { recursive: true, force: true })
  }
}

if (kind === 'all' || kind === 'runner') {
  const stage = path.join(outDir, `.stage-runner-${process.pid}`)
  try {
    stagePackage(stage, 'runner')
    writeReleaseJson(stage, 'runner')
    const archive = path.join(outDir, runnerName)
    ensureNew(archive)
    archiveDirectory(stage, archive)
    artifacts.push({
      key: 'runner',
      file: runnerName,
      bytes: fs.statSync(archive).size,
      sha256: sha256(archive),
      contents: 'runner',
    })
    ok(`${runnerName} (${formatBytes(fs.statSync(archive).size)})`)
  } finally {
    if (!keepStage) fs.rmSync(stage, { recursive: true, force: true })
  }
}

const sums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`).join('\n')
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums}\n`)
fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  `${JSON.stringify(
    {
      format: 1,
      generatedAt: new Date().toISOString(),
      commit,
      dirty,
      serverVersion,
      webVersion,
      codexVersion,
      targets,
      artifacts: Object.fromEntries(artifacts.map((artifact) => [artifact.key, artifact])),
      prerequisites: {
        node: '>=20',
        linuxNativeBuild: ['python3', 'make', 'g++'],
        npmCiIncludesDev: true,
      },
    },
    null,
    2,
  )}\n`,
)

step('Done')
for (const artifact of artifacts) log(`    ${artifact.file}  sha256=${artifact.sha256.slice(0, 16)}…`)
log(`    ${path.relative(process.cwd(), path.join(outDir, 'SHA256SUMS'))}`)
log(`    ${path.relative(process.cwd(), path.join(outDir, 'manifest.json'))}`)

// ------------------------------------------------------------------ helpers

function parseArgs(argv = process.argv.slice(2)) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`)
    const eq = token.indexOf('=')
    const name = token.slice(2, eq === -1 ? undefined : eq)
    let value = eq === -1 ? undefined : token.slice(eq + 1)
    if (value === undefined) {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        value = next
        index++
      } else value = true
    }
    values[name] = value
  }
  return values
}
function one(value) {
  return Array.isArray(value) ? value[value.length - 1] : value
}
function flag(name) {
  return args[name] === true || args[name] === 'true'
}
function log(message = '') {
  process.stdout.write(`${message}\n`)
}
function step(message) {
  log(`\n==> ${message}`)
}
function ok(message) {
  log(`    ${message}`)
}
function warn(message) {
  log(`    ! ${message}`)
}
function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function git(gitArgs) {
  const result = spawnSync('git', ['-C', ROOT, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout.trim() : null
}
function npm(npmArgs) {
  const cli = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ].find((candidate) => candidate && candidate.endsWith('npm-cli.js') && fs.existsSync(candidate))
  const result = cli
    ? spawnSync(process.execPath, [cli, ...npmArgs], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', npmArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) fail(`npm ${npmArgs.join(' ')} exited with ${result.status}`)
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function formatBytes(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}
function ensureNew(file) {
  if (fs.existsSync(file) && !force) fail(`${path.relative(ROOT, file)} already exists; pass --force to replace it`)
}

function stagePackage(stage, contents) {
  const entries = contents === 'runner' ? RUNNER_ENTRIES : HUB_ENTRIES
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  step(`Staging the ${contents} package`)
  for (const entry of entries) {
    const source = path.join(ROOT, entry)
    if (!fs.existsSync(source)) {
      if (entry === '.env.example') continue
      fail(`whitelisted path is missing: ${entry}`)
    }
    copy(entry, source, path.join(stage, entry))
  }
  ok(`${entries.length} entries`)
}

function copy(relative, source, destination) {
  const stat = fs.statSync(source)
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true })
    for (const child of fs.readdirSync(source, { withFileTypes: true })) {
      if (child.name === 'node_modules' || child.name === 'dist' || child.name === '.git') continue
      if (relative === 'packages/protocol/src' && child.name === 'generated') continue
      if (relative === 'deploy' && (child.name === 'node_modules' || child.name.endsWith('.env'))) continue
      // Tests and their fixtures are not part of the runtime; the fixture
      // directory also contains a throwaway private key.
      if (/\.test\.(ts|tsx|mts)$/.test(child.name)) continue
      if (child.name === 'fixtures' && relative.endsWith('distributed')) continue
      copy(path.posix.join(relative, child.name), path.join(source, child.name), path.join(destination, child.name))
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
}

function writeReleaseJson(stage, contents) {
  const release = {
    format: 1,
    contents,
    targets,
    serverVersion,
    webVersion,
    commit,
    dirty,
    packagedAt: new Date().toISOString(),
    packagedFrom: { platform: process.platform, arch: process.arch, node: process.versions.node },
    codexVersion,
    nodeEngine: rootPackage.engines?.node ?? '>=20',
  }
  fs.writeFileSync(path.join(stage, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`)
}

function tarCommand() {
  const candidates = [
    process.env.TAR,
    process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : null,
    'tar',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (result.status === 0) return candidate
  }
  fail('tar is required to create the archives')
}

function archiveDirectory(stage, archive) {
  const tar = tarCommand()
  // `-C stage .` keeps the archive target-neutral and relative.
  const result = spawnSync(tar, ['-czf', archive, '-C', stage, '.'], { stdio: 'inherit' })
  if (result.status !== 0) fail(`tar exited with ${result.status}`)
  const list = spawnSync(tar, ['-tzf', archive], { encoding: 'utf8' })
  if (list.status !== 0) fail('the archive cannot be listed')
  const names = list.stdout.split(/\r?\n/).filter(Boolean)
  const forbidden = [
    /(^|\/)node_modules\//,
    /(^|\/)dist\//,
    /(^|\/)\.vibemobile\//,
    /(^|\/)\.multi-runner\//,
    /(^|\/)certs\//,
    /(^|\/)\.git\//,
    /packages\/protocol\/src\/generated\//,
    /(^|\/)ecosystem\.config\.cjs$/,
    /(^|\/)vibemobile\.env$/,
    /\.(pem|key|p12|pfx)$/,
    /(^|\/)runner-credentials\.json$/,
  ]
  for (const name of names) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) {
      fail(`archive contains an unsafe path: ${name}`)
    }
    if (forbidden.some((pattern) => pattern.test(name))) fail(`archive contains a forbidden entry: ${name}`)
  }
  for (const required of ['./RELEASE.json', './deploy/install.mjs', './deploy/update.mjs', './package-lock.json']) {
    if (!names.includes(required)) fail(`archive is missing ${required}`)
  }
}
