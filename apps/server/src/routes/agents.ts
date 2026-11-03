import type { FastifyInstance } from 'fastify'
import type { AgentRuntimeId, AgentsResponse } from '@vibemobile/protocol'
import type { Config } from '../config.js'
import { agentStatuses, latestAvailableVersion, startAgentUpdate } from '../agents/installer.js'
import { isAgentRuntimeId } from '../agents/manifest.js'
import { requireAuth } from './guards.js'

/**
 * Runtime-pack management.
 *
 * The update is a background job: installing a pack is a multi-minute npm
 * download and the phone must not hold a request open for it. `POST` returns
 * 202 with the current state and the Settings page polls `GET /api/agents`.
 *
 * Only the agent id comes from the client. The version is read from the
 * manifest server-side, so this route cannot be used to install an arbitrary
 * package.
 */
/** Injectable for tests: the real one runs npm in the background. */
export type StartAgentUpdate = typeof startAgentUpdate

/**
 * What to do after a pack becomes `current`. Only long-lived children need a
 * hook; Claude picks its pack up on the next turn by itself.
 */
export type AgentRestartHooks = Partial<Record<AgentRuntimeId, () => void | Promise<void>>>

export function registerAgentRoutes(
  app: FastifyInstance,
  config: Config,
  restartHooks: AgentRestartHooks = {},
  startUpdate: StartAgentUpdate = startAgentUpdate,
): void {
  const auth = { preHandler: requireAuth(config) }

  app.get('/api/agents', auth, async (): Promise<AgentsResponse> => ({ data: agentStatuses(config) }))

  app.post<{ Params: { id: string } }>('/api/agents/:id/check', auth, async (req, reply) => {
    const id = req.params.id
    if (!isAgentRuntimeId(id)) return reply.code(404).send({ error: 'unknown_agent' })
    // `null` is a registry failure, not "up to date": the UI offers a retry.
    return { latest: await latestAvailableVersion(id) }
  })

  app.post<{ Params: { id: string } }>('/api/agents/:id/update', auth, async (req, reply) => {
    const id = req.params.id
    if (!isAgentRuntimeId(id)) return reply.code(404).send({ error: 'unknown_agent' })
    const started = startUpdate(config, id, {
      onLog: (line) => app.log.info(line),
      onInstalled: restartHooks[id],
    })
    if (!started) return reply.code(409).send({ error: 'update_running' })
    return reply.code(202).send({ data: agentStatuses(config) })
  })
}
