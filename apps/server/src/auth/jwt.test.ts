import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import type { Config } from '../config.js'
import { signSession, verifySession } from './jwt.js'

function config(sessionVersion: number): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    secret: 'a'.repeat(64),
    pinHash: null,
    authDisabled: false,
    sessionTtlMs: 60_000,
    sessionVersion,
    workspaceRoots: [],
    codex: { port: 0 },
    stateDir: '',
    webDist: '',
    trustProxy: false,
    terminal: { enabled: false, shell: '', idleTimeoutMs: 1_000 },
    logLevel: 'silent',
  }
}

describe('session generation', () => {
  it('accepts a token from the current generation', () => {
    const cfg = config(3)
    const { token } = signSession(cfg)
    expect(verifySession(cfg, token)?.ver).toBe(3)
  })

  it('rejects the same token once the generation advances', () => {
    const cfg = config(3)
    const { token } = signSession(cfg)
    cfg.sessionVersion = 4
    expect(verifySession(cfg, token)).toBeNull()
  })

  it('rejects a legacy token that has no version claim', () => {
    const cfg = config(1)
    const legacy = jwt.sign({ sub: 'owner' }, cfg.secret, { algorithm: 'HS256', expiresIn: 60 })
    expect(verifySession(cfg, legacy)).toBeNull()
  })

  it('rejects a token signed for another subject', () => {
    const cfg = config(1)
    const other = jwt.sign({ sub: 'someone-else', ver: 1 }, cfg.secret, { algorithm: 'HS256', expiresIn: 60 })
    expect(verifySession(cfg, other)).toBeNull()
  })
})
