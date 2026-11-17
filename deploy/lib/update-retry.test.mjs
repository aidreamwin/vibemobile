import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const deploy = fileURLToPath(new URL('..', import.meta.url))

for (const activeSource of ['metadata', 'ecosystem']) {
  test(`retry refuses to replace a release referenced by ${activeSource}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-update-retry-'))
    try {
      const source = path.join(root, 'source')
      const target = path.join(root, 'target')
      const release = path.join(target, 'releases', '1.0.0-testcommit')
      fs.mkdirSync(release, { recursive: true })
      fs.mkdirSync(source)
      fs.cpSync(deploy, path.join(source, 'deploy'), { recursive: true })
      fs.writeFileSync(
        path.join(source, 'RELEASE.json'),
        JSON.stringify({ contents: 'runner', serverVersion: '1.0.0', commit: 'testcommit' }),
      )
      fs.writeFileSync(path.join(target, 'vibemobile.env'), 'VIBEMOBILE_ROLE=runner\n')
      fs.writeFileSync(path.join(release, 'preserve.txt'), 'active release')
      if (activeSource === 'metadata') {
        fs.writeFileSync(path.join(target, 'active-release.json'), JSON.stringify({ active: release }))
      } else {
        fs.writeFileSync(
          path.join(target, 'ecosystem.config.cjs'),
          `module.exports = { apps: [{ cwd: ${JSON.stringify(release)} }] }`,
        )
      }
      const result = spawnSync(
        process.execPath,
        [path.join(source, 'deploy', 'update.mjs'), `--target=${target}`, '--replace-release', '--no-start'],
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      )
      assert.equal(result.status, 1)
      assert.match(result.stderr, /is the active release; refusing to replace it/)
      assert.equal(fs.readFileSync(path.join(release, 'preserve.txt'), 'utf8'), 'active release')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
