import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexGlobalStore } from './codexGlobal.js'

let directory: string
let codexHome: string
let store: CodexGlobalStore
const skill = (name = 'demo') => `---\nname: ${name}\ndescription: A reusable workflow.\n---\n\n# Steps\n`
const id = (root: string, relative: string) => Buffer.from(JSON.stringify([root, relative])).toString('base64url')
function write(relative: string, text: string | Buffer) {
  const file = path.join(codexHome, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-codex-global-'))
  codexHome = path.join(directory, 'custom-codex')
  store = new CodexGlobalStore({ home: directory, env: { CODEX_HOME: codexHome } })
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

describe('Codex global documents', () => {
  it('browses missing rules without writing files, then creates only the selected global file', async () => {
    const catalog = await store.catalog()
    expect(catalog.codexHome).toBe(codexHome)
    expect(catalog.entries).toHaveLength(2)
    const document = store.read(catalog.entries[0].id)
    expect(document).toMatchObject({ text: '', editable: true, entry: { exists: false, title: 'AGENTS.md' } })
    expect(fs.existsSync(codexHome)).toBe(false)
    const saved = store.save(document.entry.id, 'Always update version numbers.\n', document.revision)
    expect(saved.entry.exists).toBe(true)
    expect(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8')).toContain('version numbers')
    expect(fs.existsSync(path.join(codexHome, 'AGENTS.override.md'))).toBe(false)
  })

  it('keeps override rules separate and rejects stale or missing revisions', async () => {
    write('AGENTS.md', 'normal\r\n')
    const file = write('AGENTS.override.md', 'override\r\n')
    const document = store.read(id('rules', 'AGENTS.override.md'))
    store.save(document.entry.id, 'edited\n', document.revision)
    expect(fs.readFileSync(file, 'utf8')).toBe('edited\r\n')
    expect(() => store.save(document.entry.id, 'stale', document.revision)).toThrow('codex_global_changed')
    expect(() => store.save(document.entry.id, 'missing', '')).toThrow('codex_global_changed')
    expect(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8')).toBe('normal\r\n')
  })

  it('detects a file created externally after opening an absent rule', () => {
    const document = store.read(id('rules', 'AGENTS.md'))
    const file = write('AGENTS.md', 'missing')
    expect(() => store.save(document.entry.id, 'my draft', document.revision)).toThrow('codex_global_changed')
    expect(fs.readFileSync(file, 'utf8')).toBe('missing')
  })

  it('checks the save limit after restoring original line endings', () => {
    const file = write('AGENTS.md', 'original\r\n')
    const document = store.read(id('rules', 'AGENTS.md'))
    const draft = 'x\n'.repeat(180_000)
    expect(Buffer.byteLength(draft)).toBeLessThan(512 * 1024)
    expect(() => store.save(document.entry.id, draft, document.revision)).toThrow('codex_global_too_large')
    expect(fs.readFileSync(file, 'utf8')).toBe('original\r\n')
  })

  it('lists both user skill locations, system skills and active plugin skills, excluding repository skills', async () => {
    write('skills/local/SKILL.md', skill('local'))
    write('skills/.system/built-in/SKILL.md', skill('built-in'))
    const plugin = write('plugins/cache/vendor/bundle/1.0/skills/plugin/SKILL.md', skill('plugin'))
    write('plugins/cache/vendor/bundle/old/skills/unused/SKILL.md', skill('unused'))
    store.createSkill('user-skill', skill('user-skill'))
    store = new CodexGlobalStore({
      home: directory,
      env: { CODEX_HOME: codexHome },
      skills: async () => [
        { path: plugin, name: 'Plugin', scope: 'user' },
        { path: path.join(directory, 'repo/SKILL.md'), name: 'repo', scope: 'repo' },
      ],
    })
    const catalog = await store.catalog()
    expect(
      catalog.entries
        .filter((entry) => entry.category === 'skills')
        .map((entry) => entry.title)
        .sort(),
    ).toEqual(['Plugin', 'built-in', 'local', 'user-skill'])
    for (const entry of catalog.entries.filter((entry) => entry.category === 'skills'))
      expect(store.read(entry.id).text).toContain('description:')
  })

  it('edits skill definitions and scripts while keeping other files intact', () => {
    write('skills/demo/SKILL.md', skill())
    const script = write('skills/demo/scripts/check.py', 'print("before")\r\n')
    write('skills/demo/assets/icon.png', Buffer.from([0, 1, 2]))
    const document = store.read(id('skills', 'demo/SKILL.md'))
    expect(document.files.map((entry) => entry.relativePath)).toEqual(['demo/scripts/check.py', 'demo/SKILL.md'])
    const scriptDocument = store.read(document.files[0].id)
    store.save(scriptDocument.entry.id, 'print("after")\n', scriptDocument.revision)
    expect(fs.readFileSync(script, 'utf8')).toBe('print("after")\r\n')
    expect(() => store.save(document.entry.id, '# missing frontmatter', document.revision)).toThrow(
      'codex_global_invalid_skill',
    )
    expect(fs.readFileSync(document.entry.path, 'utf8')).toBe(skill())
  })

  it('creates valid skills and refuses directory traversal, duplicate folders and invalid definitions', () => {
    const created = store.createSkill('release-check', skill('release-check'))
    expect(created.entry.path).toBe(path.join(directory, '.agents/skills/release-check/SKILL.md'))
    expect(() => store.createSkill('../outside', skill())).toThrow('codex_global_invalid_skill_name')
    expect(() => store.createSkill('release-check', skill())).toThrow('codex_global_skill_exists')
    for (const text of ['plain markdown', '---\nname: demo\n---\nSteps', '---\nname: []\ndescription: x\n---\n']) {
      expect(() => store.createSkill('invalid', text)).toThrow('codex_global_invalid_skill')
    }
    expect(fs.existsSync(path.join(directory, '.agents/skills/invalid'))).toBe(false)
  })

  it('browses and edits both memory versions without exposing databases, credentials or git metadata', async () => {
    write('config.toml', '[features]\nmemories = false\n')
    write('auth.json', '{"secret":"private"}')
    write('memories/MEMORY.md', 'legacy memory')
    write('memories_v2/memory_summary.md', 'v1\nSummary')
    write('memories_v2/memories/MEMORY.md', 'current memory')
    write('memories_v2/.git/config', 'private')
    write('memories_v2/state.sqlite', 'database')
    const catalog = await store.catalog()
    expect(catalog.memoryEnabled).toBe(false)
    const entries = catalog.entries.filter((entry) => entry.category === 'memory')
    expect(entries).toHaveLength(3)
    const memory = store.read(entries.find((entry) => entry.relativePath === 'memories/MEMORY.md')!.id)
    store.save(memory.entry.id, 'updated memory', memory.revision)
    expect(fs.readFileSync(memory.entry.path, 'utf8')).toBe('updated memory')
    for (const [root, file] of [
      ['rules', 'auth.json'],
      ['rules', 'config.toml'],
      ['memory-v2', '.git/config'],
      ['memory-v2', 'state.sqlite'],
      ['skills', '../auth.json'],
      ['skills', 'other.json'],
    ]) {
      expect(() => store.read(id(root, file))).toThrow()
    }
    expect(JSON.stringify(catalog)).not.toContain('private')
  })

  it('refuses symlinks that escape a document root on reads and saves', () => {
    write('skills/demo/SKILL.md', skill())
    const outside = path.join(directory, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.md'), 'private')
    fs.symlinkSync(
      outside,
      path.join(codexHome, 'skills/demo/linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(() => store.read(id('skills', 'demo/linked/secret.md'))).toThrow('link')
    expect(() => store.save(id('skills', 'demo/linked/secret.md'), 'overwrite', 'revision')).toThrow('link')
    expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('private')
  })

  it('never saves truncated or non-UTF-8 documents', () => {
    write('memories/large.md', 'x'.repeat(512 * 1024 + 1))
    const large = store.read(id('memory', 'large.md'))
    expect(large).toMatchObject({ truncated: true, editable: false })
    expect(() => store.save(large.entry.id, 'shorter', large.revision)).toThrow('codex_global_read_only')
    write('AGENTS.md', Buffer.from([0xff, 0xfe]))
    const nonUtf8 = store.read(id('rules', 'AGENTS.md'))
    expect(nonUtf8.editable).toBe(false)
    expect(() => store.save(nonUtf8.entry.id, 'new text', nonUtf8.revision)).toThrow('codex_global_read_only')
  })
})
