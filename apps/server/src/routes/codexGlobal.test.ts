import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { CodexGlobalCatalog, CodexGlobalDocument } from '@vibemobile/protocol'
import type { Config } from '../config.js'
import { CodexGlobalStore } from '../agents/codexGlobal.js'
import { registerCodexGlobalRoutes } from './codexGlobal.js'

let directory: string
let app: FastifyInstance
async function build(authDisabled = true) {
  app = Fastify()
  await app.register(cookie)
  registerCodexGlobalRoutes(
    app,
    { authDisabled, secret: 'test' } as Config,
    new CodexGlobalStore({ home: directory, env: {} }),
  )
  await app.ready()
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-global-route-'))
})
afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('requires authentication for browsing, reading, saving and creating', async () => {
  await build(false)
  for (const [method, url] of [
    ['GET', '/api/codex/global'],
    ['GET', '/api/codex/global/document?id=x'],
    ['PUT', '/api/codex/global/document'],
    ['POST', '/api/codex/global/skills'],
  ] as const) {
    const response = await app.inject({ method, url })
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('no-store')
  }
})

it('reads and edits the runner user global rules while returning a conflict for stale drafts', async () => {
  await build()
  const catalog = await app.inject('/api/codex/global')
  expect(catalog.headers['cache-control']).toBe('no-store')
  const id = catalog.json<CodexGlobalCatalog>().entries[0].id
  const document = (await app.inject(`/api/codex/global/document?id=${id}`)).json<CodexGlobalDocument>()
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/codex/global/document',
    payload: { id, text: 'Global rules', revision: document.revision },
  })
  expect(saved.statusCode).toBe(200)
  expect(saved.json<CodexGlobalDocument>().text).toBe('Global rules')
  expect(fs.readFileSync(path.join(directory, '.codex/AGENTS.md'), 'utf8')).toBe('Global rules')
  const conflict = await app.inject({
    method: 'PUT',
    url: '/api/codex/global/document',
    payload: { id, text: 'stale', revision: document.revision },
  })
  expect(conflict.statusCode).toBe(409)
  expect(conflict.json()).toEqual({ error: 'codex_global_changed' })
  expect(conflict.headers['cache-control']).toBe('no-store')
})

it('creates a skill and makes it available for subsequent browsing and editing', async () => {
  await build()
  const created = await app.inject({
    method: 'POST',
    url: '/api/codex/global/skills',
    payload: {
      name: 'release-check',
      text: '---\nname: release-check\ndescription: Run release checks.\n---\n\nCheck versions.',
    },
  })
  expect(created.statusCode).toBe(201)
  const document = created.json<CodexGlobalDocument>()
  expect((await app.inject('/api/codex/global')).json<CodexGlobalCatalog>().entries).toContainEqual(document.entry)
  expect(
    (await app.inject(`/api/codex/global/document?id=${document.entry.id}`)).json<CodexGlobalDocument>().text,
  ).toContain('Check versions.')
  const invalid = await app.inject({
    method: 'PUT',
    url: '/api/codex/global/document',
    payload: {
      id: document.entry.id,
      text: 'invalid',
      revision: document.revision,
    },
  })
  expect(invalid.statusCode).toBe(400)
  expect(invalid.json()).toEqual({ error: 'codex_global_invalid_skill' })
})

it('rejects forged ids, unexpected files and oversized or malformed content', async () => {
  await build()
  const forged = Buffer.from(JSON.stringify(['rules', 'auth.json'])).toString('base64url')
  const forbidden = await app.inject(`/api/codex/global/document?id=${forged}`)
  expect(forbidden.statusCode).toBe(403)
  expect(forbidden.json()).toEqual({ error: 'codex_global_invalid_path' })
  const id = (await app.inject('/api/codex/global')).json<CodexGlobalCatalog>().entries[0].id
  for (const text of [undefined, null, {}, 10]) {
    const response = await app.inject({ method: 'PUT', url: '/api/codex/global/document', payload: { id, text } })
    expect(response.statusCode).toBe(400)
  }
  const large = await app.inject({
    method: 'PUT',
    url: '/api/codex/global/document',
    payload: { id, text: 'x'.repeat(512 * 1024 + 1) },
  })
  expect(large.statusCode).toBe(413)
})
