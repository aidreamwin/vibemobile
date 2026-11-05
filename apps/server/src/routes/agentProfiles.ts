import type { FastifyInstance } from 'fastify'
import type { AgentProfileRequest, AgentProfilesResponse } from '@vibemobile/protocol'
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
            AGENT_IDS.map((agent) => [agent, nativeStore.read(agent, result.active[agent] === null)]),
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
          return await run(() =>
            store.editNative(agent, () => nativeStore.update(agent, req.body), !limitations()?.[agent]),
          )
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

function failure(error: unknown, reply: import('fastify').FastifyReply) {
  if (error instanceof AgentProfileError) return reply.code(error.statusCode).send({ error: error.code })
  return reply.code(500).send({ error: 'agent_profile_failed' })
}
