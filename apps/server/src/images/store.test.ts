import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_PER_MESSAGE, ImageStore } from './store.js'

/** A one-pixel PNG — real bytes, so the hash and the round-trip mean something. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = `data:image/png;base64,${PNG_B64}`
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA=='

let dir: string
let store: ImageStore

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-images-'))
  store = new ImageStore(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('ImageStore.put', () => {
  it('stores the decoded bytes and round-trips them exactly', () => {
    const token = store.put(PNG)
    expect(token).toMatch(/^[a-f0-9]{32}\.png$/)

    const found = store.get(token!)
    expect(found?.mime).toBe('image/png')
    expect(fs.readFileSync(found!.path).toString('base64')).toBe(PNG_B64)
  })

  it('views the same image as the same token, however it was encoded', () => {
    // Same bytes, different spelling: a line break in the base64 is the
    // realistic difference between two clients, and hashing the TEXT rather
    // than the decoded bytes would make it a second file.
    const padded = PNG.replace(';base64,', ';base64,\n')
    expect(store.put(padded)).toBe(store.put(PNG))
    expect(fs.readdirSync(dir)).toHaveLength(1)
  })

  it('derives the extension from the data URL, and the mime back from it', () => {
    expect(store.put(JPEG)).toMatch(/^[a-f0-9]{32}\.jpg$/)
    expect(store.get(store.put(JPEG)!)?.mime).toBe('image/jpeg')
  })

  it('refuses to store an SVG', () => {
    // Same-origin XSS: this route serves whatever is stored, and the app holds
    // an authenticated session. An SVG is a document that can run script.
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`
    expect(store.put(svg)).toBeNull()
    expect(fs.readdirSync(dir)).toHaveLength(0)
  })

  it('refuses anything that is not a whitelisted inline data URL', () => {
    expect(store.put('https://example.com/x.png')).toBeNull()
    expect(store.put('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(store.put('data:image/tiff;base64,AAAA')).toBeNull()
    // A data URL with no `;base64` marker is not something we re-encode.
    expect(store.put('data:image/png,AAAA')).toBeNull()
    expect(store.put('')).toBeNull()
    expect(store.put(undefined as unknown as string)).toBeNull()
  })

  it('refuses an image larger than the server-side cap', () => {
    // The client compresses to 1.5 MB, but it is not the only thing that can
    // speak the WebSocket protocol.
    const big = `data:image/png;base64,${Buffer.alloc(11 * 1024 * 1024).toString('base64')}`
    expect(store.put(big)).toBeNull()
  })

  it('never throws, even when the directory cannot be written', () => {
    // A read-only state directory must cost the picture, not the turn.
    const bad = new ImageStore(path.join(dir, 'nested', '..', '\0invalid'))
    expect(() => bad.put(PNG)).not.toThrow()
    expect(bad.put(PNG)).toBeNull()
  })
})

describe('ImageStore.get', () => {
  it('does not resolve a token that could escape the directory', () => {
    // Validated as a whole before any path is built, so this never reaches the
    // filesystem — `path.join` is applied only to a string that already matched
    // `[a-f0-9]{32}\.(jpg|png|webp|gif)`.
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope')
    const storeIn = new ImageStore(dir)
    expect(storeIn.get('../secret.txt')).toBeNull()
    expect(storeIn.get('..%2Fsecret.txt')).toBeNull()
    expect(storeIn.get('a/b.png')).toBeNull()
    expect(storeIn.get('\\secret.txt')).toBeNull()
    expect(storeIn.get(path.join(dir, 'secret.txt'))).toBeNull()
  })

  it('rejects a well-formed but unknown token, and a malformed one', () => {
    expect(store.get('0'.repeat(32) + '.png')).toBeNull()
    expect(store.get('0'.repeat(32) + '.exe')).toBeNull()
    expect(store.get('0'.repeat(31) + '.png')).toBeNull()
    expect(store.get('')).toBeNull()
  })

  it('does not resolve a token whose file is a directory', () => {
    const token = `${'b'.repeat(32)}.png`
    fs.mkdirSync(path.join(dir, token))
    expect(store.get(token)).toBeNull()
  })
})

describe('MAX_PER_MESSAGE', () => {
  it('is small enough to bound one message', () => {
    expect(MAX_PER_MESSAGE).toBeGreaterThan(0)
    expect(MAX_PER_MESSAGE).toBeLessThanOrEqual(16)
  })
})
