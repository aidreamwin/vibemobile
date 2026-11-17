import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser'
import { isMap, parseDocument } from 'yaml'
import type {
  CodexGlobalCatalog,
  CodexGlobalCategory,
  CodexGlobalDocument,
  CodexGlobalEntry,
} from '@vibemobile/protocol'
import { applyEol, detectEol, toLf } from '../files/eol.js'
import { resolveInside, WorkspaceError } from '../files/workspace.js'

const MAX_BYTES = 512 * 1024
const MAX_ENTRIES = 1000
const TEXT_FILE = /\.(?:md|markdown|txt|json|ya?ml|toml|py|sh|ps1|[cm]?js|tsx?|css|html|csv)$/i
const SKIP = new Set(['.git', 'node_modules', '__pycache__'])
const revision = (bytes: Buffer | null) =>
  crypto
    .createHash('sha256')
    .update(bytes === null ? 'missing:' : 'file:')
    .update(bytes ?? '')
    .digest('hex')

function validateSkill(text: string): void {
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  const document = header ? parseDocument(header[1]) : null
  if (!document || document.errors.length || !isMap(document.contents))
    throw new CodexGlobalError('codex_global_invalid_skill')
  for (const key of ['name', 'description']) {
    const value: unknown = document.get(key)
    if (typeof value !== 'string' || !value.trim()) throw new CodexGlobalError('codex_global_invalid_skill')
  }
}

export class CodexGlobalError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code)
  }
}

interface Root {
  key: string
  directory: string
  category: CodexGlobalCategory
  label: string
}

export interface GlobalSkillLocation {
  path: string
  name: string
  scope: string
}

/** Narrow access to Codex's global documents, never its credentials or session database. */
export class CodexGlobalStore {
  readonly codexHome: string
  readonly #roots: Root[]
  readonly #skillLocations?: () => Promise<GlobalSkillLocation[]>

