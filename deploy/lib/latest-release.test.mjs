import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { publishLatest } from '../../scripts/publish-latest.mjs'
import { sha256 } from './common.mjs'

const repo = 'test/vibemobile'
const serverUrl = 'https://github.com'
const roles = ['hub', 'runner', 'update']
const installerNames = ['hub-install.sh', 'runner-install.sh', 'hub-install.ps1', 'runner-install.ps1']
const commits = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]

function snapshot(t, commit, buildId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-latest-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const short = commit.slice(0, 12)
  function file(name) {
    const target = path.join(dir, name)
    fs.writeFileSync(target, `${name}:${commit}:${buildId}\n`)
    return { file: name, sha256: sha256(target) }
  }
  const manifest = {
    commit: short,
    buildId,
    dirty: false,
    serverVersion: '1.0.0',
    webVersion: '1.0.0',
    artifacts: Object.fromEntries(
      roles.map((role) => [role, file(`vibemobile-${role}-1.0.0-${short}-b${buildId}.tar.gz`)]),
    ),
    installers: Object.fromEntries(installerNames.map((name) => [name, file(name)])),
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(
    path.join(dir, 'SHA256SUMS'),
    [...Object.values(manifest.artifacts), ...Object.values(manifest.installers)]
      .map(({ file, sha256 }) => `${sha256}  ${file}\n`)
      .join(''),
  )
  return {
    dir,
    manifest,
    archiveNames: Object.values(manifest.artifacts).map(({ file }) => file),
    run(remote) {
      return publishLatest({ dir, repository: repo, commit, serverUrl, runId: '123', gh: remote.gh })
    },
  }
}

function remoteGitHub() {
  const stable = { id: 1, tag_name: 'v1.0.0-1.0.0', prerelease: false, draft: false, immutable: false }
  const state = {
    main: commits[0],
    stable,
    latest: null,
    tag: null,
    assets: [],
    operations: [],
    failUpload: null,
    afterUpload: null,
  }
  let id = 1
  state.gh = (args) => {
    if (args[0] === 'release') {
      assert.deepEqual(args.slice(0, 3), ['release', 'upload', 'latest'])
      const file = args[3]
      const name = path.basename(file)
      state.operations.push(`upload:${name}`)
      const existing = state.assets.find((entry) => entry.name === name)
      if (existing) {
        assert.ok(args.includes('--clobber'))
        state.assets = state.assets.filter((entry) => entry.name !== name)
      }
      if (name === state.failUpload) throw new Error('Simulated upload failure')
      state.assets.push({ id: id++, name, state: 'uploaded', digest: `sha256:${sha256(file)}` })
      state.afterUpload?.(name)
      return ''
    }

    assert.equal(args[0], 'api')
    const endpoint = args.find((arg) => arg.startsWith(`repos/${repo}/`)).slice(`repos/${repo}/`.length)
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET'
    const fields = {}
    for (let index = 1; index < args.length; index++) {
      if (!['-f', '-F'].includes(args[index])) continue
      const field = args[++index]
      const separator = field.indexOf('=')
      fields[field.slice(0, separator)] = field.slice(separator + 1)
    }
    const json = JSON.stringify
    if (endpoint === 'git/ref/heads/main') return json({ object: { sha: state.main } })
    if (endpoint === 'releases?per_page=100') return json([[stable, state.latest].filter(Boolean)])
    if (endpoint === 'releases' && method === 'POST') {
      assert.equal(fields.tag_name, 'latest')
      assert.equal(fields.draft, 'true')
      assert.equal(fields.prerelease, 'true')
      assert.equal(fields.make_latest, 'false')
      state.operations.push('create-draft')
      state.latest = { id: 2, tag_name: 'latest', prerelease: true, draft: true, immutable: false }
      return json(state.latest)
    }
    if (endpoint === 'releases/2/assets?per_page=100') return json([state.assets])
    if (endpoint === 'git/matching-refs/tags/latest') {
      return json(state.tag ? [{ ref: 'refs/tags/latest', object: { sha: state.tag } }] : [])
    }
    if (endpoint === 'git/refs' && method === 'POST') {
      assert.equal(fields.ref, 'refs/tags/latest')
      state.operations.push('create-tag')
      state.tag = fields.sha
      return ''
    }
    if (endpoint === 'git/refs/tags/latest' && method === 'PATCH') {
      assert.equal(fields.force, 'true')
      state.operations.push('move-tag')
      state.tag = fields.sha
      return ''
    }
    if (endpoint === 'releases/2' && method === 'PATCH') {
      assert.equal(fields.draft, 'false')
      assert.equal(fields.prerelease, 'true')
      assert.equal(fields.make_latest, 'false')
      assert.equal(fields.target_commitish, state.tag)
      assert.match(fields.body, /releases\/download\/latest\/hub-install\.sh/)
      state.operations.push('publish')
      state.latest.draft = false
      return ''
    }
    if (endpoint.startsWith('releases/assets/') && method === 'DELETE') {
      const assetId = Number(endpoint.split('/').pop())
      state.operations.push(`delete:${assetId}`)
      state.assets = state.assets.filter((entry) => entry.id !== assetId)
      return ''
    }
    throw new Error(`Unexpected GitHub operation: ${method} ${endpoint}`)
  }
  return state
}

test('publishes main as a separate prerelease after uploading all archives and installers', (t) => {
  const remote = remoteGitHub()
  const first = snapshot(t, commits[0], '100-1')
  assert.equal(first.run(remote), true)
  assert.equal(remote.tag, commits[0])
  assert.equal(remote.latest.draft, false)
  assert.equal(remote.latest.prerelease, true)
  assert.equal(remote.stable.prerelease, false)
  assert.equal(remote.assets.length, 9)
  assert.deepEqual(remote.operations.slice(0, 4), [
    'create-draft',
    ...first.archiveNames.map((name) => `upload:${name}`),
  ])
  assert.deepEqual(remote.operations.slice(-2), ['create-tag', 'publish'])
})

test('updates the rolling tag, keeps previous archives and reuses identical assets on retries', (t) => {
  const remote = remoteGitHub()
  const first = snapshot(t, commits[0], '100-1')
  const second = snapshot(t, commits[1], '101-1')
  const third = snapshot(t, commits[2], '102-1')
  first.run(remote)
  remote.main = commits[1]
  second.run(remote)
  assert.equal(remote.tag, commits[1])
  assert.equal(remote.assets.length, 12)
  remote.main = commits[2]
  third.run(remote)
  assert.equal(remote.tag, commits[2])
  assert.equal(remote.assets.length, 12)
  for (const name of first.archiveNames) assert.ok(!remote.assets.some((asset) => asset.name === name))
  for (const name of [...second.archiveNames, ...third.archiveNames]) {
    assert.ok(remote.assets.some((asset) => asset.name === name))
  }
  remote.operations.length = 0
  assert.equal(third.run(remote), true)
  assert.deepEqual(remote.operations, ['publish'])
})

test('skips outdated builds and never replaces published entry points if main advances during upload', (t) => {
  const remote = remoteGitHub()
  const first = snapshot(t, commits[0], '100-1')
  const second = snapshot(t, commits[1], '101-1')
  first.run(remote)
  remote.main = commits[1]
  remote.operations.length = 0
  assert.equal(first.run(remote), false)
  assert.deepEqual(remote.operations, [])
  remote.afterUpload = () => {
    remote.main = commits[2]
  }
  assert.equal(second.run(remote), false)
  assert.equal(remote.tag, commits[0])
  assert.deepEqual(
    remote.operations,
    second.archiveNames.map((name) => `upload:${name}`),
  )
})

test('a failed refresh keeps previous archives and can be retried without replacing uploaded archives', (t) => {
  const remote = remoteGitHub()
  const first = snapshot(t, commits[0], '100-1')
  const next = snapshot(t, commits[1], '101-1')
  first.run(remote)
  remote.main = commits[1]
  remote.failUpload = 'runner-install.sh'
  assert.throws(() => next.run(remote), /Simulated upload failure/)
  assert.equal(remote.tag, commits[0])
  for (const name of [...first.archiveNames, ...next.archiveNames]) {
    assert.ok(remote.assets.some((asset) => asset.name === name))
  }
  remote.failUpload = null
  remote.operations.length = 0
  assert.equal(next.run(remote), true)
  assert.equal(remote.tag, commits[1])
  assert.ok(!remote.operations.some((op) => next.archiveNames.some((name) => op === `upload:${name}`)))
  assert.ok(remote.assets.some((asset) => asset.name === 'runner-install.sh'))
})

test('refuses to modify a stable release or invalid package', (t) => {
  const remote = remoteGitHub()
  const first = snapshot(t, commits[0], '100-1')
  remote.latest = { id: 2, tag_name: 'latest', prerelease: false, draft: false }
  assert.throws(() => first.run(remote), /mutable prerelease/)
  assert.deepEqual(remote.operations, [])
  fs.appendFileSync(path.join(first.dir, first.archiveNames[0]), 'corrupt')
  assert.throws(() => first.run(remote), /Checksum mismatch/)
  assert.deepEqual(remote.operations, [])
})
