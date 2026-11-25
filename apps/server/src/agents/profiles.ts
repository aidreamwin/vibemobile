import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AgentProfileRequest,
  AgentProfileId,
  AgentRuntimeId,
  AgentProfilesResponse,
  AntigravityConnectionRequest,
} from '@vibemobile/protocol'
import { AGENT_IDS } from './manifest.js'

export interface StoredAgentProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  models: string[]
  modelContextWindows?: Record<string, number>
  updatedAt: number
}

interface ProfileFile {
  version: 1
  active: Record<AgentProfileId, string | null>
  profiles: Record<AgentProfileId, StoredAgentProfile[]>
  nativeNames: Partial<Record<AgentRuntimeId, string>>
}

export class AgentProfileError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(code)
  }
}

const PROFILE_IDS = [...AGENT_IDS, 'antigravity'] as const

export function isAgentProfileId(value: string): value is AgentProfileId {
  return PROFILE_IDS.some((id) => id === value)
}

interface ProfileHooks {
  beforeApply?: (agent: AgentProfileId, profile?: StoredAgentProfile) => void | Promise<void>
  apply?: (agent: AgentProfileId) => void | Promise<void>
}

function emptyFile(): ProfileFile {
  return {
    version: 1,
    active: { codex: null, claude: null, opencode: null, antigravity: null },
    profiles: { codex: [], claude: [], opencode: [], antigravity: [] },
    nativeNames: {},
  }
}

function field(value: unknown, max: number): string {
  if (value === undefined) return ''
  if (
    typeof value !== 'string' ||
    value.length > max ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new AgentProfileError('invalid_agent_profile_value')
  return value.trim()
}

function cleanBaseUrl(value: unknown): string {
  const baseUrl = field(value, 2048)
  if (baseUrl) {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new AgentProfileError('invalid_agent_profile_url')
    }
    // Credentials belong in the secret field; URLs are shown in the list.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
      throw new AgentProfileError('invalid_agent_profile_url')
  }
  return baseUrl.replace(/\/+$/, '')
}

export function cleanProfileConnection(input: Pick<AgentProfileRequest, 'baseUrl' | 'apiKey'>) {
  return {
    baseUrl: cleanBaseUrl(input?.baseUrl),
    apiKey: field(input?.apiKey, 2000),
  }
}

