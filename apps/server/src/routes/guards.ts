import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import { COOKIE_NAME, verifySession } from '../auth/jwt.js'

/**
 * Rejects unauthenticated requests. Applied to every /api route except the
 * login pair, and mirrored by the WebSocket upgrade check in ws/hub.ts.
 */
export function requireAuth(config: Config) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (config.authDisabled) return
    const token = req.cookies[COOKIE_NAME]
    if (!verifySession(config, token)) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }
}
