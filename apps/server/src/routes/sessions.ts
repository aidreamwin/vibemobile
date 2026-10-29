import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ApprovalPolicy, SandboxMode, SessionSummary } from '@vibemobile/protocol'
import type { Config } from '../config.js'
import { registry } from '../providers/registry.js'
import { probeCache } from '../providers/probeCache.js'
import { SessionInUseError, SessionNotFoundError } from '../providers/types.js'
import { requireAuth } from './guards.js'
import { resolveDirectory, WorkspaceError } from '../files/workspace.js'

/**
 * The sentinel `?provider=` value meaning "every provider, merged".
 *
 * Deliberately not in @vibemobile/protocol: that package is types-only (the
 * server imports nothing from it at runtime, which is what keeps `rootDir: src`
 * building), and a shared runtime constant would break that.
 */
const ALL_PROVIDERS = 'all'

/**
 * How much of a `?search=` is looked at.
 *
 * A session title is extracted from a prompt, so it is short; anything past
 * this is not a search, it is a paste. Truncating rather than rejecting keeps a
 * long paste from becoming an error the user cannot see the cause of, and the
 * only thing it can cost is missing a session whose entire title happens to sit
 * beyond the cut. Length only — the value itself is passed through untouched to
 * a provider, which decides what matching means.
 */
const MAX_SEARCH_LENGTH = 200

/**
 * Answer 404 when the provider turns out not to have the session, and rethrow
 * anything else.
 *
 * Only the routes whose provider reports an unknown id by throwing need this:
 * `GET /api/sessions/:id` and `POST /open` get `null` instead and already have
 * a 404 branch of their own. Without it a request for a session that no longer
 * exists — a Codex thread whose app-server has since restarted, most often —
 * came back as a 500 carrying the app-server's own wording ("no rollout found
 * for thread id …"), which reads as a server fault rather than "it is gone".
 */
function notFoundOr(err: unknown, reply: FastifyReply) {
  if (err instanceof SessionNotFoundError) {
    return reply.code(404).send({ error: 'session not found' })
  }
  throw err
}

