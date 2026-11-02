import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { UpdateStatus } from '@vibemobile/protocol'
import type { Config } from '../config.js'
import { requireAuth } from './guards.js'
import { createUpdateService, UpdateError } from '../system/updateService.js'

/**
 * App update status and trigger.
 *
 * Mounted on the execution service and on the Hub itself. The web client calls
 * the path without a runner prefix on the Hub root and through `/r/<id>/` on a
 * runner, so the URL scope decides which process is updated.
 */
export function registerSystemRoutes(app: FastifyInstance, config: Config): void {
  const service = createUpdateService(config)
  const auth = { preHandler: requireAuth(config) }

  app.get('/api/system/update', auth, async (_req, reply): Promise<UpdateStatus> => {
    reply.header('cache-control', 'no-store')
    return service.status(false)
  })

  app.post('/api/system/update/check', auth, async (_req, reply): Promise<UpdateStatus> => {
    reply.header('cache-control', 'no-store')
    return service.status(true)
  })

  app.post('/api/system/update', auth, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    if (!sameOrigin(req)) return reply.code(403).send({ error: 'origin_not_allowed' })
    try {
      const job = await service.start()
      return reply.code(202).send({ job })
    } catch (error) {
      if (error instanceof UpdateError) return reply.code(error.status).send({ error: error.code })
      app.log.error({ err: error }, 'app update failed to start')
      return reply.code(500).send({ error: 'update_start_failed' })
    }
  })

  service.cleanup()
}

/**
 * A browser always sends `Origin` on a cross-site POST. Requests from the
 * runner bridge carry none, and those are already authenticated by the service
 * token, so an empty Origin is accepted.
 */
function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  const allowed = new Set<string>()
  if (req.headers.host) allowed.add(`${req.protocol}://${req.headers.host}`)
  for (const item of (process.env.VIBEMOBILE_PUBLIC_ORIGIN ?? '').split(',')) {
    const trimmed = item.trim()
    if (trimmed) allowed.add(trimmed)
  }
  return allowed.has(origin)
}
