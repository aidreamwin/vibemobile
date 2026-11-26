import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256 } from '../deploy/lib/common.mjs'

const TAG = 'latest'
const ROLES = ['hub', 'runner', 'update']
const INSTALLERS = ['hub-install.sh', 'runner-install.sh', 'hub-install.ps1', 'runner-install.ps1']

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr.trim() || result.status}`)
  return result.stdout
}

function readSnapshot(dir, commit) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  if (
    manifest.dirty !== false ||
    !/^[a-f0-9]{12,40}$/.test(manifest.commit) ||
    !commit.startsWith(manifest.commit) ||
    !manifest.buildId
  ) {
    throw new Error('Latest release assets must come from the current workflow commit and include a build ID.')
  }

  function verify(entry) {
    if (!entry?.file || path.basename(entry.file) !== entry.file) throw new Error('Invalid release asset name.')
    const file = path.join(dir, entry.file)
    if (sha256(file) !== entry.sha256) throw new Error(`Checksum mismatch: ${entry.file}`)
    return { ...entry, path: file }
  }

  const archives = ROLES.map((role) => {
    const entry = verify(manifest.artifacts?.[role])
    if (
      !entry.file.startsWith(`vibemobile-${role}-`) ||
      !entry.file.endsWith(`-${manifest.commit}-b${manifest.buildId}.tar.gz`)
    ) {
      throw new Error(`Invalid ${role} snapshot archive: ${entry.file}`)
    }
    return entry
  })
  const installers = INSTALLERS.map((name) => {
    const entry = verify(manifest.installers?.[name])
    if (entry.file !== name) throw new Error(`Missing installer: ${name}`)
    return entry
  })
  const indexes = ['SHA256SUMS', 'manifest.json'].map((file) => ({
    file,
    path: path.join(dir, file),
    sha256: sha256(path.join(dir, file)),
  }))
  return { manifest, archives, aliases: [...installers, ...indexes] }
}

function releaseNotes({ repository, serverUrl, commit, manifest, runId }) {
  const project = `${serverUrl}/${repository}`
  const base = `${project}/releases/download/${TAG}`
  return [
    'Automatically built from `main` for development and testing.',
    '',
    `Commit: [${commit.slice(0, 12)}](${project}/commit/${commit})`,
    `Server: ${manifest.serverVersion} · Web: ${manifest.webVersion} · [Build](${project}/actions/runs/${runId})`,
    '',
    '## Install or upgrade the development build',
    '',
    'Linux / macOS',
    '```sh',
    `curl -LsSf ${base}/hub-install.sh | sh`,
    `curl -LsSf ${base}/runner-install.sh | sh`,
    '```',
    '',
    'Windows PowerShell',
    '```powershell',
    `& ([scriptblock]::Create((curl.exe -LsSf '${base}/hub-install.ps1' | Out-String)))`,
    `& ([scriptblock]::Create((curl.exe -LsSf '${base}/runner-install.ps1' | Out-String)))`,
    '```',
    '',
    'Install Hub first, then create a Runner connection token in Settings. Run the installer again to upgrade.',
    '',
    `[Stable releases](${project}/releases/latest) · [Installation guide](${project}/blob/main/docs/quick-install.md)`,
    '',
  ].join('\n')
}

