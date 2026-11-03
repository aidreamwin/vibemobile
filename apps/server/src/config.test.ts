import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bumpSessionVersion, loadConfig } from './config.js'

const KEYS = [
  'VIBEMOBILE_STATE_DIR',
  'VIBEMOBILE_PIN',
  'VIBEMOBILE_NO_AUTH',
  'VIBEMOBILE_SESSION_TTL_MS',
  'OPENCODE_ATTACH_URL',
  'OPENCODE_URL',
  'OPENCODE_PORT',
  'OPENCODE_BIN',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVICE_FILE',
  'OPENCODE_NO_ATTACH',
]

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

describe('opencode config', () => {
  it('defaults to discovery plus a private port', () => {
    process.env.VIBEMOBILE_PIN = 'test-pin'
    const config = loadConfig()
    expect(config.opencode).toEqual({ port: 6820, noAttach: false })
  })

  it('reads the attach URL, password, bin, service file and no-attach switch', () => {
    process.env.VIBEMOBILE_PIN = 'test-pin'
    process.env.OPENCODE_URL = 'http://127.0.0.1:28894'
    process.env.OPENCODE_PORT = '7777'
    process.env.OPENCODE_BIN = '/opt/opencode'
    process.env.OPENCODE_SERVER_PASSWORD = 'secret'
    process.env.OPENCODE_SERVICE_FILE = '/tmp/service.json'
    process.env.OPENCODE_NO_ATTACH = '1'
    expect(loadConfig().opencode).toEqual({
      attachUrl: 'http://127.0.0.1:28894',
      port: 7777,
      bin: '/opt/opencode',
      password: 'secret',
      serviceFile: '/tmp/service.json',
      noAttach: true,
    })
  })
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
