/**
 * Per-session memory of what a session was last driven with — shared by both
 * providers, because both have the same gap.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * A session's controls are decided per turn and then forgotten, and neither
 * backing store can re-derive them afterwards.
 *
 * The Claude SDK reports a transcript, a title and timestamps, and nothing
 * about how the session was configured. Its JSONL is no help either — it
 * records the RESOLVED model name (`claude-opus-5`), never the alias the user
 * actually picked (`opus`). So the model lived only in the in-memory
 * `LiveSession` and the effort nowhere at all: leave a session, come back, and
 * both controls were at their defaults — the effort on every reload, the model
 * whenever the server had restarted in between.
 *
 * Codex does better for the model (the app-server's thread record carries it),
 * but not for permissions: `Thread` has no sandbox/approvalPolicy field, and
 * every summary is built from `thread/read`, which reports only what `Thread`
 * holds. `thread/start` and `thread/resume` DO return both, but the generated
 * types label them "Legacy … retained for compatibility. Experimental clients
 * should prefer `activePermissionProfile`" — whether they mean the thread's
 * current policy or its creation defaults is not something to bet the picker
 * on, so the pair is remembered here instead.
 *
 * ── Two vocabularies, deliberately ──────────────────────────────────────────
 * Each provider stores the value it actually drives the session with, in its
 * own fields:
 *
 *  - Claude: `model`, `effort`, `permissionMode` (the SDK's mode).
 *  - Codex: `model`, `effort`, `sandbox`, `approvalPolicy` (the app-server's).
 *
 * NOT normalised into one shape, because the collapse is lossy: Claude's
 * `permissionModeFor` (`claude/permission.ts`) turns `approvalPolicy: 'never'`
 * alone into `bypassPermissions`, so routing a Codex pair through the web app's
 * three-card ladder would report `(read-only, never)` back as 完全访问. Codex
 * must report the two fields it sent, independently.
 *
 * ── The permission level, specifically ──────────────────────────────────────
 * It is the one control in this project that can hand a phone unattended access
 * to the machine (see `claude/permission.ts`), and it is remembered for the same
 * reason the rest is: it is a choice the user made about this session, and
 * losing it re-opens the authorisation sheets they had just opted out of —
 * reported from a real phone as "I set 完全访问, why do the sheets keep coming
 * back". Three things keep the restore from being quiet:
 *
 *  - the picker renders 完全访问 in the warning colour with a warning glyph for
 *    as long as the session is on it, and it is seeded from this value, so the
 *    state is on screen the entire time the user could send a message;
 *  - `resumeSession` emits a notice naming the session when it restores an
 *    unattended level, so an operator reading the service log sees it too;
 *  - what is stored is what THIS backend sent, so it never claims to know what
 *    another client (a desktop Codex, say) has driven the session with since.
 *    The picker's value is a starting point the next message re-asserts, not a
 *    claim about the machine's current state.
 *
 * A NEW session still starts on the safe pair: the composer's default is
 * 按需确认 and nothing here changes that. This only stops an existing session
 * from forgetting what it was told.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * One small JSON object per provider in the state directory, keyed by session
 * id. Writes happen once per turn, so the file is tiny and always rewritten
 * wholesale — no seeking, no partial updates. A corrupt or unreadable file is
 * treated as empty rather than fatal: losing the memory of a model choice must
 * never stop a turn from running.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ApprovalPolicy, SandboxMode } from '@vibemobile/protocol'

export interface SessionPrefs {
  model?: string
  effort?: string
  /**
   * Claude only: the SDK mode this session was last driven with.
   *
   * Typed as a plain `string` because this file now serves both providers and
   * must not import the Claude SDK. `claude/permission.ts` narrows it back with
   * `asPermissionMode()` before it can reach `Options` — an unknown value
   * becomes the safe default there rather than being executed.
   */
  permissionMode?: string
  /**
   * Codex only: the pair last sent to `turn/start`, verbatim.
   *
   * Both are stored because the app-server keeps them independent — a turn may
   * carry one without the other, and the other one then still applies.
   */
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  /**
   * Claude only: hidden from the session list.
   *
   * Deliberately asymmetric with Codex, which keeps this in the app-server and
   * learns it from `thread/archive` / `thread/unarchive` instead. Storing it
   * for Codex too would give the same fact two sources that can disagree, and
   * there is no way to write it back to the app-server from here.
   */
  archived?: boolean
  /**
   * Pinned above the "recently touched" order. Both providers store this —
   * neither backend has the concept, so there is nothing to defer to.
   */
  pinned?: boolean
  /** Last write, used only to cap the file's size. */
  updatedAt: number
}

/**
 * How many sessions to remember. The point of the cap is that the file must
 * not grow without bound as sessions accumulate; it is far above what anyone
 * reopens, so eviction is not observable in practice.
 *
 * It IS observable for `archived` and `pinned`, which are the two fields here
 * that outlive the session's own activity: a session evicted from this file
 * silently comes back unarchived and unpinned. Accepted rather than fixed — a
 * per-field store, or eviction that skips flagged entries, would need its own
 * lifetime rules for a case (501 remembered sessions) nobody reaches.
 */
const MAX_ENTRIES = 500

type File = Record<string, SessionPrefs>

export class SessionPrefsStore {
  #file: string | null
  #log?: (line: string) => void
  #entries: File | null = null
  /**
   * Whether `#entries` reflects what the file actually holds.
   *
   * False means the file exists but could not be read, so the in-memory map is
   * a stand-in rather than a copy. Writing it back would replace every other
   * session's remembered choices with whatever has been set since — which is
   * the exact loss (`permissionMode`, in particular) this file exists to
   * prevent — so `#save` refuses while this is false.
   */
  #readable = true

