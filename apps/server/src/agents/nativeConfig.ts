import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyEdits, modify, parse as parseJson, type ParseError } from 'jsonc-parser'
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser'
import type { AgentProfileRequest, AgentRuntimeId, NativeAgentProfile, NativeAgentProvider } from '@vibemobile/protocol'
import { AgentProfileError, cleanProfile } from './profiles.js'
import { editTomlValue } from './nativeToml.js'

type ObjectValue = Record<string, unknown>
interface Document {
  file: string
  raw: string | null
  data: ObjectValue
}
interface Snapshot {
  config: Document
  auth?: Document
  revision: string
  sources: Document[]
}
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {}
const string = (value: unknown): string => (typeof value === 'string' ? value : '')
const aliasKey = /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL(?:_NAME)?$/

function merge(base: ObjectValue, overlay: ObjectValue): ObjectValue {
  const result = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value) ? merge(object(base[key]), object(value)) : value
  }
  return result
}

/** Only connection fields are editable. OAuth, MCP, permissions and session files stay intact. */
export class NativeAgentConfigStore {
  readonly #stateDir: string
  readonly #home: string
  readonly #env: NodeJS.ProcessEnv

  constructor(stateDir: string, options: { home?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.#stateDir = stateDir
    this.#home = options.home ?? os.homedir()
    this.#env = options.env ?? process.env
  }

  #configPath(agent: AgentRuntimeId): string {
    if (agent === 'codex') return path.join(this.#env.CODEX_HOME || path.join(this.#home, '.codex'), 'config.toml')
    if (agent === 'claude')
      return path.join(this.#env.CLAUDE_CONFIG_DIR || path.join(this.#home, '.claude'), 'settings.json')
    if (this.#env.OPENCODE_CONFIG) return path.resolve(this.#env.OPENCODE_CONFIG)
    const dir = path.join(this.#env.XDG_CONFIG_HOME || path.join(this.#home, '.config'), 'opencode')
    // Match OpenCode's precedence: opencode.jsonc overrides opencode.json, which overrides config.json.
    return (
      ['opencode.jsonc', 'opencode.json', 'config.json']
        .map((name) => path.join(dir, name))
        .find((file) => fs.existsSync(file)) ?? path.join(dir, 'opencode.json')
    )
  }

  #document(file: string, toml = false): Document {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, raw: null, data: {} }
      throw new AgentProfileError('agent_native_unreadable', 500)
    }
    try {
      const source = raw.replace(/^\uFEFF/, '')
      const errors: ParseError[] = []
      const value: unknown = toml
        ? getStaticTOMLValue(parseTOML(source))
        : parseJson(source, errors, { allowTrailingComma: true })
      if (errors.length || !value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('object required')
      return { file, raw, data: object(value) }
    } catch {
      throw new AgentProfileError('agent_native_invalid', 400)
    }
  }

  #snapshot(agent: AgentRuntimeId): Snapshot {
    const config = this.#document(this.#configPath(agent), agent === 'codex')
    const auth = agent === 'codex' ? this.#document(path.join(path.dirname(config.file), 'auth.json')) : undefined
    let sources = [config, ...(auth ? [auth] : [])]
    if (agent === 'opencode') {
      const dir = path.join(this.#env.XDG_CONFIG_HOME || path.join(this.#home, '.config'), 'opencode')
      const files = [
        ...new Set(
          ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => path.join(dir, name)).concat(config.file),
        ),
      ]
      sources = files.map((file) => (file === config.file ? config : this.#document(file)))
      config.data = sources.reduce((data, source) => merge(data, source.data), {})
    }
    return { config, auth, sources, revision: this.#revision(sources) }
  }

  #revision(documents: Document[]): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(documents.map(({ file, raw }) => [file, raw])))
      .digest('hex')
  }

  read(agent: AgentRuntimeId, active: boolean): NativeAgentProfile {
    const result: NativeAgentProfile = {
      id: 'native',
      name: '执行机现有配置',
      baseUrl: null,
      model: null,
      models: [],
      hasApiKey: false,
      active,
      updatedAt: 0,
      sourcePath: this.#configPath(agent),
      exists: false,
      revision: '',
      providerId: null,
      providers: [],
      modelAliases: {},
      keyEditable: true,
      keySource: null,
    }
    try {
      const snapshot = this.#snapshot(agent)
      const { config, auth } = snapshot
      result.exists = config.raw !== null
      result.revision = snapshot.revision
      result.updatedAt = result.exists ? fs.statSync(config.file).mtimeMs : 0
      const data = config.data
      if (agent === 'claude') {
        const env = object(data.env)
        result.baseUrl = string(env.ANTHROPIC_BASE_URL) || this.#env.ANTHROPIC_BASE_URL || null
        result.model = string(env.ANTHROPIC_MODEL) || string(data.model) || null
        result.hasApiKey = Boolean(
          env.ANTHROPIC_AUTH_TOKEN ||
            env.ANTHROPIC_API_KEY ||
            this.#env.ANTHROPIC_AUTH_TOKEN ||
            this.#env.ANTHROPIC_API_KEY,
        )
        result.keySource = env.ANTHROPIC_AUTH_TOKEN
          ? 'settings.env.ANTHROPIC_AUTH_TOKEN'
          : env.ANTHROPIC_API_KEY
            ? 'settings.env.ANTHROPIC_API_KEY'
            : null
        result.modelAliases = Object.fromEntries(
          Object.entries(env).filter(([key, value]) => aliasKey.test(key) && typeof value === 'string'),
        ) as Record<string, string>
      } else {
        const providers = object(agent === 'codex' ? data.model_providers : data.provider)
        const model = string(data.model)
        result.providerId =
          agent === 'codex'
            ? string(data.model_provider) || 'openai'
            : model.split('/').length > 1
              ? model.slice(0, model.indexOf('/'))
              : (Object.keys(providers)[0] ?? null)
        result.providers = Object.entries(providers).map(([id, value]): NativeAgentProvider => {
          const provider = object(value)
          const options = agent === 'codex' ? provider : object(provider.options)
          return {
            id,
            name: string(provider.name) || id,
            baseUrl: string(agent === 'codex' ? options.base_url : options.baseURL) || null,
            hasApiKey:
              agent === 'codex'
                ? Boolean(this.#env[string(provider.env_key)] || object(auth?.data).OPENAI_API_KEY)
                : Boolean(options.apiKey),
            models: Object.keys(object(provider.models)),
          }
        })
        const selected = result.providers.find((provider) => provider.id === result.providerId)
        result.baseUrl = selected?.baseUrl ?? null
        result.model = agent === 'opencode' && model.includes('/') ? model.slice(model.indexOf('/') + 1) : model || null
        result.hasApiKey = selected?.hasApiKey ?? Boolean(auth?.data.OPENAI_API_KEY)
        if (agent === 'codex') {
          const envKey = string(object(providers[result.providerId ?? '']).env_key)
          result.keyEditable = !envKey
          result.keySource = envKey ? `env:${envKey}` : 'auth.json · OPENAI_API_KEY'
        } else result.keySource = selected?.hasApiKey ? 'provider.options.apiKey' : null
      }
    } catch (error) {
      result.exists = fs.existsSync(result.sourcePath)
      result.error = error instanceof AgentProfileError ? error.code : 'agent_native_unreadable'
    }
    return result
  }

  /** Returns an undo function for the caller's restart transaction. No read ever writes native files. */
  update(agent: AgentRuntimeId, input: Partial<AgentProfileRequest>): () => void {
    const snapshot = this.#snapshot(agent)
    if (!input.revision || input.revision !== snapshot.revision)
      throw new AgentProfileError('agent_native_changed', 409)
    const view = this.read(agent, true)
    const values = cleanProfile({ ...input, name: 'native' })
    const config = snapshot.config
    let text = config.raw ?? (agent === 'codex' ? '' : '{}\n')
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const documents = snapshot.sources
    const next = new Map<string, string>()
    const set = (keys: string[], value: unknown) => {
      text = applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }))
    }
    if (agent === 'claude') {
      if (input.baseUrl !== undefined) set(['env', 'ANTHROPIC_BASE_URL'], values.baseUrl || undefined)
      if (input.model !== undefined) {
        set(['model'], values.model || undefined)
        if (object(config.data.env).ANTHROPIC_MODEL !== undefined)
          set(['env', 'ANTHROPIC_MODEL'], values.model || undefined)
      }
      if (input.apiKey !== undefined) {
        const env = object(config.data.env)
        const key = env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'
        set(['env', key], values.apiKey || undefined)
        set(['env', key === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'], undefined)
      }
      if (input.modelAliases !== undefined) {
        if (
          !input.modelAliases ||
          typeof input.modelAliases !== 'object' ||
          Array.isArray(input.modelAliases) ||
          Object.keys(input.modelAliases).length > 40
        )
          throw new AgentProfileError('invalid_agent_profile_value')
        for (const [key, value] of Object.entries(input.modelAliases)) {
          if (!aliasKey.test(key)) throw new AgentProfileError('invalid_agent_profile_value')
          const cleaned = cleanProfile({ name: 'alias', model: value }).model
          set(['env', key], cleaned || undefined)
        }
      }
    } else {
      const providerId = input.providerId ?? view.providerId ?? (agent === 'codex' ? 'openai' : '')
      const providersKey = agent === 'codex' ? 'model_providers' : 'provider'
      const providers = object(config.data[providersKey])
      if (!providerId || (input.providerId && !Object.hasOwn(providers, providerId) && providerId !== 'openai'))
        throw new AgentProfileError('agent_native_provider_missing')
      if (agent === 'codex') {
        const provider = object(providers[providerId])
        if (input.apiKey !== undefined && provider.env_key) throw new AgentProfileError('agent_native_env_key')
        if (input.model !== undefined) text = editTomlValue(text, ['model'], values.model || undefined)
        if (input.providerId !== undefined) text = editTomlValue(text, ['model_provider'], providerId)
        if (input.baseUrl !== undefined && (values.baseUrl || Object.hasOwn(providers, providerId))) {
          text = editTomlValue(text, ['model_providers', providerId, 'base_url'], values.baseUrl || undefined)
          if (!Object.hasOwn(providers, providerId)) {
            text = editTomlValue(text, ['model_providers', providerId, 'name'], providerId)
            text = editTomlValue(text, ['model_providers', providerId, 'wire_api'], 'responses')
          }
        }
        if (input.apiKey !== undefined && snapshot.auth) {
          const auth = snapshot.auth
          next.set(
            auth.file,
            applyEdits(
              auth.raw ?? '{}\n',
              modify(auth.raw ?? '{}\n', ['OPENAI_API_KEY'], values.apiKey || undefined, {
                formattingOptions: { insertSpaces: true, tabSize: 2, eol },
              }),
            ),
          )
        }
      } else {
        if (input.baseUrl !== undefined)
          set(['provider', providerId, 'options', 'baseURL'], values.baseUrl || undefined)
        if (input.apiKey !== undefined) set(['provider', providerId, 'options', 'apiKey'], values.apiKey || undefined)
        if (input.model !== undefined) set(['model'], values.model ? `${providerId}/${values.model}` : undefined)
        if (input.models !== undefined) {
          if (
            !Array.isArray(input.models) ||
            input.models.length > 100 ||
            input.models.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200)
          )
            throw new AgentProfileError('invalid_agent_profile_value')
          const currentModels = object(object(providers[providerId]).models)
          const nextModels: ObjectValue = {}
          for (const value of [...new Set(input.models.map((item) => item.trim()))]) {
            nextModels[value] = currentModels[value] ?? { name: value }
          }
          set(['provider', providerId, 'models'], nextModels)
        }
      }
    }
    next.set(config.file, text)
    const changes = documents.filter((document) => next.has(document.file) && next.get(document.file) !== document.raw)
    if (!changes.length) return () => {}
    const backupDir = path.join(
      this.#stateDir,
      'agent-config-backups',
      `${agent}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    )
    try {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
      for (const document of changes)
        if (document.raw !== null)
          fs.writeFileSync(path.join(backupDir, path.basename(document.file)), document.raw, {
            mode: 0o600,
            flag: 'wx',
          })
    } catch {
      throw new AgentProfileError('agent_native_backup_failed', 500)
    }
    const written: Document[] = []
    try {
      // Re-read after backup to detect another editor changing the files before replacement.
      if (this.#snapshot(agent).revision !== snapshot.revision) throw new AgentProfileError('agent_native_changed', 409)
      for (const document of changes) {
        this.#write(document.file, next.get(document.file) ?? '')
        written.push(document)
      }
    } catch (error) {
      for (const document of written.reverse()) this.#restore(document)
      throw error
    }
    return () => {
      for (const document of written) {
        if (fs.readFileSync(document.file, 'utf8') !== next.get(document.file))
          throw new AgentProfileError('agent_native_changed', 409)
      }
      for (const document of written) this.#restore(document)
    }
  }

  #restore(document: Document) {
    if (document.raw === null) fs.rmSync(document.file, { force: true })
    else this.#write(document.file, document.raw)
  }

  #write(file: string, text: string) {
    const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, file)
    } catch {
      throw new AgentProfileError('agent_native_unwritable', 500)
    } finally {
      fs.rmSync(temp, { force: true })
    }
  }
}