  constructor(options: { home?: string; env?: NodeJS.ProcessEnv; skills?: () => Promise<GlobalSkillLocation[]> } = {}) {
    const home = options.home ?? os.homedir()
    this.codexHome = path.resolve((options.env ?? process.env).CODEX_HOME || path.join(home, '.codex'))
    this.#skillLocations = options.skills
    this.#roots = [
      { key: 'rules', directory: this.codexHome, category: 'rules', label: '全局规则' },
      { key: 'skills', directory: path.join(this.codexHome, 'skills'), category: 'skills', label: 'Codex 技能' },
      { key: 'user-skills', directory: path.join(home, '.agents', 'skills'), category: 'skills', label: '用户技能' },
      {
        key: 'plugins',
        directory: path.join(this.codexHome, 'plugins', 'cache'),
        category: 'skills',
        label: '插件技能',
      },
      { key: 'memory', directory: path.join(this.codexHome, 'memories'), category: 'memory', label: '记忆 v1' },
      { key: 'memory-v2', directory: path.join(this.codexHome, 'memories_v2'), category: 'memory', label: '记忆 v2' },
    ]
  }

  #root(key: string): Root {
    const root = this.#roots.find((candidate) => candidate.key === key)
    if (!root) throw new CodexGlobalError('codex_global_invalid_path', 403)
    return root
  }

  #decode(id: string): { root: Root; file: string; relative: string } {
    let value: unknown
    try {
      if (typeof id !== 'string' || id.length > 4096 || !/^[\w-]+$/.test(id)) throw new Error('id')
      value = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'))
    } catch {
      throw new CodexGlobalError('codex_global_invalid_path', 403)
    }
    if (!Array.isArray(value) || value.length !== 2 || value.some((part) => typeof part !== 'string'))
      throw new CodexGlobalError('codex_global_invalid_path', 403)
    const [key, relative] = value as [string, string]
    const root = this.#root(key)
    if (
      !relative ||
      relative.includes('\\') ||
      relative
        .split('/')
        .some((part) => !part || (part.startsWith('.') && !(root.category === 'skills' && part === '.system')))
    )
      throw new CodexGlobalError('codex_global_invalid_path', 403)
    return this.#resolve(root, relative)
  }

  #resolve(root: Root, relative: string) {
    const segments = relative.split('/')
    if (root.category === 'rules' && !['AGENTS.md', 'AGENTS.override.md'].includes(relative))
      throw new CodexGlobalError('codex_global_invalid_path', 403)
    if (root.category === 'memory' && (!/\.md$/i.test(relative) || segments.some((part) => part.startsWith('.'))))
      throw new CodexGlobalError('codex_global_invalid_path', 403)
    if (root.category === 'skills' && (!TEXT_FILE.test(relative) || segments.some((part) => SKIP.has(part))))
      throw new CodexGlobalError('codex_global_invalid_path', 403)
    const file = resolveInside([root.directory], path.resolve(root.directory, relative))
    if (root.category === 'skills' && !this.#skillDirectory(root, file))
      throw new CodexGlobalError('codex_global_invalid_path', 403)
    return { root, file, relative }
  }

  #skillDirectory(root: Root, file: string): string | null {
    let current = path.dirname(file)
    while (
      current !== root.directory &&
      path.relative(root.directory, current) &&
      !path.relative(root.directory, current).startsWith('..')
    ) {
      const definition = path.join(current, 'SKILL.md')
      resolveInside([root.directory], definition)
      if (fs.existsSync(definition) && fs.statSync(definition).isFile()) return current
      current = path.dirname(current)
    }
    return null
  }

  #entry(root: Root, file: string, title?: string): CodexGlobalEntry {
    resolveInside([root.directory], file)
    const relativePath = path.relative(root.directory, file).split(path.sep).join('/')
    let stat: fs.Stats | undefined
    try {
      stat = fs.statSync(file)
      if (!stat.isFile()) throw new CodexGlobalError('codex_global_not_file', 400)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return {
      id: Buffer.from(JSON.stringify([root.key, relativePath])).toString('base64url'),
      category: root.category,
      title: title ?? (path.basename(file) === 'SKILL.md' ? path.basename(path.dirname(file)) : relativePath),
      path: file,
      relativePath,
      source: root.label,
      exists: Boolean(stat),
      bytes: stat?.size ?? 0,
      updatedAt: stat?.mtimeMs ?? 0,
    }
  }

  #walk(
    root: Root,
    directory = root.directory,
    depth = 0,
    results: string[] = [],
    budget = { remaining: 5000 },
  ): string[] {
    if (depth > 8 || results.length >= MAX_ENTRIES || budget.remaining <= 0) return results
    resolveInside([root.directory], directory)
    if (!fs.existsSync(directory)) return results
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (--budget.remaining < 0 || results.length >= MAX_ENTRIES) break
      if (
        SKIP.has(entry.name) ||
        (entry.name.startsWith('.') && !(root.category === 'skills' && entry.name === '.system'))
      )
        continue
      const full = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) this.#walk(root, full, depth + 1, results, budget)
      else if (entry.isFile() && (root.category === 'memory' ? /\.md$/i.test(entry.name) : TEXT_FILE.test(entry.name)))
        results.push(full)
    }
    return results
  }

  async catalog(): Promise<CodexGlobalCatalog> {
    const entries: CodexGlobalEntry[] = []
    const warnings: string[] = []
    const rules = this.#root('rules')
    for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
      try {
        entries.push(this.#entry(rules, path.join(this.codexHome, name), name))
      } catch {
        warnings.push(`无法读取 ${name}，请检查文件权限或链接。`)
      }
    }
    for (const root of this.#roots.filter((item) => item.category !== 'rules' && item.key !== 'plugins')) {
      try {
        const files = this.#walk(root)
        for (const file of files) {
          if (root.category === 'skills' && path.basename(file) !== 'SKILL.md') continue
          entries.push(this.#entry(root, file))
        }
        if (files.length >= MAX_ENTRIES) warnings.push(`${root.label}文件较多，仅显示前 ${MAX_ENTRIES} 项。`)
      } catch {
        warnings.push(`无法完整读取${root.label}，请检查执行机上的文件权限。`)
      }
    }
    if (this.#skillLocations) {
      try {
        for (const skill of await this.#skillLocations()) {
          if (
            skill.scope === 'repo' ||
            !path.isAbsolute(skill.path) ||
            entries.some((entry) => entry.path === skill.path)
          )
            continue
          const root = this.#roots.find(
            (candidate) =>
              candidate.category === 'skills' &&
              !path.relative(candidate.directory, skill.path).startsWith('..') &&
              !path.isAbsolute(path.relative(candidate.directory, skill.path)),
          )
          if (!root) continue
          try {
            entries.push(
              this.#entry(
                root,
                this.#resolve(root, path.relative(root.directory, skill.path).split(path.sep).join('/')).file,
                skill.name,
              ),
            )
          } catch {
            warnings.push(`无法读取技能 ${skill.name}。`)
          }
        }
      } catch {
        warnings.push('暂时无法获取 Codex 已加载的插件技能，已显示用户技能目录。')
      }
    }
    let memoryEnabled: boolean | null = null
    try {
      const file = path.join(this.codexHome, 'config.toml')
      const data = getStaticTOMLValue(parseTOML(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')) as {
        features?: { memories?: boolean }
      }
      memoryEnabled = typeof data.features?.memories === 'boolean' ? data.features.memories : null
    } catch {
      warnings.push('无法读取记忆功能的全局开关。')
    }
    return { codexHome: this.codexHome, entries, warnings, memoryEnabled }
  }

  read(id: string): CodexGlobalDocument {
    const { root, file } = this.#decode(id)
    const entry = this.#entry(root, file)
    if (!entry.exists && root.category !== 'rules') throw new CodexGlobalError('codex_global_not_found', 404)
    const bytes = entry.exists ? this.#readBytes(file) : null
    const truncated = entry.bytes > MAX_BYTES
    const text = bytes?.toString('utf8') ?? ''
    const editable = !truncated && (bytes === null || Buffer.from(text, 'utf8').equals(bytes))
    let files: CodexGlobalEntry[] = []
    if (root.category === 'skills') {
      const directory = this.#skillDirectory(root, file)!
      files = this.#walk(root, directory).map((item) => this.#entry(root, item))
    }
    return { entry, text, truncated, editable, revision: revision(bytes), files }
  }

  #readBytes(file: string): Buffer {
    const handle = fs.openSync(file, 'r')
    try {
      const bytes = Buffer.alloc(Math.min(fs.fstatSync(handle).size, MAX_BYTES))
      const read = fs.readSync(handle, bytes, 0, bytes.length, 0)
      if (bytes.subarray(0, read).includes(0)) throw new CodexGlobalError('codex_global_not_text', 415)
      return bytes.subarray(0, read)
    } finally {
      fs.closeSync(handle)
    }
  }

  save(id: string, text: string, expectedRevision: string): CodexGlobalDocument {
    if (typeof text !== 'string' || text.includes('\0')) throw new CodexGlobalError('codex_global_invalid_text')
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new CodexGlobalError('codex_global_too_large', 413)
    const current = this.read(id)
    if (!expectedRevision || expectedRevision !== current.revision)
      throw new CodexGlobalError('codex_global_changed', 409)
    if (!current.editable) throw new CodexGlobalError('codex_global_read_only', 415)
    const { root, file } = this.#decode(id)
    if (root.category === 'skills' && path.basename(file) === 'SKILL.md') validateSkill(text)
    // Do not turn an absent override into an empty file unless the user saved
    // it explicitly; reads above never create directories or shadow AGENTS.md.
    const bytes = current.entry.exists ? fs.readFileSync(file) : null
    const body = Buffer.from(applyEol(toLf(text), bytes ? detectEol(bytes) : '\n'), 'utf8')
    if (body.length > MAX_BYTES) throw new CodexGlobalError('codex_global_too_large', 413)
    this.#write(root, file, body)
    return this.read(id)
  }

  createSkill(name: string, text: string): CodexGlobalDocument {
    if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name))
      throw new CodexGlobalError('codex_global_invalid_skill_name')
    if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > MAX_BYTES)
      throw new CodexGlobalError('codex_global_invalid_text')
    validateSkill(text)
    const root = this.#root('user-skills')
    const file = resolveInside([root.directory], path.join(root.directory, name, 'SKILL.md'))
    if (fs.existsSync(path.dirname(file))) throw new CodexGlobalError('codex_global_skill_exists', 409)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#write(root, file, Buffer.from(toLf(text), 'utf8'))
    return this.read(this.#entry(root, file).id)
  }

  #write(root: Root, file: string, bytes: Buffer): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    resolveInside([root.directory], file)
    const temporary = path.join(path.dirname(file), `.vibemobile-${crypto.randomBytes(12).toString('hex')}.tmp`)
    try {
      const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o600
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode })
      fs.renameSync(temporary, file)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
}

export function codexGlobalFailure(error: unknown): { status: number; code: string } {
  if (error instanceof CodexGlobalError) return { status: error.status, code: error.code }
  if (error instanceof WorkspaceError) return { status: error.status, code: 'codex_global_invalid_path' }
  return { status: 500, code: 'codex_global_io_error' }
}
