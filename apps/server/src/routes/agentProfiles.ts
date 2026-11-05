import type { FastifyInstance } from 'fastify'
import type { AgentProfileRequest, AgentProfilesResponse, AgentRuntimeId, ModelInfo } from '@vibemobile/protocol'
import type { Config } from '../config.js'
import { AgentProfileError, type AgentProfileStore } from '../agents/profiles.js'
import { isAgentRuntimeId } from '../agents/manifest.js'
import { requireAuth } from './guards.js'
import type { NativeAgentConfigStore } from '../agents/nativeConfig.js'
import { AGENT_IDS } from '../agents/manifest.js'

export function registerAgentProfileRoutes(
  app: FastifyInstance,
  config: Config,
  store: AgentProfileStore,
  limitations: () => AgentProfilesResponse['limitations'] = () => ({}),
  nativeStore?: NativeAgentConfigStore,
): void {
  const auth = { preHandler: requireAuth(config) }
  const response = (): AgentProfilesResponse => {
    const result = { ...store.response(), limitations: limitations() }
    return nativeStore
      ? {
          ...result,
          native: Object.fromEntries(
            AGENT_IDS.map((agent) => [
              agent,
              {
                ...nativeStore.read(agent, result.active[agent] === null),
                ...(store.nativeName(agent) ? { name: store.nativeName(agent) } : {}),
              },
            ]),
          ) as NonNullable<AgentProfilesResponse['native']>,
        }
      : result
  }
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/agent-profiles')) reply.header('cache-control', 'no-store')
  })
  // Only stable codes reach the browser. Restart errors may contain credentials.
  const run = async (work: () => Promise<void>) => {
    await work()
    return response()
  }

  app.get('/api/agent-profiles', auth, response)
  app.get<{ Params: { agent: string; id: string } }>(
    '/api/agent-profiles/:agent/:id/models',
    auth,
    async (req, reply) => {
      const agent = req.params.agent
      if (!isAgentRuntimeId(agent)) return reply.code(404).send({ error: 'unknown_agent' })
      if (req.params.id === 'native') return reply.code(400).send({ error: 'agent_profile_models_unavailable' })
      const profile = store.get(agent, req.params.id)
      if (!profile) return reply.code(404).send({ error: 'agent_profile_not_found' })
      try {
        return { data: await fetchProfileModels(agent, profile) }
      } catch (err) {
        return failure(err, reply)
      }
    },
  )
  app.post<{ Params: { agent: string }; Body: { baseUrl?: string; apiKey?: string } }>(
    '/api/agent-profiles/:agent/models',
    auth,
    async (req, reply) => {
      const agent = req.params.agent
      if (!isAgentRuntimeId(agent)) return reply.code(404).send({ error: 'unknown_agent' })
      const baseUrl = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim().replace(/\/+$/, '') : ''
      const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : ''
      try {
        const url = new URL(baseUrl)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
          throw new AgentProfileError('invalid_agent_profile_url')
        return { data: await fetchProfileModels(agent, { baseUrl, apiKey }) }
      } catch (err) {
        return failure(err, reply)
      }
    },
  )
  app.post<{ Params: { agent: string }; Body: AgentProfileRequest }>(
    '/api/agent-profiles/:agent',
    auth,
    async (req, reply) => {
      const agent = req.params.agent
      if (!isAgentRuntimeId(agent)) return reply.code(404).send({ error: 'unknown_agent' })
      try {
        const result = await run(() => store.create(agent, req.body))
        return reply.code(201).send(result)
      } catch (err) {
        return failure(err, reply)
      }
    },
  )
  app.patch<{ Params: { agent: string; id: string }; Body: Partial<AgentProfileRequest> }>(
    '/api/agent-profiles/:agent/:id',
    auth,
    async (req, reply) => {
      const agent = req.params.agent
      if (!isAgentRuntimeId(agent)) return reply.code(404).send({ error: 'unknown_agent' })
      try {
        if (req.params.id === 'native') {
          if (!nativeStore) return reply.code(404).send({ error: 'agent_profile_not_found' })
          return await run(async () => {
            const { name, ...nativeInput } = req.body
            await store.editNative(agent, () => nativeStore.update(agent, nativeInput), !limitations()?.[agent])
            if (name !== undefined) await store.renameNative(agent, name)
          })
        }
        return await run(() => store.update(agent, req.params.id, req.body))
      } catch (err) {
        return failure(err, reply)
      }
    },
  )
  app.post<{ Params: { agent: string; id: string } }>(
    '/api/agent-profiles/:agent/:id/activate',
    auth,
    async (req, reply) => {
      const agent = req.params.agent
      if (!isAgentRuntimeId(agent)) return reply.code(404).send({ error: 'unknown_agent' })
      try {
        return await run(() => store.activate(agent, req.params.id === 'native' ? null : req.params.id))
      } catch (err) {
        return failure(err, reply)
      }
    },
  )
  app.delete<{ Params: { agent: string; id: string } }>('/api/agent-profiles/:agent/:id', auth, async (req, reply) => {
    const agent = req.params.agent
    if (!isAgentRuntimeId(agent)) return reply.code(404).send({ error: 'unknown_agent' })
    try {
      return await run(() => store.remove(agent, req.params.id))
    } catch (err) {
      return failure(err, reply)
    }
  })
}

