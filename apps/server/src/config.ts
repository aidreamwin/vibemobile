/**
 * Runtime configuration.
 *
 * Everything is env-driven so the server can run as a plain `node dist/index.js`
 * behind a tunnel or on the LAN without extra tooling.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Config {
  host: string
  port: number
  /** JWT signing secret (hex). Stable across restarts. */
  secret: string
  /** scrypt hash of the login PIN, or null when auth is disabled. */
  pinHash: string | null
  /** True when no PIN is configured — auth is skipped entirely. */
  authDisabled: boolean
  sessionTtlMs: number
  /**
   * Generation stamped into every JWT. A token is only accepted when its `ver`
   * claim equals this value, which is how a PIN change and "log out all
   * devices" revoke sessions without server-side token storage. Login does not
   * bump it: several devices may stay signed in at once.
   */
  sessionVersion: number
  workspaceRoots: string[]
  codex: {
    /** Attach to an already-running app-server instead of spawning one. */
    attachUrl?: string
    port: number
    /** Path to the codex entry point; resolved automatically when omitted. */
    bin?: string
  }
  stateDir: string
  /** Where built web assets live, served as the SPA. */
  webDist: string
  /**
   * Whether to believe `X-Forwarded-For` when deciding a client's address.
   *
   * OFF by default, and that default is load-bearing. The only thing the login
   * throttle keys on is that address, and `X-Forwarded-For` is a header the
   * client writes: trusting it unconditionally lets anyone rotating the header
   * take an unlimited number of guesses at the PIN — the sole barrier
   * between the network and a shell on this machine. So it is turned on only
   * when something in front really does set it (a tunnel or reverse proxy,
   * matching VIBEMOBILE_SECURE_COOKIE), and a direct LAN connection — the
   * common case — keeps the unspoofable socket address.
   */
  trustProxy: boolean
  terminal: {
    /**
     * Direct shell access. This is a bigger capability than the agent itself —
     * it is an unrestricted shell on the host — so it can be turned off with
     * VIBEMOBILE_TERMINAL=off without affecting anything else.
     */
    enabled: boolean
    shell: string
    /** Reap a terminal nobody has typed into, so a forgotten tab frees its shell. */
    idleTimeoutMs: number
  }
  logLevel: 'silent' | 'info' | 'debug'
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

/**
 * The repository root: the nearest ancestor of this file whose package.json
 * declares npm workspaces.
 *
 * Paths in this config are repository-relative, NOT cwd-relative. npm runs
 * workspace scripts with the working directory set to the workspace, so
 * `npm start` and `npm run dev` from the root arrive here with a cwd of
 * `apps/server`. Resolving against cwd then produced `apps/server/apps/web/dist`
 * for the built assets and, worse, a second `.vibemobile/` inside `apps/server`
 * holding a different signing secret and a different PIN.
 *
 * Anchoring on the module location rather than cwd makes the answer the same
 * however the server is started.
 */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    const parent = path.dirname(dir)
    if (parent === dir) return process.cwd() // no workspace root; fall back
    dir = parent
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (Array.isArray(pkg.workspaces)) return dir
    } catch {
      // No package.json here, or unreadable JSON — keep walking up.
    }
  }
}

function boolEnv(name: string): boolean {
  const v = env(name)
  return v === '1' || v === 'true' || v === 'yes'
}

// -------------------------------------------------------------- pin hashing

/** Characters in an auto-generated PIN. */
const PIN_LENGTH = 16

/**
 * Alphabet for auto-generated PINs: uppercase, lowercase, digits and a few
 * symbols, with the look-alikes (0/O, 1/l/I) left out because the value is
 * copied by hand from the startup log. At 16 characters this is about 97 bits
 * of entropy, so the throttle protects only operator-supplied short PINs.
 */
const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+'

/**
 * A random password, uniform over the alphabet.
 *
 * Sampled one character at a time with `randomInt`, which is rejection-sampled
 * and therefore unbiased — `randomBytes[i] % alphabet.length` is not.
 */
function generatePin(): string {
  let pin = ''
  for (let i = 0; i < PIN_LENGTH; i++) pin += PIN_ALPHABET[crypto.randomInt(PIN_ALPHABET.length)]
  return pin
}

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(pin, salt, 32)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  let derived: Buffer
  try {
    derived = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length)
  } catch {
    return false
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
}

// -------------------------------------------------------------------- state

interface PersistedState {
  secret: string
  pinHash?: string
  /** Set when the PIN was auto-generated, so we can reprint it on restart. */
  generatedPin?: string
  /** Monotonic session generation; see `Config.sessionVersion`. */
  sessionVersion?: number
}

function loadState(stateDir: string): PersistedState {
  const file = path.join(stateDir, 'state.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof raw?.secret === 'string' && raw.secret.length >= 32) return raw
  } catch {
    /* first run or corrupt */
  }
  return { secret: crypto.randomBytes(32).toString('hex') }
}

