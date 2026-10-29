/**
 * Remote runner credentials, persisted as a JSON array.
 *
 * The Hub is the only writer (the CLI script `scripts/create-runner.mjs` can
 * seed the same file while the Hub is stopped). Plaintext tokens are returned
 * to the caller exactly once and never stored: the file holds only SHA-256
 * hashes, and an existing token cannot be recovered — rotate it instead.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tokenHash, validateRunners, type RunnerSpec } from './hubApp.js'

const MAX_RUNNERS = 200
const MAX_NAME = 100
const ID_ATTEMPTS = 16

export class RunnerStoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RunnerStoreError'
  }
}

export class RunnerStore {
  readonly #file: string
  #specs: RunnerSpec[]

  constructor(file: string) {
    this.#file = file
    this.#specs = load(file)
  }

  list(): RunnerSpec[] {
    return this.#specs.map((spec) => ({ ...spec }))
  }

  /**
   * `idTaken` covers the runtime side (the default runner and anything already
   * in the Hub's entry map) so a generated id can never shadow a live one.
   */
  create(name: string, idTaken: (id: string) => boolean): { spec: RunnerSpec; token: string } {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed || trimmed.length > MAX_NAME) throw new RunnerStoreError('invalid_runner_name', 400)
    if (this.#specs.length >= MAX_RUNNERS) throw new RunnerStoreError('runner_limit', 409)

    let id: string | undefined
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const candidate = `runner-${crypto.randomBytes(4).toString('hex')}`
      if (!idTaken(candidate) && !this.#specs.some((spec) => spec.id === candidate)) {
        id = candidate
        break
      }
    }
    if (!id) throw new RunnerStoreError('runner_id_conflict', 500)

    const token = crypto.randomBytes(32).toString('hex')
    const spec: RunnerSpec = { id, name: trimmed, tokenHash: tokenHash(token) }
    this.#persist([...this.#specs, spec])
    this.#specs.push(spec)
    return { spec: { ...spec }, token }
  }

  refresh(id: string): { spec: RunnerSpec; token: string } {
    const index = this.#specs.findIndex((spec) => spec.id === id)
    if (index === -1) throw new RunnerStoreError('runner_not_found', 404)

    const token = crypto.randomBytes(32).toString('hex')
    const spec: RunnerSpec = { ...this.#specs[index], tokenHash: tokenHash(token) }
    const next = [...this.#specs]
    next[index] = spec
    this.#persist(next)
    this.#specs = next
    return { spec: { ...spec }, token }
  }

  remove(id: string): RunnerSpec {
    const index = this.#specs.findIndex((spec) => spec.id === id)
    if (index === -1) throw new RunnerStoreError('runner_not_found', 404)

    const next = this.#specs.filter((spec) => spec.id !== id)
    this.#persist(next)
    const [removed] = this.#specs.splice(index, 1)
    return { ...removed }
  }

  /**
   * Write first, mutate memory only after the rename succeeds: a read-only
   * mount must leave the token still valid, not a half-applied rotation.
   */
  #persist(specs: RunnerSpec[]): void {
    let temporary: string | undefined
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      temporary = `${this.#file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify(specs, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, this.#file)
    } catch (error) {
      if (temporary) fs.rmSync(temporary, { force: true })
      throw new RunnerStoreError('runner_store_unwritable', 500, { cause: error })
    }
  }
}

function load(file: string): RunnerSpec[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // A missing file is the normal first run; both the default state-dir path
    // and an explicit VIBEMOBILE_RUNNERS_FILE start empty and are created on
    // the first mutation.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`runner config is not valid JSON: ${file}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`runner config must be a JSON array: ${file}`)
  // `validateRunners` requires at least one entry; an empty file is expected
  // whenever only the Hub's default runner exists.
  if (parsed.length) validateRunners(parsed)
  return parsed as RunnerSpec[]
}