async function fetchProfileModels(agent: AgentRuntimeId, profile: { baseUrl: string; apiKey: string }): Promise<ModelInfo[]> {
  if (!profile.baseUrl) throw new AgentProfileError('agent_profile_models_unavailable', 502)
  const base = profile.baseUrl.replace(/\/+$/, '')
  const paths = base.endsWith('/v1') ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`]
  const headers: Record<string, string> = { accept: 'application/json' }
  if (profile.apiKey) {
    headers.authorization = `Bearer ${profile.apiKey}`
    if (agent === 'claude') {
      headers['x-api-key'] = profile.apiKey
      headers['anthropic-version'] = '2023-06-01'
    }
  }
  let lastStatus = 0
  for (const url of paths) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const res = await fetch(url, { headers, signal: controller.signal })
      lastStatus = res.status
      if (res.status === 404 || res.status === 405) continue
      if (!res.ok) throw new AgentProfileError('agent_profile_models_unavailable', 502)
      const payload: unknown = await res.json()
      return normalizeModels(payload)
    } catch (err) {
      if (err instanceof AgentProfileError) throw err
      if ((err as Error)?.name === 'AbortError') throw new AgentProfileError('agent_profile_models_timeout', 504)
      throw new AgentProfileError('agent_profile_models_unavailable', 502)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new AgentProfileError(lastStatus ? 'agent_profile_models_unavailable' : 'agent_profile_models_timeout', 502)
}

function normalizeModels(payload: unknown): ModelInfo[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (payload as { data?: unknown; models?: unknown }).data ?? (payload as { models?: unknown }).models
      : []
  if (!Array.isArray(rows)) throw new AgentProfileError('agent_profile_models_unavailable', 502)
  const seen = new Set<string>()
  return rows.flatMap((row): ModelInfo[] => {
    const value = typeof row === 'string' ? row : row && typeof row === 'object' ? row : null
    const id = typeof value === 'string' ? value : String((value as any)?.id ?? (value as any)?.model ?? (value as any)?.slug ?? '').trim()
    if (!id || seen.has(id)) return []
    seen.add(id)
    const displayName = typeof value === 'string' ? id : String((value as any)?.displayName ?? (value as any)?.name ?? id).trim() || id
    const contextWindow = typeof value === 'string' ? undefined : contextWindowOf(value as Record<string, unknown>)
    return [{ id, displayName, ...(contextWindow ? { contextWindow } : {}) }]
  })
}

/** Providers use several names for the same model limit. Keep the wire DTO stable. */
function contextWindowOf(value: Record<string, unknown>): number | undefined {
  const nested = value.limits && typeof value.limits === 'object' ? (value.limits as Record<string, unknown>) : undefined
  const candidates = [
    value.contextWindow,
    value.context_window,
    value.context_length,
    value.max_context_length,
    value.maxContextLength,
    nested?.context,
    nested?.contextWindow,
    nested?.context_length,
  ]
  const result = candidates.find((candidate) => typeof candidate === 'number' || (typeof candidate === 'string' && /^\d+$/.test(candidate)))
  const number = typeof result === 'string' ? Number(result) : result
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number <= 10_000_000 ? number : undefined
}

function failure(error: unknown, reply: import('fastify').FastifyReply) {
  if (error instanceof AgentProfileError) return reply.code(error.statusCode).send({ error: error.code })
  return reply.code(500).send({ error: 'agent_profile_failed' })
}
