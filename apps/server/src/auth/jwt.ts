import jwt from 'jsonwebtoken'
import type { Config } from '../config.js'

export interface SessionClaims {
  sub: 'owner'
  /**
   * Session generation. Bumping `config.sessionVersion` invalidates every
   * token issued before it (login, PIN change, "log out all devices").
   */
  ver: number
  iat: number
  exp: number
}

export const COOKIE_NAME = 'vibemobile_session'

export function signSession(config: Config): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + config.sessionTtlMs
  const token = jwt.sign({ sub: 'owner', ver: config.sessionVersion }, config.secret, {
    algorithm: 'HS256',
    expiresIn: Math.floor(config.sessionTtlMs / 1000),
  })
  return { token, expiresAt }
}

export function verifySession(config: Config, token: string | undefined): SessionClaims | null {
  if (!token) return null
  try {
    const claims = jwt.verify(token, config.secret, { algorithms: ['HS256'] }) as SessionClaims
    // A token from before the last bump has a stale `ver` and must not be
    // treated as authenticated even though its signature still verifies.
    return claims.sub === 'owner' && claims.ver === config.sessionVersion ? claims : null
  } catch {
    return null
  }
}

export function cookieOptions(config: Config, maxAgeMs: number) {
  return {
    httpOnly: true,
    // Lax (not Strict) so the cookie still rides along on a top-level
    // navigation to the app. The app is same-origin behind one port.
    sameSite: 'lax' as const,
    // No TLS on a LAN deployment; `secure` would silently break login there.
    // Set VIBEMOBILE_SECURE_COOKIE=1 when terminating TLS in front.
    secure: process.env.VIBEMOBILE_SECURE_COOKIE === '1',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  }
}
