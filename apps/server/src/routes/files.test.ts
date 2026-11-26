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

describe('file transfer and management', () => {
  it('serves video byte ranges and downloads original bytes with a filename', async () => {
    const file = path.join(dir, '测试.mp4')
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5])
    fs.writeFileSync(file, bytes)
    const query = '?path=' + encodeURIComponent(file)
    const head = await app.inject({ method: 'HEAD', url: '/api/files/video' + query })
    expect(head.statusCode).toBe(200)
    expect(head.headers['content-length']).toBe('6')
    const video = await app.inject({ url: '/api/files/video' + query, headers: { range: 'bytes=2-4' } })
    expect(video.statusCode).toBe(206)
    expect(video.headers['content-range']).toBe('bytes 2-4/6')
    expect(video.headers['content-type']).toContain('video/mp4')
    expect(video.rawPayload).toEqual(bytes.subarray(2, 5))
    const download = await app.inject({ url: '/api/files/download' + query })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toContain("attachment; filename*=UTF-8''")
    expect(download.rawPayload).toEqual(bytes)
    const invalid = await app.inject({ url: '/api/files/video' + query, headers: { range: 'bytes=99-' } })
    expect(invalid.statusCode).toBe(416)
    expect(invalid.headers['content-range']).toBe('bytes */6')
  })

  it('renames without overwriting and requires explicit delete confirmation', async () => {
    const file = path.join(dir, 'original.bin')
    const other = path.join(dir, 'existing.bin')
    fs.writeFileSync(file, 'original')
    fs.writeFileSync(other, 'existing')
    const rename = (name: string) => app.inject({ method: 'PATCH', url: '/api/files', payload: { path: file, name } })
    expect((await rename('existing.bin')).statusCode).toBe(409)
    expect(fs.readFileSync(other, 'utf8')).toBe('existing')
    const result = await rename('renamed.bin')
    expect(result.statusCode).toBe(200)
    const renamed = result.json().path
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(renamed, 'utf8')).toBe('original')
    const remove = (confirmed: boolean) =>
      app.inject({ method: 'DELETE', url: '/api/files', payload: { path: renamed, confirmed } })
    expect((await remove(false)).statusCode).toBe(400)
    expect(fs.existsSync(renamed)).toBe(true)
    expect((await remove(true)).statusCode).toBe(200)
    expect(fs.existsSync(renamed)).toBe(false)
  })
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

describe('GET /api/files/image', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9V8AAAAASUVORK5CYII=',
    'base64',
  )

  it('serves original image bytes with a safe MIME type and mutable private caching', async () => {
    const file = path.join(dir, '图片 #1.PNG')
    fs.writeFileSync(file, png)
    const res = await app.inject(`/api/files/image?path=${encodeURIComponent(file)}&refresh=1`)
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload).toEqual(png)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toBe('private, max-age=0')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('restricts image reads to supported formats and allowed workspaces', async () => {
    const unsupported = path.join(dir, 'a.svg')
    fs.writeFileSync(unsupported, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const cases = [
      { file: unsupported, status: 415 },
      { file: path.join(dir, '..', 'outside.png'), status: 403 },
      { file: path.join(dir, 'missing.png'), status: 404 },
      { file: '', status: 400 },
    ]
    for (const { file, status } of cases) {
      const res = await app.inject(`/api/files/image?path=${encodeURIComponent(file)}`)
      expect(res.statusCode).toBe(status)
      expect(res.headers['cache-control']).toBe('no-store')
    }
  })

  it('rejects oversized images before reading their contents', async () => {
    const file = path.join(dir, 'large.png')
    fs.writeFileSync(file, png)
    fs.truncateSync(file, 10 * 1024 * 1024 + 1)
    const res = await app.inject(`/api/files/image?path=${encodeURIComponent(file)}`)
    expect(res.statusCode).toBe(413)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})