export function cleanProfile(
  input: AgentProfileRequest,
): Pick<StoredAgentProfile, 'name' | 'baseUrl' | 'apiKey' | 'model' | 'models' | 'modelContextWindows'> {
  const name = field(input?.name, 100)
  if (!name) throw new AgentProfileError('invalid_agent_profile_name')
  const connection = cleanProfileConnection(input)
  const models = input.models ?? []
  if (
    !Array.isArray(models) ||
    models.length > 100 ||
    models.some(
      (value) =>
        typeof value !== 'string' ||
        value.length > 200 ||
        !value.trim() ||
        [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    )
  )
    throw new AgentProfileError('invalid_agent_profile_value')
  const contextWindows = input.modelContextWindows ?? {}
  if (
    !contextWindows ||
    typeof contextWindows !== 'object' ||
    Array.isArray(contextWindows) ||
    Object.keys(contextWindows).length > 100 ||
    Object.entries(contextWindows).some(
      ([key, value]) =>
        !key.trim() || key.length > 200 || !Number.isSafeInteger(value) || value <= 0 || value > 10_000_000,
    )
  )
    throw new AgentProfileError('invalid_agent_profile_value')
  return {
    name,
    ...connection,
    model: field(input?.model, 200),
    models: [...new Set(models.map((value) => value.trim()))],
    modelContextWindows: Object.fromEntries(Object.entries(contextWindows)),
  }
}

/** Profiles belong to a runner, never to the Hub or the browser's storage. */
export class AgentProfileStore {
  readonly #file: string
  #data: ProfileFile
  #busy = false
  #hooks: ProfileHooks

  constructor(stateDir: string, hooks: ProfileHooks = {}) {
    this.#file = path.join(stateDir, 'agent-profiles.json')
    this.#hooks = hooks
    this.#data = this.#read()
  }

  current(agent: AgentProfileId): StoredAgentProfile | undefined {
    const profile = this.#data.profiles[agent].find((item) => item.id === this.#data.active[agent])
    return profile ? { ...profile } : undefined
  }

  get antigravityApiKey(): string {
    return this.current('antigravity')?.apiKey ?? ''
  }

  get antigravityBaseUrl(): string {
    return this.current('antigravity')?.baseUrl ?? ''
  }

  async setAntigravityConnection(input: AntigravityConnectionRequest): Promise<void> {
    if (input?.apiKey === undefined && input?.baseUrl === undefined)
      throw new AgentProfileError('invalid_antigravity_api_key')
    const key = input.apiKey === null ? '' : field(input.apiKey ?? this.antigravityApiKey, 2000)
    if (input.apiKey !== null && !key) throw new AgentProfileError('invalid_antigravity_api_key')
    const baseUrl =
      input.apiKey === null ? '' : cleanBaseUrl(input.baseUrl === undefined ? this.antigravityBaseUrl : input.baseUrl)
    if (key === this.antigravityApiKey && baseUrl === this.antigravityBaseUrl) return
    const next = structuredClone(this.#data)
    const current = next.profiles.antigravity.find((item) => item.id === next.active.antigravity)
    if (!key) {
      next.active.antigravity = null
      next.profiles.antigravity = next.profiles.antigravity.filter((item) => item.id !== current?.id)
    } else if (current) {
      Object.assign(current, { apiKey: key, baseUrl, updatedAt: Date.now() })
    } else {
      if (next.profiles.antigravity.length >= 100) throw new AgentProfileError('agent_profile_limit', 409)
      const id = `profile-${crypto.randomBytes(8).toString('hex')}`
      next.profiles.antigravity.push({
        id,
        ...cleanProfile({ name: 'Gemini API', apiKey: key, baseUrl }),
        updatedAt: Date.now(),
      })
      next.active.antigravity = id
    }
    await this.#commit('antigravity', next)
  }

  get(agent: AgentProfileId, id: string): StoredAgentProfile | undefined {
    const profile = this.#data.profiles[agent].find((item) => item.id === id)
    return profile
      ? { ...profile, models: [...profile.models], modelContextWindows: { ...(profile.modelContextWindows ?? {}) } }
      : undefined
  }

  response(): AgentProfilesResponse {
    const data = Object.fromEntries(
      PROFILE_IDS.map((agent) => [
        agent,
        this.#data.profiles[agent].map((profile) => ({
          id: profile.id,
          name: profile.name,
          baseUrl: profile.baseUrl || null,
          model: profile.model || null,
          models: [...profile.models],
          ...(Object.keys(profile.modelContextWindows ?? {}).length
            ? { modelContextWindows: { ...(profile.modelContextWindows ?? {}) } }
            : {}),
          hasApiKey: Boolean(profile.apiKey),
          active: this.#data.active[agent] === profile.id,
          updatedAt: profile.updatedAt,
        })),
      ]),
    ) as AgentProfilesResponse['data']
    return { data, active: { ...this.#data.active } }
  }

  nativeName(agent: AgentRuntimeId): string | undefined {
    return this.#data.nativeNames[agent]
  }

  async renameNative(agent: AgentRuntimeId, name: string): Promise<void> {
    const cleaned = field(name, 100)
    if (!cleaned) throw new AgentProfileError('invalid_agent_profile_name')
    if (this.#busy) throw new AgentProfileError('agent_profile_busy', 409)
    const next = structuredClone(this.#data)
    next.nativeNames[agent] = cleaned
    this.#persist(next)
    this.#data = next
  }

  async create(agent: AgentProfileId, input: AgentProfileRequest): Promise<void> {
    const next = structuredClone(this.#data)
    if (next.profiles[agent].length >= 100) throw new AgentProfileError('agent_profile_limit', 409)
    next.profiles[agent].push({
      id: `profile-${crypto.randomBytes(8).toString('hex')}`,
      ...cleanProfile(input),
      updatedAt: Date.now(),
    })
    await this.#commit(agent, next)
  }

  async update(agent: AgentProfileId, id: string, input: Partial<AgentProfileRequest>): Promise<void> {
    const next = structuredClone(this.#data)
    const profile = next.profiles[agent].find((item) => item.id === id)
    if (!profile) throw new AgentProfileError('agent_profile_not_found', 404)
    // Omitted key preserves the saved secret; an explicit empty string clears it.
    const fields = cleanProfile({ ...profile, ...input })
    Object.assign(profile, fields, { updatedAt: Date.now() })
    await this.#commit(agent, next)
  }

  async remove(agent: AgentProfileId, id: string): Promise<void> {
    const next = structuredClone(this.#data)
    if (!next.profiles[agent].some((item) => item.id === id))
      throw new AgentProfileError('agent_profile_not_found', 404)
    if (next.active[agent] === id) throw new AgentProfileError('agent_profile_active', 409)
    next.profiles[agent] = next.profiles[agent].filter((item) => item.id !== id)
    await this.#commit(agent, next)
  }

  async activate(agent: AgentProfileId, id: string | null): Promise<void> {
    const next = structuredClone(this.#data)
    if (id !== null && !next.profiles[agent].some((item) => item.id === id))
      throw new AgentProfileError('agent_profile_not_found', 404)
    next.active[agent] = id
    await this.#commit(agent, next)
  }

  /** Share the mutation lock with file edits so a profile switch cannot race a restart. */
  async editNative(agent: AgentRuntimeId, write: () => () => void, managed = true): Promise<void> {
    if (this.#busy) throw new AgentProfileError('agent_profile_busy', 409)
    this.#busy = true
    const apply = managed && this.#data.active[agent] === null
    try {
      if (apply) await this.#hooks.beforeApply?.(agent)
      const undo = write()
      if (apply) {
        try {
          await this.#hooks.apply?.(agent)
        } catch {
          undo()
          try {
            await this.#hooks.apply?.(agent)
          } catch {
            throw new AgentProfileError('agent_profile_restore_failed', 503)
          }
          throw new AgentProfileError('agent_profile_apply_failed', 503)
        }
      }
    } finally {
      this.#busy = false
    }
  }

  #commit(agent: AgentProfileId, next: ProfileFile): Promise<void> {
    const profile = next.profiles[agent].find((item) => item.id === next.active[agent])
    const current = this.current(agent)
    // ACP binds the gateway credentials and model catalogue when it authenticates.
    const changed =
      agent === 'antigravity'
        ? current?.id !== profile?.id ||
          current?.baseUrl !== profile?.baseUrl ||
          current?.apiKey !== profile?.apiKey ||
          current?.model !== profile?.model ||
          JSON.stringify(current?.models) !== JSON.stringify(profile?.models) ||
          JSON.stringify(current?.modelContextWindows) !== JSON.stringify(profile?.modelContextWindows)
        : JSON.stringify(current) !== JSON.stringify(profile)
    return this.#save(next, changed ? { agent, profile } : undefined)
  }

  async #save(next: ProfileFile, change?: { agent: AgentProfileId; profile?: StoredAgentProfile }): Promise<void> {
    if (this.#busy) throw new AgentProfileError('agent_profile_busy', 409)
    this.#busy = true
    const previous = this.#data
    try {
      if (change) {
        const { agent, profile } = change
        if (agent === 'opencode' && profile && (!profile.baseUrl || !profile.model))
          throw new AgentProfileError('agent_profile_opencode_required')
        if (agent === 'antigravity' && profile && !profile.apiKey)
          throw new AgentProfileError('invalid_antigravity_api_key')
        await this.#hooks.beforeApply?.(agent, profile ? { ...profile } : undefined)
      }
      this.#persist(next)
      this.#data = next
      if (change) {
        try {
          await this.#hooks.apply?.(change.agent)
        } catch {
          // Never report a failed restart as an enabled profile. Restore the
          // durable selection and try to bring the previous service back.
          this.#persist(previous)
          this.#data = previous
          try {
            await this.#hooks.apply?.(change.agent)
          } catch {
            throw new AgentProfileError('agent_profile_restore_failed', 503)
          }
          throw new AgentProfileError('agent_profile_apply_failed', 503)
        }
      }
    } finally {
      this.#busy = false
    }
  }

  #read(): ProfileFile {
    let raw: string
    try {
      raw = fs.readFileSync(this.#file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
      throw new AgentProfileError('agent_profile_store_unreadable', 500)
    }
    try {
      const value = JSON.parse(raw) as ProfileFile & { antigravityApiKey?: string; antigravityBaseUrl?: string }
      if (value.version !== 1) throw new Error('version')
      const result = emptyFile()
      for (const agent of PROFILE_IDS) {
        const rows = value.profiles[agent]
        if (agent === 'antigravity' && rows === undefined && value.active[agent] === undefined) {
          const apiKey = field(value.antigravityApiKey, 2000)
          if (apiKey) {
            const id = 'profile-0000000000000000'
            result.profiles[agent].push({
              id,
              ...cleanProfile({ name: 'Gemini API', apiKey, baseUrl: value.antigravityBaseUrl }),
              updatedAt: 0,
            })
            result.active[agent] = id
          }
          continue
        }
        if (!Array.isArray(rows) || rows.length > 100) throw new Error('profiles')
        const ids = new Set<string>()
        result.profiles[agent] = rows.map((item) => {
          if (!/^profile-[a-f0-9]{16}$/.test(item.id) || ids.has(item.id) || !Number.isFinite(item.updatedAt))
            throw new Error('profile')
          ids.add(item.id)
          return {
            id: item.id,
            ...cleanProfile({
              ...item,
              models: item.models ?? [],
              modelContextWindows: item.modelContextWindows ?? {},
            }),
            updatedAt: item.updatedAt,
          }
        })
        const selected = value.active[agent]
        if (selected !== null && !ids.has(selected)) throw new Error('active')
        result.active[agent] = selected
      }
      if (value.nativeNames && typeof value.nativeNames === 'object' && !Array.isArray(value.nativeNames)) {
        for (const agent of AGENT_IDS) {
          const name = value.nativeNames[agent]
          if (name !== undefined) result.nativeNames[agent] = field(name, 100)
        }
      }
      return result
    } catch {
      throw new AgentProfileError('agent_profile_store_invalid', 500)
    }
  }

  #persist(data: ProfileFile): void {
    const temp = `${this.#file}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, this.#file)
    } catch {
      throw new AgentProfileError('agent_profile_store_unwritable', 500)
    } finally {
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        /* Preserve the write error. */
      }
    }
  }
}