export function publishLatest({ dir, repository, commit, serverUrl, runId, gh = runGh }) {
  const { manifest, archives, aliases } = readSnapshot(dir, commit)
  const repoApi = `repos/${repository}`
  const api = (endpoint, ...args) => gh(['api', `${repoApi}/${endpoint}`, ...args])
  const get = (endpoint) => JSON.parse(api(endpoint))
  const list = (endpoint) => JSON.parse(gh(['api', '--paginate', '--slurp', `${repoApi}/${endpoint}`])).flat()
  const currentMain = () => get('git/ref/heads/main').object.sha === commit

  // The publish job is serialized, but older CI runs can finish building later.
  if (!currentMain()) {
    console.log(`Skipping ${commit}: main has advanced.`)
    return false
  }

  const title = `Latest main build (${manifest.commit})`
  const notes = releaseNotes({ repository, serverUrl, commit, manifest, runId })
  let release = list('releases?per_page=100').find((entry) => entry.tag_name === TAG)
  if (release && (!release.prerelease || release.immutable)) {
    throw new Error('The latest tag must belong to a mutable prerelease.')
  }
  if (!release) {
    release = JSON.parse(
      api(
        'releases',
        '--method',
        'POST',
        '-f',
        `tag_name=${TAG}`,
        '-f',
        `target_commitish=${commit}`,
        '-f',
        `name=${title}`,
        '-f',
        `body=${notes}`,
        '-F',
        'draft=true',
        '-F',
        'prerelease=true',
        '-f',
        'make_latest=false',
      ),
    )
  }

  const assetsEndpoint = `releases/${release.id}/assets?per_page=100`
  const existing = list(assetsEndpoint)
  const matching = (asset, entry) => asset?.state === 'uploaded' && asset.digest === `sha256:${entry.sha256}`

  function upload(entry, mutable = false) {
    const asset = existing.find(({ name }) => name === entry.file)
    if (matching(asset, entry)) return
    if (asset?.state === 'uploaded' && !mutable) throw new Error(`Archive name already in use: ${entry.file}`)
    gh(['release', 'upload', TAG, entry.path, ...(asset || mutable ? ['--clobber'] : [])])
  }

  // Each installer includes the archive's URL and checksum. Upload the unique
  // archives before changing any entry point, and retain older archives during
  // the update so a previously downloaded script still has its payload.
  for (const archive of archives) upload(archive)
  if (!currentMain()) {
    console.log(`Skipping publication of ${commit}: main has advanced.`)
    return false
  }
  for (const alias of aliases) upload(alias, true)

  const publishedAssets = list(assetsEndpoint)
  for (const entry of [...archives, ...aliases]) {
    if (
      !matching(
        publishedAssets.find(({ name }) => name === entry.file),
        entry,
      )
    ) {
      throw new Error(`Published asset verification failed: ${entry.file}`)
    }
  }

  // --target on a GitHub release does not move an existing tag. Update only
  // the rolling tag; versioned release tags remain immutable.
  const ref = `refs/tags/${TAG}`
  const previousTag = get(`git/matching-refs/tags/${TAG}`).find((entry) => entry.ref === ref)
  if (!previousTag) {
    api('git/refs', '--method', 'POST', '-f', `ref=${ref}`, '-f', `sha=${commit}`, '--silent')
  } else if (previousTag.object.sha !== commit) {
    api(`git/refs/tags/${TAG}`, '--method', 'PATCH', '-f', `sha=${commit}`, '-F', 'force=true', '--silent')
  }

  api(
    `releases/${release.id}`,
    '--method',
    'PATCH',
    '-F',
    'draft=false',
    '-F',
    'prerelease=true',
    '-f',
    'make_latest=false',
    '-f',
    `name=${title}`,
    '-f',
    `body=${notes}`,
    '-f',
    `target_commitish=${commit}`,
    '--silent',
  )

  const currentNames = new Set(archives.map(({ file }) => file))
  for (const role of ROLES) {
    const obsolete = publishedAssets
      .filter(
        ({ name }) => name.startsWith(`vibemobile-${role}-`) && name.endsWith('.tar.gz') && !currentNames.has(name),
      )
      .sort((a, b) => b.id - a.id)
    // Keep the previous archive for each role, including for clients that
    // fetched the installer immediately before this publication.
    const previous = obsolete.find(({ state }) => state === 'uploaded')
    for (const asset of obsolete) {
      if (asset.id !== previous?.id) api(`releases/assets/${asset.id}`, '--method', 'DELETE', '--silent')
    }
  }
  console.log(`Published latest prerelease for ${commit}.`)
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { GITHUB_REF, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_RUN_ID, GH_TOKEN } = process.env
    if (
      GITHUB_REF !== 'refs/heads/main' ||
      !GITHUB_REPOSITORY ||
      !/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? '') ||
      !GITHUB_SERVER_URL ||
      !GITHUB_RUN_ID ||
      !GH_TOKEN
    ) {
      throw new Error('Run the publisher from the main-branch CI publish job.')
    }
    publishLatest({
      dir: path.resolve('release'),
      repository: GITHUB_REPOSITORY,
      commit: GITHUB_SHA,
      serverUrl: GITHUB_SERVER_URL,
      runId: GITHUB_RUN_ID,
    })
  } catch (error) {
    console.error(`publish-latest: ${error.message}`)
    process.exitCode = 1
  }
}
