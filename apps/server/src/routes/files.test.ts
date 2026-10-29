/**
 * The save route, against real files.
 *
 * Only the parts that are about the ROUTE rather than about writing files live
 * here: the body-size ceiling, which is decided by Fastify before any handler
 * runs, and the wire shape of the `file_changed` 409. Everything about line
 * endings, encodings and atomicity is `files/workspace.test.ts`, because none
 * of it is visible from this side.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { registerFileRoutes } from './files.js'

let dir: string
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-files-route-'))
  const config = loadConfig({ authDisabled: true, stateDir: dir, workspaceRoots: [dir] })
  app = Fastify()
  registerFileRoutes(app, config)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('PUT /api/files/content', () => {
  it('saves and answers with the file as it now is', async () => {
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'before')
    const res = await app.inject({
      method: 'PUT',
      url: '/api/files/content',
      payload: { path: file, text: 'after' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ text: 'after', bytes: 5 })
    expect(fs.readFileSync(file, 'utf8')).toBe('after')
  })

  it('accepts an empty string and rejects a missing one', async () => {
    const file = path.join(dir, 'b.txt')
    fs.writeFileSync(file, 'x')
    // `text` is required even when it is empty — the two are different
    // requests, and only one of them means "clear this file".
    const cleared = await app.inject({ method: 'PUT', url: '/api/files/content', payload: { path: file, text: '' } })
    expect(cleared.statusCode).toBe(200)
    expect(fs.readFileSync(file, 'utf8')).toBe('')

    const missing = await app.inject({ method: 'PUT', url: '/api/files/content', payload: { path: file } })
    expect(missing.statusCode).toBe(400)
  })

  it('carries the code on the 409, and no code anywhere else', async () => {
    const file = path.join(dir, 'c.txt')
    fs.writeFileSync(file, 'one')
    const read = await app.inject({ method: 'GET', url: `/api/files/content?path=${encodeURIComponent(file)}` })
    const rev = JSON.parse(read.body).rev
    fs.writeFileSync(file, 'two')

    const conflict = await app.inject({
      method: 'PUT',
      url: '/api/files/content',
      payload: { path: file, text: 'three', rev },
    })
    expect(conflict.statusCode).toBe(409)
    expect(JSON.parse(conflict.body)).toMatchObject({ code: 'file_changed' })

    // A plain failure keeps the body it has always had: `{error}` and nothing
    // else, so an older client is unaffected by this release.
    const outside = await app.inject({
      method: 'PUT',
      url: '/api/files/content',
      payload: { path: path.join(dir, '..', 'elsewhere.txt'), text: 'x' },
    })
    expect(outside.statusCode).toBe(403)
    expect(Object.keys(JSON.parse(outside.body))).toEqual(['error'])
  })

  it('accepts a body between the framework default and the file ceiling', async () => {
    // Fastify refuses anything over 1 MiB *before* the handler sees it, so
    // without the route-level `bodyLimit` a legal 512 KB file is rejected with
    // a 413 that looks like a client bug. This payload is ~1.2 MB of JSON —
    // over the default, under the override.
    const file = path.join(dir, 'd.txt')
    fs.writeFileSync(file, 'small')
    const text = 'x'.repeat(1_200_000)
    const res = await app.inject({ method: 'PUT', url: '/api/files/content', payload: { path: file, text } })
    expect(res.statusCode).toBe(200)
    // (The workspace's own 512 KB ceiling is what refuses this in production —
    // see `writeFileText`. What is being asserted here is only that the
    // framework let the request through.)
    expect(fs.statSync(file).size).toBe(1_200_000)
  })

  it('is a PUT and not a GET-only route', async () => {
    // A regression guard with a low bar: the route table is the only place the
    // verb is visible, and `api.saveFile` would otherwise 404 in production
    // while every provider test stays green.
    const res = await app.inject({ method: 'GET', url: '/api/files/content' })
    expect(res.statusCode).toBe(400) // no `path`, from the GET handler
  })
})
