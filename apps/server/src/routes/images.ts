/**
 * Serves the pictures a user sent, addressed by the tokens carried on their
 * transcript messages (`AgentItem` of kind `message`).
 *
 * The only route in this server that returns something other than JSON. It
 * exists because the alternative — inlining data URLs in the transcript — costs
 * the full image bytes again on every reconnect, which is exactly the mobile
 * case this app is for. A content-addressed token can be cached forever by the
 * browser instead, so a reconnect re-fetches the transcript and none of its
 * pictures.
 *
 * Auth is byte-identical to every other route (`requireAuth`), and under
 * `VIBEMOBILE_NO_AUTH` it is skipped like the rest. That matters more here than
 * elsewhere only because a browser is the client: the token is unguessable, but
 * it is not a secret and is not treated as one.
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { ImageStore } from '../images/store.js'
import { requireAuth } from './guards.js'

export function registerImageRoutes(app: FastifyInstance, config: Config): void {
  const auth = { preHandler: requireAuth(config) }
  const store = new ImageStore(path.join(config.stateDir, 'images'), (line) => app.log.warn(`[images] ${line}`))

  app.get<{ Params: { id: string } }>('/api/images/:id', auth, async (req, reply) => {
    const found = store.get(req.params.id)
    if (!found) {
      // `no-store` on the miss, not just on the hit. Without it the browser
      // caches the 404 against an immutable-looking URL and the picture can
      // never come back — which it otherwise would, since the next read of the
      // transcript re-stores it. Silent and permanent is the worst pairing.
      reply.header('Cache-Control', 'no-store')
      return reply.code(404).send({ error: 'image not found' })
    }

    let body: Buffer
    try {
      body = fs.readFileSync(found.path)
    } catch {
      // Raced with a directory wipe between the stat and the read. Same answer
      // as a miss, and deliberately not logged: this is a cache being rebuilt.
      reply.header('Cache-Control', 'no-store')
      return reply.code(404).send({ error: 'image not found' })
    }

    // Safe to cache for a year because the token IS the hash of these bytes:
    // different content is a different URL. `private` keeps it out of shared
    // proxies for an authenticated single-user app.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable')
    // Content-Type comes from the token's extension, never from anything the
    // client sent. `nosniff` stops a browser from second-guessing it.
    reply.header('X-Content-Type-Options', 'nosniff')
    return reply.type(found.mime).send(body)
  })
}