export function registerSessionRoutes(app: FastifyInstance, config: Config): void {
  const auth = { preHandler: requireAuth(config) }

  // ------------------------------------------------------------ providers

  app.get('/api/providers', auth, async () => {
    // Through the cache, because probing is not a status read: Claude's spawns
    // a ~230 MB native CLI binary, and Codex's can wait out the app-server's
    // 30 s readiness timeout. Un-cached, both were paid again on every visit to
    // the session list and the settings screen.
    const statuses = await probeCache.probeAll(registry.list())
    return { data: statuses, default: registry.default?.id ?? null }
  })

  app.get<{ Params: { provider: string } }>('/api/providers/:provider/models', auth, async (req) => {
    const provider = registry.require(req.params.provider)
    return { data: await provider.listModels() }
  })

  // ------------------------------------------------------------- projects

  app.get('/api/projects', auth, async (req) => {
    const provider = registry.default
    if (!provider) return { data: [] }
    const projects = await provider.listProjects()
    req.log.debug({ count: projects.length }, 'listed projects')
    return { data: projects }
  })

  // ------------------------------------------------------------- sessions

  app.get<{
    Querystring: {
      provider?: string
      cwd?: string
      limit?: string
      archived?: string
      search?: string
    }
  }>('/api/sessions', auth, async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50
    const archived = req.query.archived === 'true'
    // Passed through to the provider as-is (bar the length cut): what a search
    // matches is the backend's business, and the two differ — Codex forwards it
    // to the app-server as a title filter, Claude matches in memory. Neither
    // searches transcripts, which is why the client must not promise that.
    const search = req.query.search?.slice(0, MAX_SEARCH_LENGTH)

    // `provider=all` is the list screen's "my coding agents" view: every
    // provider, merged and sorted as one list, because a page called "my
    // sessions" that hides half of them is a bug. Merging here rather than in
    // the browser is also what lets that screen fire its request immediately:
    // fanning out client-side required naming the providers first, and naming
    // them meant waiting for /api/providers to finish probing.
    if (req.query.provider === ALL_PROVIDERS) {
      const lists = await Promise.all(
        registry.list().map((provider) =>
          provider
            .listSessions({ cwd: req.query.cwd, limit, archived, search })
            .then((data) => {
              // Where the routing index learns these sessions, exactly as the
              // single-provider path below does.
              for (const session of data) registry.bind(provider.id, session.id)
              return data
            })
            // One provider being down must not blank the whole list.
            .catch((err): SessionSummary[] => {
              req.log.warn({ err, provider: provider.id }, 'listing sessions failed')
              return []
            }),
        ),
      )
      return { data: lists.flat().sort((a, b) => b.updatedAt - a.updatedAt) }
    }

    // A named provider, or the default one — **not** every provider merged.
    // Measured: without `provider` this returns 38 Codex sessions and silently
    // omits the 33 Claude ones, which is the pre-Claude contract kept intact
    // (Codex is registered first, so `default` is still Codex). Callers that
    // want them all ask for `provider=all` explicitly.
    const provider = registry.get(req.query.provider ?? '') ?? registry.default
    if (!provider) return { data: [] }
    const data = await provider.listSessions({
      cwd: req.query.cwd,
      limit,
      archived,
      search,
    })
    // This is where the routing index gets populated for the common case: a
    // client lists sessions and then opens one by id, without ever naming the
    // provider again.
    for (const session of data) registry.bind(provider.id, session.id)
    return { data }
  })

  app.post<{
    Body: {
      provider?: string
      cwd: string
      model?: string
      sandbox?: SandboxMode
      approvalPolicy?: ApprovalPolicy
    }
  }>('/api/sessions', auth, async (req, reply) => {
    const provider = registry.get(req.body?.provider ?? '') ?? registry.default
    if (!provider) return reply.code(503).send({ error: 'no provider available' })
    if (!req.body?.cwd) return reply.code(400).send({ error: 'cwd is required' })

    let cwd: string
    try {
      cwd = await resolveDirectory(config.workspaceRoots, req.body.cwd)
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return reply.code(err.status).send({ error: err.message })
      }
      throw err
    }

    const session = await provider.createSession({
      cwd,
      model: req.body.model,
      sandbox: req.body.sandbox,
      approvalPolicy: req.body.approvalPolicy,
    })
    registry.bind(provider.id, session.id)
    return reply.code(201).send(session)
  })

  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; cursor?: string; items?: string }
  }>('/api/sessions/:id', auth, async (req, reply) => {
    const provider = await registry.forSession(req.params.id)
    if (!provider) return reply.code(503).send({ error: 'no provider available' })
    // Clamped rather than passed through: Claude's page size decides how much
    // of a possibly 200 MB JSONL the tail reader has to scan, and `limit` is
    // a query parameter a phone (or anything else) can set freely.
    const requested = Number(req.query.limit)
    // Floored as well as capped: a fractional limit would reach the app-server
    // RPC and the tail reader's prompt arithmetic as-is.
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 200) : 60
    // An approximate page size in rendered items. Turns vary by two orders
    // of magnitude, so a fixed turn count makes pages wildly uneven; the
    // provider still cuts on turn boundaries. 500 is a sanity cap, not a
    // reading limit.
    const requestedItems = Number(req.query.items)
    const targetItems =
      Number.isFinite(requestedItems) && requestedItems > 0 ? Math.min(Math.floor(requestedItems), 500) : undefined
    const transcript = await provider.getTranscript(req.params.id, {
      // 60 when the caller does not choose: a session that ran all day is
      // exactly the one worth reopening, and everything older is reachable
      // via `nextCursor` / `hasMore`. The web client asks for an item budget
      // instead, because one turn can be one card or several hundred.
      limit,
      ...(targetItems ? { targetItems } : {}),
      ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
    })
    if (!transcript) return reply.code(404).send({ error: 'session not found' })
    return transcript
  })

  app.patch<{
    Params: { id: string }
    Body: { name?: string; archived?: boolean; pinned?: boolean }
  }>('/api/sessions/:id', auth, async (req, reply) => {
    const provider = await registry.forSession(req.params.id)
    if (!provider) return reply.code(503).send({ error: 'no provider available' })
    // A pin that silently does nothing is worse than a button that is not
    // offered, so a provider without one is answered honestly instead of with
    // the `{ ok: true }` below. Both of today's implement it; this is for the
    // provider that does not exist yet. The `archiveSession` guard above keeps
    // its old shape on purpose — it predates this and is only a future-proofing
    // no-op, not a claim the pin makes.
    if (typeof req.body?.pinned === 'boolean' && !provider.pinSession) {
      return reply.code(501).send({ error: 'session_pin_not_supported' })
    }
    try {
      if (typeof req.body?.name === 'string') {
        await provider.renameSession(req.params.id, req.body.name)
      }
      if (typeof req.body?.archived === 'boolean' && provider.archiveSession) {
        await provider.archiveSession(req.params.id, req.body.archived)
      }
      if (typeof req.body?.pinned === 'boolean') {
        await provider.pinSession?.(req.params.id, req.body.pinned)
      }
    } catch (err) {
      return notFoundOr(err, reply)
    }
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', auth, async (req, reply) => {
    const provider = await registry.forSession(req.params.id)
    if (!provider) return reply.code(503).send({ error: 'no provider available' })
    try {
      await provider.deleteSession(req.params.id)
    } catch (err) {
      return notFoundOr(err, reply)
    }
    registry.forget(req.params.id)
    return { ok: true }
  })

  // Explicitly (re)open a session so the backend streams for it again.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/open', auth, async (req, reply) => {
    const provider = await registry.forSession(req.params.id)
    if (!provider) return reply.code(503).send({ error: 'no provider available' })
    try {
      const session = await provider.resumeSession(req.params.id)
      if (!session) return reply.code(404).send({ error: 'session not found' })
      return session
    } catch (err) {
      if (err instanceof SessionInUseError) {
        return reply.code(409).send({ error: err.code, message: err.message })
      }
      return notFoundOr(err, reply)
    }
  })

  app.post<{ Params: { id: string } }>('/api/sessions/:id/fork', auth, async (req, reply) => {
    const provider = await registry.forSession(req.params.id)
    if (!provider) return reply.code(503).send({ error: 'no provider available' })
    if (!provider.forkSession) {
      return reply.code(501).send({ error: 'session_fork_not_supported' })
    }
    let session: SessionSummary
    try {
      session = await provider.forkSession(req.params.id)
    } catch (err) {
      return notFoundOr(err, reply)
    }
    registry.bind(provider.id, session.id)
    return reply.code(201).send(session)
  })
}
