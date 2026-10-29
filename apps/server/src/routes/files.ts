import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import { requireAuth } from './guards.js'
import { gitDiff, listDirectory, readFileText, writeFileText, WorkspaceError } from '../files/workspace.js'

/**
 * How much JSON a save may be.
 *
 * Fastify's default is 1 MiB, and it applies before the handler runs — so a
 * 512 KB file, which is what `MAX_FILE_BYTES` allows, is refused with a 413
 * from the framework the moment its text is JSON-escaped (newline-dense files
 * roughly double), and it looks exactly like a client bug.
 */
const SAVE_BODY_LIMIT = 2 * 1024 * 1024

export function registerFileRoutes(app: FastifyInstance, config: Config): void {
  const auth = { preHandler: requireAuth(config) }

  const wrap = async <T>(fn: () => Promise<T>, reply: any): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof WorkspaceError) {
        reply.code(err.status).send(err.code ? { error: err.message, code: err.code } : { error: err.message })
        return undefined
      }
      throw err
    }
  }

  app.get<{ Querystring: { path?: string; hidden?: string } }>('/api/files', auth, async (req, reply) => {
    const result = await wrap(
      () =>
        listDirectory(config.workspaceRoots, req.query.path ?? config.workspaceRoots[0]!, {
          showHidden: req.query.hidden === 'true',
        }),
      reply,
    )
    return result === undefined ? undefined : { data: result }
  })

  app.get<{ Querystring: { path: string } }>('/api/files/content', auth, async (req, reply) => {
    if (!req.query.path) return reply.code(400).send({ error: 'path is required' })
    const result = await wrap(() => readFileText(config.workspaceRoots, req.query.path), reply)
    return result
  })

  /**
   * Save a file. `PUT`, not `PATCH`: the body is the file's whole new content,
   * and a reader of the route table should be able to see that.
   *
   * Returns the file as it now is on disk — text, bytes and a fresh `rev` — so
   * the client can rebase without a second round trip. That is not a
   * convenience: the server restores the file's line endings, so what came back
   * is not byte-identical to what was sent, and the client has to be told.
   */
  app.put<{ Body: { path?: string; text?: string; rev?: string } }>(
    '/api/files/content',
    { ...auth, bodyLimit: SAVE_BODY_LIMIT },
    async (req, reply) => {
      const { path: filePath, text, rev } = req.body ?? {}
      if (!filePath) return reply.code(400).send({ error: 'path is required' })
      // `typeof`, not truthiness: an empty string is a legitimate save — it is
      // how a file is cleared.
      if (typeof text !== 'string') return reply.code(400).send({ error: 'text is required' })
      const result = await wrap(
        () => writeFileText(config.workspaceRoots, { path: filePath, text, ...(rev ? { rev } : {}) }),
        reply,
      )
      return result
    },
  )

  app.get<{ Querystring: { root?: string; path?: string } }>('/api/files/diff', auth, async (req, reply) => {
    const root = req.query.root ?? config.workspaceRoots[0]!
    const result = await wrap(() => gitDiff(config.workspaceRoots, root, req.query.path), reply)
    return result === undefined ? undefined : { diff: result }
  })
}
