import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import { CodexGlobalStore, codexGlobalFailure } from '../agents/codexGlobal.js'
import { requireAuth } from './guards.js'

export function registerCodexGlobalRoutes(app: FastifyInstance, config: Config, store = new CodexGlobalStore()): void {
  const auth = { preHandler: requireAuth(config) }
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/codex/global')) reply.header('Cache-Control', 'no-store')
  })
  app.get('/api/codex/global', auth, async (_req, reply) => {
    try {
      return await store.catalog()
    } catch (error) {
      const failure = codexGlobalFailure(error)
      return reply.code(failure.status).send({ error: failure.code })
    }
  })
  app.get<{ Querystring: { id?: string } }>('/api/codex/global/document', auth, async (req, reply) => {
    try {
      return store.read(req.query.id ?? '')
    } catch (error) {
      const failure = codexGlobalFailure(error)
      return reply.code(failure.status).send({ error: failure.code })
    }
  })
  app.put<{ Body: { id?: string; text?: string; revision?: string } }>(
    '/api/codex/global/document',
    {
      ...auth,
      bodyLimit: 4 * 1024 * 1024,
    },
    async (req, reply) => {
      try {
        return store.save(req.body?.id ?? '', req.body?.text as string, req.body?.revision ?? '')
      } catch (error) {
        const failure = codexGlobalFailure(error)
        return reply.code(failure.status).send({ error: failure.code })
      }
    },
  )
  app.post<{ Body: { name?: string; text?: string } }>(
    '/api/codex/global/skills',
    {
      ...auth,
      bodyLimit: 4 * 1024 * 1024,
    },
    async (req, reply) => {
      try {
        return reply.code(201).send(store.createSkill(req.body?.name ?? '', req.body?.text as string))
      } catch (error) {
        const failure = codexGlobalFailure(error)
        return reply.code(failure.status).send({ error: failure.code })
      }
    },
  )
}