function saveState(stateDir: string, state: PersistedState): void {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, 'state.json')
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
}

/**
 * Invalidate every issued token by advancing the generation stamped into new
 * JWTs. Called when the configured PIN changes and by "log out all devices" —
 * not on login, so several devices can stay signed in at once.
 *
 * The write happens before the version is published, so a failed write leaves
 * old tokens valid instead of minting a token nothing else accepts.
 */
export function bumpSessionVersion(config: Config): number {
  const state = loadState(config.stateDir)
  // Keep the on-disk record consistent with what this process is actually
  // using. `loadState` invents a secret when the file is missing, and the
  // generation must advance past the in-memory one even then — otherwise a
  // bump could hand out the same `ver` twice and revoke nothing.
  state.secret = config.secret
  if (!state.pinHash && config.pinHash) state.pinHash = config.pinHash
  const version = Math.max(state.sessionVersion ?? 0, config.sessionVersion) + 1
  state.sessionVersion = version
  saveState(config.stateDir, state)
  config.sessionVersion = version
  return version
}

// --------------------------------------------------------------------- load

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const root = repoRoot()
  const stateDir = env('VIBEMOBILE_STATE_DIR') ?? path.join(root, '.vibemobile')
  const state = loadState(stateDir)

  const rootsRaw = env('VIBEMOBILE_ROOTS')
  const workspaceRoots = rootsRaw
    ? rootsRaw
        .split(path.delimiter === ';' ? /[;,]/ : /[:,]/)
        .map((p) => path.resolve(p.trim()))
        .filter(Boolean)
    : [root]

  // A configured PIN wins; otherwise reuse the generated one so the user does
  // not have to re-pair on every restart.
  const explicitPin = env('VIBEMOBILE_PIN')
  let pinHash: string | null
  if (explicitPin) {
    // Only a *changed* PIN revokes sessions. Reusing the stored hash when the
    // configured PIN still verifies keeps every restart from logging everyone
    // out — and avoids paying scrypt for a new hash on every start.
    if (state.pinHash && verifyPin(explicitPin, state.pinHash)) {
      pinHash = state.pinHash
    } else {
      pinHash = hashPin(explicitPin)
      state.pinHash = pinHash
      state.sessionVersion = (state.sessionVersion ?? 0) + 1
    }
    state.generatedPin = undefined
  } else if (boolEnv('VIBEMOBILE_NO_AUTH')) {
    pinHash = null
  } else if (state.pinHash) {
    pinHash = state.pinHash
  } else {
    const generated = generatePin()
    state.generatedPin = generated
    state.pinHash = hashPin(generated)
    // A new PIN is also a boundary: tokens issued while auth was disabled (or
    // from an older state file) must not survive it.
    state.sessionVersion = (state.sessionVersion ?? 0) + 1
    pinHash = state.pinHash
  }

  saveState(stateDir, state)

  const config: Config = {
    host: env('VIBEMOBILE_HOST') ?? '0.0.0.0',
    port: Number(env('PORT') ?? 3000),
    secret: state.secret,
    pinHash,
    authDisabled: pinHash === null,
    sessionTtlMs: Number(env('VIBEMOBILE_SESSION_TTL_MS') ?? 7 * 24 * 60 * 60 * 1000),
    sessionVersion: state.sessionVersion ?? 0,
    workspaceRoots,
    codex: {
      attachUrl: env('CODEX_WS_URL'),
      port: Number(env('CODEX_PORT') ?? 8788),
      bin: env('CODEX_BIN'),
    },
    stateDir,
    webDist: env('VIBEMOBILE_WEB_DIST') ?? path.resolve(root, 'apps/web/dist'),
    trustProxy: boolEnv('VIBEMOBILE_TRUST_PROXY'),
    terminal: {
      enabled: env('VIBEMOBILE_TERMINAL') !== 'off',
      shell: env('VIBEMOBILE_SHELL') ?? defaultShell(),
      idleTimeoutMs: Number(env('VIBEMOBILE_TERMINAL_IDLE_MS') ?? 30 * 60 * 1000),
    },
    logLevel: (env('VIBEMOBILE_LOG') as Config['logLevel']) ?? 'info',
    ...overrides,
  }

  return config
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    // PowerShell is the only shell guaranteed present on a stock Windows box;
    // git-bash and WSL are both optional installs.
    return process.env.COMSPEC?.toLowerCase().includes('powershell') ? process.env.COMSPEC : 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/**
 * The auto-generated PIN, only available on the run that created it. Printed
 * once at startup so the operator can pair a phone.
 */
export function getGeneratedPin(stateDir: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    return raw?.generatedPin
  } catch {
    return undefined
  }
}
