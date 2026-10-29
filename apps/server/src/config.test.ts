import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bumpSessionVersion, loadConfig } from './config.js'

const KEYS = ['VIBEMOBILE_STATE_DIR', 'VIBEMOBILE_PIN', 'VIBEMOBILE_NO_AUTH', 'VIBEMOBILE_SESSION_TTL_MS']

let dir: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) delete process.env[key]
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibemobile-config-test-'))
  process.env.VIBEMOBILE_STATE_DIR = dir
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('session lifetime', () => {
  it('defaults to seven days', () => {
    process.env.VIBEMOBILE_PIN = 'test-pin'
    expect(loadConfig().sessionTtlMs).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('lets the environment override it', () => {
    process.env.VIBEMOBILE_PIN = 'test-pin'
    process.env.VIBEMOBILE_SESSION_TTL_MS = '3600000'
    expect(loadConfig().sessionTtlMs).toBe(3_600_000)
  })
})

describe('session generation', () => {
  it('bumps when the configured PIN changes, not on every restart', () => {
    process.env.VIBEMOBILE_PIN = 'first-pin'
    expect(loadConfig().sessionVersion).toBe(1)
    // Same PIN: reusing the persisted hash must not sign everyone out.
    expect(loadConfig().sessionVersion).toBe(1)

    process.env.VIBEMOBILE_PIN = 'second-pin'
    expect(loadConfig().sessionVersion).toBe(2)
  })

  it('persists a manual bump', () => {
    process.env.VIBEMOBILE_PIN = 'test-pin'
    const config = loadConfig()
    expect(bumpSessionVersion(config)).toBe(2)
    expect(config.sessionVersion).toBe(2)
    expect(loadConfig().sessionVersion).toBe(2)
  })

  it('does not bump when an auto-generated PIN is simply reloaded', () => {
    delete process.env.VIBEMOBILE_PIN
    const first = loadConfig()
    expect(first.sessionVersion).toBe(1)
    expect(loadConfig().sessionVersion).toBe(1)
  })
})
