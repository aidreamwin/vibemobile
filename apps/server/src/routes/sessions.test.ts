/**
 * The session routes, against a stub provider.
 *
 * These are about the CONTRACT rather than about either real backend — which is
 * the point, because `routes/sessions.ts` is provider-agnostic by construction
 * and the last four changes to it (search, the archive filter, pinning, and the
 * 501 for a provider that cannot pin) are all visible here and nowhere else.
 * The two real providers are verified by scripts against a live CLI; a route
 * test that needed one would only ever run on this machine.
 *
 * The registry is a module singleton with no unregister, so each stub is
 * registered once, owns a disjoint set of session ids, and records into arrays
 * that `beforeEach` empties.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@vibemobile/protocol'
import { loadConfig } from '../config.js'
import { registry } from '../providers/registry.js'
import type { AgentProvider, ListSessionsOptions } from '../providers/types.js'
import { registerSessionRoutes } from './sessions.js'

let dir: string
let app: ReturnType<typeof Fastify>

/** What reached the provider, which is what these tests are asserting about. */
let listings: ListSessionsOptions[] = []
let transcripts: Array<{ limit?: number; cursor?: string; targetItems?: number }> = []
let pins: Array<[string, boolean]> = []
let archives: Array<[string, boolean | undefined]> = []

const row = (id: string): SessionSummary => ({
  id,
  provider: 'alpha',
  title: `session ${id}`,
  preview: '',
  cwd: '/w',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  needsAttention: false,
})

/**
 * A provider that owns every id starting with `prefix` and answers everything
 * else with `null`, which is how `registry.forSession` picks between them.
 * `canPin` off is the shape a future provider could have — the 501 exists for
 * it alone, since both of today's implement it.
 */
function stub(id: string, prefix: string, canPin: boolean): AgentProvider {
  const provider = {
    id,
    displayName: id,
    probe: async () => ({ id, displayName: id, available: true }),
    start: async () => {},
    stop: async () => {},
    subscribe: () => () => {},
    listModels: async () => [],
    listProjects: async () => [],
    listSessions: async (opts: ListSessionsOptions = {}) => {
      listings.push(opts)
      return [row(`${prefix}1`)]
    },
    getSession: async (sessionId: string) => (sessionId.startsWith(prefix) ? row(sessionId) : null),
    getTranscript: async (sessionId: string, opts: { limit?: number; cursor?: string; targetItems?: number } = {}) => {
      if (!sessionId.startsWith(prefix)) return null
      transcripts.push(opts)
      return { session: row(sessionId), turns: [] }
    },
    createSession: async () => row(`${prefix}new`),
    resumeSession: async (sessionId: string) => (sessionId.startsWith(prefix) ? row(sessionId) : null),
    renameSession: async () => {},
    deleteSession: async () => {},
    archiveSession: async (sessionId: string, archived?: boolean) => {
      archives.push([sessionId, archived])
    },
    pinSession: canPin
      ? async (sessionId: string, pinned: boolean) => {
          pins.push([sessionId, pinned])
        }
      : undefined,
    startTurn: async () => ({ turnId: 't1' }),
    steer: async () => {},
    interrupt: async () => {},
    answerApproval: async () => {},
  }
  return provider as unknown as AgentProvider
}

beforeEach(async () => {
  listings = []
  transcripts = []
  pins = []
  archives = []
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-sessions-route-'))
  const config = loadConfig({ authDisabled: true, stateDir: dir })
  app = Fastify()
  registerSessionRoutes(app, config)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// Registered once, at import time: see the note at the top. `alpha` is first, so
// it is also `registry.default` — the same accident of registration order that
// makes a bare `/api/sessions` mean "Codex only" in production.
if (!registry.get('alpha')) {
  registry.register(stub('alpha', 'a', true))
  registry.register(stub('beta', 'b', true))
  registry.register(stub('gamma', 'g', false))
}

describe('GET /api/sessions', () => {
  it('passes a search term through to the provider', async () => {
    await app.inject({ method: 'GET', url: '/api/sessions?search=refactor+auth' })
    expect(listings.at(-1)?.search).toBe('refactor auth')
  })

  it('sends no search when none was given, rather than an empty string', async () => {
    await app.inject({ method: 'GET', url: '/api/sessions' })
    // `undefined` and `''` are not the same thing to a provider: Codex forwards
    // this into the app-server's `searchTerm`, where a filter matching nothing
    // and no filter at all are opposite answers.
    expect(listings.at(-1)?.search).toBeUndefined()
  })

  it('clamps an absurd search instead of rejecting it', async () => {
    // A pasted paragraph is not a search term, and a 400 for it would be an
    // error the user cannot see the cause of. Length only.
    const long = 'x'.repeat(5000)
    const res = await app.inject({ method: 'GET', url: `/api/sessions?search=${long}` })
    expect(res.statusCode).toBe(200)
    expect(listings.at(-1)?.search).toHaveLength(200)
  })

  it('passes the search to every provider on the merged listing too', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions?provider=all&search=fix' })
    expect(res.statusCode).toBe(200)
    // One call per registered provider, all carrying the same query — the
    // `provider=all` branch is a separate code path and is the one the list
    // screen actually uses.
    for (const call of listings) expect(call.search).toBe('fix')
    expect(listings.length).toBe(registry.list().length)
    expect(JSON.parse(res.body).data).toHaveLength(registry.list().length)
  })

  it('passes the archived flag through, and defaults it to false', async () => {
    await app.inject({ method: 'GET', url: '/api/sessions' })
    expect(listings.at(-1)?.archived).toBe(false)

    await app.inject({ method: 'GET', url: '/api/sessions?archived=true' })
    expect(listings.at(-1)?.archived).toBe(true)
  })

  it('routes a bare id to the provider that owns it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/b1' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).session.id).toBe('b1')
  })
})

