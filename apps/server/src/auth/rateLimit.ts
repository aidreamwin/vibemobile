/**
 * Minimal in-memory rate limiter, keyed by client IP.
 *
 * This exists to make PIN brute-forcing impractical: an operator-supplied PIN
 * (VIBEMOBILE_PIN) can be short, and even the 16-character generated password
 * should not be guessable at network speed, so an unthrottled login endpoint
 * is not acceptable.
 */
export interface RateLimitOptions {
  /** Attempts allowed inside the window. */
  max: number
  windowMs: number
  /** How long a client stays blocked once `max` is exceeded. */
  blockMs: number
}

interface Bucket {
  count: number
  resetAt: number
  blockedUntil?: number
}

export class RateLimiter {
  #buckets = new Map<string, Bucket>()
  #opts: RateLimitOptions

  constructor(opts: RateLimitOptions) {
    this.#opts = opts
  }

  /** Returns null when allowed, or the ms to wait when blocked. */
  check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now()
    const bucket = this.#buckets.get(key)

    if (bucket?.blockedUntil && bucket.blockedUntil > now) {
      return { allowed: false, retryAfterMs: bucket.blockedUntil - now }
    }

    if (!bucket || bucket.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.#opts.windowMs })
      return { allowed: true }
    }

    bucket.count++
    if (bucket.count > this.#opts.max) {
      bucket.blockedUntil = now + this.#opts.blockMs
      return { allowed: false, retryAfterMs: this.#opts.blockMs }
    }
    return { allowed: true }
  }

  /** Clear a key after a successful login. */
  reset(key: string): void {
    this.#buckets.delete(key)
  }

  /** Drop expired buckets so the map cannot grow without bound. */
  sweep(): void {
    const now = Date.now()
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now && (!bucket.blockedUntil || bucket.blockedUntil <= now)) {
        this.#buckets.delete(key)
      }
    }
  }
}