  /**
   * `file` omitted (or `stateDir` absent in the provider's options) keeps the
   * store purely in memory. That is what unit tests get: no temp files, and no
   * way for a test to inherit a developer's real preferences.
   */
  constructor(file?: string, log?: (line: string) => void) {
    this.#file = file ?? null
    this.#log = log
  }

  get(sessionId: string): SessionPrefs | undefined {
    return this.#load()[sessionId]
  }

  /** Merge a patch in. `undefined` values are ignored, so callers can pass through. */
  set(
    sessionId: string,
    patch: {
      model?: string
      effort?: string
      permissionMode?: string
      sandbox?: SandboxMode
      approvalPolicy?: ApprovalPolicy
      archived?: boolean
      pinned?: boolean
    },
  ): void {
    const next: Partial<SessionPrefs> = {}
    if (patch.model !== undefined) next.model = patch.model
    if (patch.effort !== undefined) next.effort = patch.effort
    if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode
    if (patch.sandbox !== undefined) next.sandbox = patch.sandbox
    if (patch.approvalPolicy !== undefined) next.approvalPolicy = patch.approvalPolicy
    if (patch.archived !== undefined) next.archived = patch.archived
    if (patch.pinned !== undefined) next.pinned = patch.pinned
    if (Object.keys(next).length === 0) return

    const entries = this.#load()
    entries[sessionId] = { ...entries[sessionId], ...next, updatedAt: Date.now() }
    this.#prune(entries)
    this.#save(entries)
  }

  /** Drop a deleted session. Without this the file outlives its sessions. */
  forget(sessionId: string): void {
    const entries = this.#load()
    if (!(sessionId in entries)) return
    delete entries[sessionId]
    this.#save(entries)
  }

  /**
   * Carry a session's choices to its fork.
   *
   * A fork is a copy of the conversation, so it should start on what that
   * conversation was using — the backing store copies the transcript but none
   * of the settings. That includes the permission level, deliberately: forking
   * a session that was on 完全访问 and landing in one that is not would be the
   * same surprise this file exists to remove. The picker shows the inherited
   * level, so it is still a decision the user can see and change before sending
   * anything.
   *
   * `archived` and `pinned` are deliberately NOT carried, which is the opposite
   * of how the fields above read at first glance. They are not "how to drive
   * this conversation" — they are how its row is filed in a list — and the fork
   * is a new conversation the user just asked for by tapping "创建副本继续".
   * Inheriting `archived` in particular would create a session that is
   * immediately invisible, which is the one outcome of that button a user
   * cannot recover from on a phone. `pinned` is simply a claim nobody made.
   */
  copy(fromSessionId: string, toSessionId: string): void {
    const from = this.#load()[fromSessionId]
    if (!from) return
    this.set(toSessionId, {
      model: from.model,
      effort: from.effort,
      permissionMode: from.permissionMode,
      sandbox: from.sandbox,
      approvalPolicy: from.approvalPolicy,
    })
  }

  // ------------------------------------------------------------------ disk

  #load(): File {
    // While the last read failed the cached map is a stand-in, not a copy, so
    // keep retrying: a one-off EACCES or EBUSY must not disable persistence for
    // the rest of the process's life.
    if (this.#entries && this.#readable) return this.#entries
    if (!this.#file) {
      if (!this.#entries) this.#entries = {}
      return this.#entries
    }

    // Anything set while the file was unreadable is newer than what is on disk.
    const held = this.#entries

    // The read and the parse are separated on purpose: they mean different
    // things. Unreadable *bytes* are corrupt content, which is safe to discard
    // and replace. A failed *read* is a property of the environment, and there
    // the file's real contents are unknown — so the empty map must not be
    // cached as if it were them.
    let raw: string
    try {
      raw = fs.readFileSync(this.#file, 'utf8')
    } catch (err) {
      // ENOENT on the first run is the normal case, not a warning.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#log?.(`session prefs unreadable, starting empty: ${(err as Error).message}`)
        this.#readable = false
      }
      this.#entries = held ?? {}
      return this.#entries
    }

    let onDisk: File = {}
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        onDisk = parsed as File
      } else {
        this.#log?.('session prefs unreadable, starting empty: not a JSON object')
      }
    } catch (err) {
      this.#log?.(`session prefs unreadable, starting empty: ${(err as Error).message}`)
    }

    this.#entries = held ? { ...onDisk, ...held } : onDisk
    this.#readable = true
    return this.#entries
  }

  #prune(entries: File): void {
    const ids = Object.keys(entries)
    if (ids.length <= MAX_ENTRIES) return
    // Oldest write wins the eviction. Ids are opaque, so `updatedAt` is the
    // only ordering that means anything.
    ids
      .sort((a, b) => (entries[a].updatedAt ?? 0) - (entries[b].updatedAt ?? 0))
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => {
        delete entries[id]
      })
  }

  #save(entries: File): void {
    if (!this.#file) return
    if (!this.#readable) {
      // Writing now would replace every other session's remembered choices with
      // whatever has been set since the read failed. Losing this one write is
      // the smaller loss by far, and the next read that succeeds resumes.
      this.#log?.('could not persist session prefs: the existing file could not be read')
      return
    }
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      // Written through a temp file and renamed: this runs on every turn, so a
      // crash mid-write would otherwise leave a truncated JSON that costs the
      // user every remembered choice at once.
      const tmp = `${this.#file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.#file)
    } catch (err) {
      // A read-only state directory must not fail a turn. Preferences are the
      // least important thing this provider does.
      this.#log?.(`could not persist session prefs: ${(err as Error).message}`)
    }
  }
}
