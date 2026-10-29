import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// -------------------------------------------------------------------- probing

/**
 * The CLI's own words for "I have no credentials", and it is a TRUTHY string.
 *
 * `Boolean(account.tokenSource)` therefore reported `authenticated: true` for a
 * CLI with nothing configured at all — the worst possible failure for this
 * field, because it is the only auth signal the phone gets. Measured on a clean
 * config dir with no `ANTHROPIC_*` in the environment: `{tokenSource: 'none',
 * apiProvider: 'firstParty'}`, and the model catalogue reverts to the official
 * one (`default` → `claude-opus-5[1m]`, `opus[1m]`, `sonnet`, `haiku`).
 *
 * Compare a working proxy setup on the same CLI: `tokenSource:
 * 'ANTHROPIC_AUTH_TOKEN'` and every alias resolving to the proxy's own models.
 */
const NO_TOKEN = 'none'

export function isAuthenticated(account: { tokenSource?: unknown } | undefined): boolean {
  const source = account?.tokenSource
  return typeof source === 'string' && source.length > 0 && source !== NO_TOKEN
}

/**
 * The config directory the CLI is reading — the same expression the SDK uses to
 * resolve it for the subprocess it spawns.
 *
 * It is in the message because it is the whole diagnosis when a server is
 * deployed as a service. Measured: with `ANTHROPIC_*` stripped from the
 * process environment, the SDK-spawned CLI STILL resolves the proxy's models —
 * it reads `~/.claude/settings.json`'s `env` block itself — so "no credentials"
 * can only mean the file it read is not the file you configured. `pm2`/`nssm`
 * starting the service as another user is the usual reason: the operator's
 * `~/.claude/settings.json` is fine, the service is looking in `/root/.claude`.
 * Without the path on screen the only symptom is "the model list went back to
 * the official one".
 */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
}

// -------------------------------------------------------------- effort levels

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * The CLI's own default effort — what it applies when a turn does not override
 * it (`Options.effort` is documented as "'high' — Deep reasoning (default)").
 *
 * Reported as every model's `defaultEffort` because the alternative the UI
 * falls back to is `efforts[0]`, which is the CHEAPEST level. Without this,
 * opening a session and typing silently sent `low` — a downgrade the user
 * never asked for and could not see.
 *
 * It cannot be read back from the CLI: `init.effort` is only published on
 * Remote Control bridge frames, and is `undefined` for SDK-hosted sessions
 * whether or not an effort was passed (measured both ways).
 */
export const DEFAULT_EFFORT: EffortLevel = 'high'

/**
 * Narrow a remembered effort to something this SDK accepts.
 *
 * The values are the CLI's own (`supportedEffortLevels` in the init frame),
 * but an effort picked on a previous run is replayed into a fresh subprocess,
 * and a level this CLI no longer knows is rejected mid-turn. Dropping an
 * unknown value quietly is the graceful end: the model's own default applies
 * instead of the turn failing to start.
 */
export function effortLevel(value: string | null): EffortLevel | undefined {
  return value && (EFFORT_LEVELS as readonly string[]).includes(value) ? (value as EffortLevel) : undefined
}

export function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * A model label a person can act on: the alias, plus the model it resolves to
 * when the two differ. `displayName` alone is sometimes just prose ("Default
 * (recommended)") that hides which model will really run.
 */
export function label(m: any): string {
  const name = String(m.displayName ?? m.value)
  const resolved = m.resolvedModel ? String(m.resolvedModel) : ''
  if (!resolved || name.includes(resolved)) return name
  return `${name} · ${resolved}`
}

/**
 * The installed SDK's real version, so `probe().version` is never a guess.
 *
 * The package's `exports` map does not expose `./package.json`
 * (ERR_PACKAGE_PATH_NOT_EXPORTED), so the manifest is found by resolving the
 * entry file and walking up to the nearest one.
 */
export function sdkVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    let dir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
    for (let i = 0; i < 4; i += 1) {
      const manifest = path.join(dir, 'package.json')
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        if (pkg?.name === '@anthropic-ai/claude-agent-sdk') return String(pkg.version)
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ])
}

/** Resolved `~/.claude` (or `CLAUDE_CONFIG_DIR`), used to locate session JSONL files. */
export function claudeConfigDir(): string {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'))
}

// ------------------------------------------------------------ auto-compaction

/**
 * How much of the model's window the CLI may fill before compacting.
 *
 * Auto-compaction is checked at request boundaries, but a single agentic turn
 * can append a lot of tool output between them. Leaving only the CLI's default
 * sliver of headroom is what let a 1M-context DeepSeek session send a
 * 1,051,635-token request against a 1,048,576-token limit: the turn started
 * close to the line and the tool results crossed it before the next check.
 * 20% headroom also covers the 32k completion budget and token-estimation
 * drift between the CLI and the API.
 *
 * The setting only accepts 100k–1M, so smaller windows are left to the CLI's
 * own policy instead of being clamped to a value that would disable it.
 */
const AUTO_COMPACT_RATIO = 0.8
const AUTO_COMPACT_MIN = 100_000
const AUTO_COMPACT_MAX = 1_000_000
const AUTO_COMPACT_FLOOR = 125_000

export function autoCompactWindowFor(contextWindow?: number): number | undefined {
  if (!contextWindow || contextWindow < AUTO_COMPACT_FLOOR) return undefined
  return Math.min(AUTO_COMPACT_MAX, Math.max(AUTO_COMPACT_MIN, Math.floor(contextWindow * AUTO_COMPACT_RATIO)))
}

/**
 * A first-turn window guess from the model catalogue.
 *
 * `modelUsage.contextWindow` only exists after a turn has produced a result.
 * A session resumed after a server restart therefore starts with no observed
 * window, and on a proxy model that the CLI does not fully understand that is
 * exactly when a 1M session can overflow on its first request. The catalogue's
 * resolved name is the one reliable hint (`deepseek-flash[1m]`), so it is used
 * only as a fallback; once a real result arrives its `contextWindow` wins.
 */
const ONE_M_CONTEXT = 1_048_576

export function guessedContextWindowForModel(resolvedModel?: string | null): number | undefined {
  if (!resolvedModel) return undefined
  return /\[1m\]/i.test(resolvedModel) ? ONE_M_CONTEXT : undefined
}