describe('GET /api/sessions/:id (a transcript page)', () => {
  it('defaults the first page to 60 turns', async () => {
    await app.inject({ method: 'GET', url: '/api/sessions/a1' })
    expect(transcripts.at(-1)).toEqual({ limit: 60 })
  })

  it('passes a cursor back to the provider verbatim', async () => {
    // The route does not know what a cursor means — Codex's is the
    // app-server's, Claude's is synthetic — so changing it in any way would
    // break exactly one of them.
    await app.inject({ method: 'GET', url: '/api/sessions/a1?limit=20&cursor=c%3A60' })
    expect(transcripts.at(-1)).toEqual({ limit: 20, cursor: 'c:60' })
  })

  it('omits the cursor when the client sends none', async () => {
    await app.inject({ method: 'GET', url: '/api/sessions/a1?limit=20' })
    // `cursor: undefined` and `cursor: ''` are not the same to a provider: an
    // empty one would be sent as a real (unusable) cursor.
    expect(transcripts.at(-1)).toEqual({ limit: 20 })
  })

  it('clamps an absurd limit instead of letting it size a file read', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/a1?limit=100000' })
    expect(res.statusCode).toBe(200)
    expect(transcripts.at(-1)?.limit).toBe(200)

    await app.inject({ method: 'GET', url: '/api/sessions/a1?limit=nope' })
    expect(transcripts.at(-1)?.limit).toBe(60)
  })

  it('floors a fractional limit instead of sending it on', async () => {
    // `slice` would silently truncate it, but the app-server RPC and the tail
    // reader's prompt count should never see a fractional size.
    await app.inject({ method: 'GET', url: '/api/sessions/a1?limit=20.9' })
    expect(transcripts.at(-1)?.limit).toBe(20)
  })

  it('forwards an item budget alongside the turn fallback', async () => {
    // `items` is the web client's page size; `limit` stays in the request so a
    // provider that does not know the newer option still gets a sane turn
    // count instead of an unbounded read.
    await app.inject({ method: 'GET', url: '/api/sessions/a1?items=60&cursor=c%3A80' })
    expect(transcripts.at(-1)).toEqual({ limit: 60, targetItems: 60, cursor: 'c:80' })
  })

  it('clamps and floors the item budget', async () => {
    await app.inject({ method: 'GET', url: '/api/sessions/a1?items=100000' })
    expect(transcripts.at(-1)?.targetItems).toBe(500)

    await app.inject({ method: 'GET', url: '/api/sessions/a1?items=59.9' })
    expect(transcripts.at(-1)?.targetItems).toBe(59)
  })

  it('omits the item budget when it is unusable', async () => {
    await app.inject({ method: 'GET', url: '/api/sessions/a1?items=nope' })
    expect(transcripts.at(-1)).toEqual({ limit: 60 })

    await app.inject({ method: 'GET', url: '/api/sessions/a1?items=0' })
    expect(transcripts.at(-1)).toEqual({ limit: 60 })
  })
})

describe('PATCH /api/sessions/:id', () => {
  it('pins and unpins', async () => {
    await app.inject({ method: 'PATCH', url: '/api/sessions/a1', payload: { pinned: true } })
    await app.inject({ method: 'PATCH', url: '/api/sessions/a1', payload: { pinned: false } })
    expect(pins).toEqual([
      ['a1', true],
      ['a1', false],
    ])
  })

  it('unarchives as well as archiving', async () => {
    // The half that was missing: `api.archiveSession` always passed `true`, so
    // archiving was one-way from the UI even though the route took a boolean.
    await app.inject({ method: 'PATCH', url: '/api/sessions/a1', payload: { archived: false } })
    expect(archives).toEqual([['a1', false]])
  })

  it('leaves the provider alone for a body that asks for nothing', async () => {
    // A PATCH carrying an unrelated field must not be read as "unpin" — the
    // route takes an explicit boolean or does nothing.
    const res = await app.inject({ method: 'PATCH', url: '/api/sessions/a1', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(pins).toEqual([])
    expect(archives).toEqual([])
  })

  it('answers 501 rather than a false success when the provider cannot pin', async () => {
    // A pin that silently does nothing is worse than a button that is not
    // offered: the row stays where it was and the user has no way to tell that
    // from "the list has not refreshed yet".
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/g1',
      payload: { pinned: true },
    })
    expect(res.statusCode).toBe(501)
    expect(JSON.parse(res.body).error).toBe('session_pin_not_supported')
    expect(pins).toEqual([])
  })

  it('still renames on a provider that cannot pin', async () => {
    // The 501 is about the pin only. Refusing the whole request would make an
    // unrelated field unsettable on such a provider.
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/g1',
      payload: { name: 'renamed' },
    })
    expect(res.statusCode).toBe(200)
  })
})
