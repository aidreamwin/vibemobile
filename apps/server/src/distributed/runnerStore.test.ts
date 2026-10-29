import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tokenHash } from './hubApp.js'
import { RunnerStore } from './runnerStore.js'
import type { RunnerStoreError } from './runnerStore.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibemobile-runner-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const file = () => path.join(dir, 'runners.json')
const read = () => JSON.parse(readFileSync(file(), 'utf8'))

function thrown(fn: () => unknown): RunnerStoreError {
  try {
    fn()
  } catch (error) {
    return error as RunnerStoreError
  }
  throw new Error('expected the call to throw')
}

describe('RunnerStore', () => {
  it('treats a missing file as an empty list', () => {
    expect(new RunnerStore(file()).list()).toEqual([])
  })

  it('creates a runner with a generated id and a one-time token', () => {
    const store = new RunnerStore(file())
    const created = store.create('  办公室机器  ', () => false)

    expect(created.spec.id).toMatch(/^runner-[a-f0-9]{8}$/)
    expect(created.spec.name).toBe('办公室机器')
    expect(created.token).toMatch(/^[a-f0-9]{64}$/)
    expect(created.spec.tokenHash).toBe(tokenHash(created.token))

    const persisted = read()
    expect(persisted).toEqual([{ id: created.spec.id, name: '办公室机器', tokenHash: created.spec.tokenHash }])
    expect(JSON.stringify(persisted)).not.toContain(created.token)
    expect(new RunnerStore(file()).list()).toEqual(persisted)
  })

  it('rotates the hash and returns a different token', () => {
    const store = new RunnerStore(file())
    const created = store.create('机器B', () => false)
    const rotated = store.refresh(created.spec.id)

    expect(rotated.token).not.toBe(created.token)
    expect(rotated.spec.tokenHash).toBe(tokenHash(rotated.token))
    expect(rotated.spec.tokenHash).not.toBe(created.spec.tokenHash)
    expect(read()[0].tokenHash).toBe(rotated.spec.tokenHash)
  })

  it('removes the runner from memory and disk', () => {
    const store = new RunnerStore(file())
    const created = store.create('机器B', () => false)
    store.create('机器C', () => false)

    expect(store.remove(created.spec.id).id).toBe(created.spec.id)
    expect(store.list().map((spec) => spec.name)).toEqual(['机器C'])
    expect(read().map((spec: { name: string }) => spec.name)).toEqual(['机器C'])
  })

  it('rejects unknown ids', () => {
    const store = new RunnerStore(file())
    expect(thrown(() => store.refresh('missing'))).toMatchObject({ message: 'runner_not_found', statusCode: 404 })
    expect(thrown(() => store.remove('missing'))).toMatchObject({ message: 'runner_not_found', statusCode: 404 })
  })

  it('rejects empty, blank and overlong names', () => {
    const store = new RunnerStore(file())
    for (const name of ['', '   ', 'x'.repeat(101)]) {
      expect(thrown(() => store.create(name, () => false))).toMatchObject({
        message: 'invalid_runner_name',
        statusCode: 400,
      })
    }
    expect(thrown(() => store.create(undefined as unknown as string, () => false))).toMatchObject({
      message: 'invalid_runner_name',
    })
    expect(store.list()).toEqual([])
  })

  it('refuses to create beyond the 200-runner cap', () => {
    const specs = Array.from({ length: 200 }, (_, index) => ({
      id: `r${index}`,
      name: `runner ${index}`,
      tokenHash: tokenHash(`token-${index}`),
    }))
    writeFileSync(file(), JSON.stringify(specs))
    expect(thrown(() => new RunnerStore(file()).create('too many', () => false))).toMatchObject({
      message: 'runner_limit',
      statusCode: 409,
    })
  })

  it('reports a corrupt file instead of starting empty', () => {
    writeFileSync(file(), '{ not json')
    expect(() => new RunnerStore(file())).toThrow(/not valid JSON/)
    writeFileSync(file(), JSON.stringify({ runners: [] }))
    expect(() => new RunnerStore(file())).toThrow(/must be a JSON array/)
    writeFileSync(file(), JSON.stringify([{ id: 'bad id!', name: 'x', tokenHash: 'a'.repeat(64) }]))
    expect(() => new RunnerStore(file())).toThrow()
  })

  it('fails after repeated id collisions without writing', () => {
    const store = new RunnerStore(file())
    expect(thrown(() => store.create('机器B', () => true))).toMatchObject({
      message: 'runner_id_conflict',
      statusCode: 500,
    })
    expect(store.list()).toEqual([])
  })

  it('leaves memory untouched when the write fails', () => {
    const nested = path.join(dir, 'state')
    const store = new RunnerStore(path.join(nested, 'runners.json'))
    store.create('机器B', () => false)

    // Replace the directory with a regular file so mkdir/rename cannot work.
    renameSync(nested, `${nested}-moved`)
    writeFileSync(nested, 'blocked')

    expect(thrown(() => store.create('机器C', () => false))).toMatchObject({
      message: 'runner_store_unwritable',
      statusCode: 500,
    })
    expect(store.list().map((spec) => spec.name)).toEqual(['机器B'])
  })

  it.skipIf(process.platform === 'win32')('writes the file with mode 0600', () => {
    new RunnerStore(file()).create('机器B', () => false)
    expect(existsSync(file())).toBe(true)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })
})
