import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentProfileRequest, AgentRuntimeId, AgentProfilesResponse } from '@vibemobile/protocol'
import { AGENT_IDS } from './manifest.js'

export interface StoredAgentProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  models: string[]
  updatedAt: number
}

interface ProfileFile {
  version: 1
  active: Record<AgentRuntimeId, string | null>
  profiles: Record<AgentRuntimeId, StoredAgentProfile[]>
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

interface ProfileHooks {
  beforeApply?: (agent: AgentRuntimeId, profile?: StoredAgentProfile) => void | Promise<void>
  apply?: (agent: AgentRuntimeId) => void | Promise<void>
}

function emptyFile(): ProfileFile {
  return {
    version: 1,
    active: { codex: null, claude: null, opencode: null },
    profiles: { codex: [], claude: [], opencode: [] },
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

export function cleanProfile(
  input: AgentProfileRequest,
): Pick<StoredAgentProfile, 'name' | 'baseUrl' | 'apiKey' | 'model' | 'models'> {
  const name = field(input?.name, 100)
  if (!name) throw new AgentProfileError('invalid_agent_profile_name')
  const baseUrl = field(input?.baseUrl, 2048)
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
  return {
    name,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: field(input?.apiKey, 2000),
    model: field(input?.model, 200),
    models: [...new Set(models.map((value) => value.trim()))],
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

  current(agent: AgentRuntimeId): StoredAgentProfile | undefined {
    const profile = this.#data.profiles[agent].find((item) => item.id === this.#data.active[agent])
    return profile ? { ...profile } : undefined
  }

  response(): AgentProfilesResponse {
    const data = Object.fromEntries(
      AGENT_IDS.map((agent) => [
        agent,
        this.#data.profiles[agent].map((profile) => ({
          id: profile.id,
          name: profile.name,
          baseUrl: profile.baseUrl || null,
          model: profile.model || null,
          models: [...profile.models],
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

  async create(agent: AgentRuntimeId, input: AgentProfileRequest): Promise<void> {
    const next = structuredClone(this.#data)
    if (next.profiles[agent].length >= 100) throw new AgentProfileError('agent_profile_limit', 409)
    next.profiles[agent].push({
      id: `profile-${crypto.randomBytes(8).toString('hex')}`,
      ...cleanProfile(input),
      updatedAt: Date.now(),
    })
    await this.#commit(agent, next)
  }

  async update(agent: AgentRuntimeId, id: string, input: Partial<AgentProfileRequest>): Promise<void> {
    const next = structuredClone(this.#data)
    const profile = next.profiles[agent].find((item) => item.id === id)
    if (!profile) throw new AgentProfileError('agent_profile_not_found', 404)
    // Omitted key preserves the saved secret; an explicit empty string clears it.
    const fields = cleanProfile({ ...profile, ...input })
    Object.assign(profile, fields, { updatedAt: Date.now() })
    await this.#commit(agent, next)
  }

  async remove(agent: AgentRuntimeId, id: string): Promise<void> {
    const next = structuredClone(this.#data)
    if (!next.profiles[agent].some((item) => item.id === id))
      throw new AgentProfileError('agent_profile_not_found', 404)
    if (next.active[agent] === id) throw new AgentProfileError('agent_profile_active', 409)
    next.profiles[agent] = next.profiles[agent].filter((item) => item.id !== id)
    await this.#commit(agent, next)
  }

  async activate(agent: AgentRuntimeId, id: string | null): Promise<void> {
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

  async #commit(agent: AgentRuntimeId, next: ProfileFile): Promise<void> {
    if (this.#busy) throw new AgentProfileError('agent_profile_busy', 409)
    this.#busy = true
    const previous = this.#data
    const active = (file: ProfileFile) => file.profiles[agent].find((item) => item.id === file.active[agent])
    const changed = JSON.stringify(active(previous)) !== JSON.stringify(active(next))
    try {
      const connection = active(next)
      if (changed && agent === 'opencode' && connection && (!connection.baseUrl || !connection.model))
        throw new AgentProfileError('agent_profile_opencode_required')
      if (changed) await this.#hooks.beforeApply?.(agent, connection ? { ...connection } : undefined)
      this.#persist(next)
      this.#data = next
      if (changed) {
        try {
          await this.#hooks.apply?.(agent)
        } catch {
          // Never report a failed restart as an enabled profile. Restore the
          // durable selection and try to bring the previous service back.
          this.#persist(previous)
          this.#data = previous
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

  #read(): ProfileFile {
    let raw: string
    try {
      raw = fs.readFileSync(this.#file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
      throw new AgentProfileError('agent_profile_store_unreadable', 500)
    }
    try {
      const value = JSON.parse(raw) as ProfileFile
      if (value.version !== 1) throw new Error('version')
      const result = emptyFile()
      for (const agent of AGENT_IDS) {
        const rows = value.profiles[agent]
        if (!Array.isArray(rows) || rows.length > 100) throw new Error('profiles')
        const ids = new Set<string>()
        result.profiles[agent] = rows.map((item) => {
          if (!/^profile-[a-f0-9]{16}$/.test(item.id) || ids.has(item.id) || !Number.isFinite(item.updatedAt))
            throw new Error('profile')
          ids.add(item.id)
          return { id: item.id, ...cleanProfile({ ...item, models: item.models ?? [] }), updatedAt: item.updatedAt }
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
