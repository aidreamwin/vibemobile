/**
 * AgentProvider implementation backed by the Claude Agent SDK.
 *
 * This is the only file that knows both worlds: it drives `query()` and emits
 * normalized AgentEvents. Nothing above this layer changes.
 *
 * ── Why this provider uses the SDK, when Codex could not ─────────────────────
 * The project bypassed `@openai/codex-sdk` for app-server JSON-RPC because that
 * SDK structurally discards delta notifications, leaving only whole messages.
 * The Claude SDK is not like that: with `includePartialMessages` it emits real
 * per-token deltas (measured: 1252 of them across one turn). So the direct SDK
 * is the correct choice here, and none of Codex's transport work is needed.
 *
 * ── Session model: one subprocess per turn ──────────────────────────────────
 * `createSession` mints a UUID locally and passes it as `options.sessionId` on
 * the first turn; every later turn passes `options.resume`. No subprocess
 * outlives the turn that started it. Because the `Query` object lives in THIS
 * process and not in any browser connection, a phone that disconnects or
 * reloads cannot affect a running turn — the architectural half of that
 * requirement is free. The user-visible half (a reload must still show the
 * turn running, with a working stop button and any pending approval) is served
 * by `resumeSession` replaying live state and `getTranscript` appending the
 * in-flight turn.
 *
 * ── A deliberate gap versus Codex ───────────────────────────────────────────
 * Claude has no equivalent of Codex's "already has an active writer" error, so
 * we cannot detect that the same session is being driven by a desktop CLI at
 * the same time. We can only prevent OUR OWN double-attach. The upshot is that
 * `Chat.tsx`'s "session in use" read-only state never triggers for Claude —
 * not because the case cannot happen, but because it cannot be seen.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  deleteSession as sdkDeleteSession,
  forkSession as sdkForkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions as sdkListSessions,
  query,
  renameSession as sdkRenameSession,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentEvent,
  AgentInput,
  AgentItem,
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequest,
  ModelInfo,
  Project,
  SandboxMode,
  SessionStatus,
  SessionSummary,
  Transcript,
  TranscriptTurn,
} from '@vibemobile/protocol'
import { UnknownApprovalError } from '../providers/types.js'
import type { AgentProvider, CreateSessionOptions, ListSessionsOptions, ProviderProbe } from '../providers/types.js'
import { pageTurnsByItems } from '../providers/page.js'
import { readGitInfo } from '../providers/git.js'
import { ClaudeEventMapper } from './mapClaudeEvents.js'
import { toolDisplayTitle } from './mapUtils.js'
import { SessionPrefsStore } from '../providers/sessionPrefs.js'
import { capImages, MAX_PER_MESSAGE, ImageStore } from '../images/store.js'
import { ASK_USER_TOOL, answersFor, questionsFrom } from './askUser.js'
// The ladder itself lives next door, with its own unit test: see
// `claude/permission.ts` for the card↔mode table and why it is pure.
import { asPermissionMode, needsDangerousAck, permissionModeFor, permissionOptionsFor } from './permission.js'
import {
  autoCompactWindowFor,
  claudeConfigDir,
  configDir,
  DEFAULT_EFFORT,
  effortLevel,
  guessedContextWindowForModel,
  isAuthenticated,
  label,
  normalizePath,
  sdkVersion,
  withTimeout,
} from './runtime.js'
import { buildTurns, MAX_CURSOR_SKIP, readTranscriptMessages, UUID_RE } from './transcript.js'
import { TurnInput } from './turnInput.js'

export interface ClaudeProviderOptions {
  /** Workspace roots the agent may operate in. First entry is the default. */
  workspaceRoots: string[]
  /**
   * Where to remember each session's model and effort. Omitted keeps them in
   * memory only, which is what tests want — see `sessionPrefs.ts` for why the
   * Claude side needs this at all when Codex does not.
   */
  stateDir?: string
  onLog?: (line: string) => void
  /**
   * For the few lines an operator should see at the default log level. `onLog`
   * is a diagnostic firehose — it carries the CLI's stderr straight through —
   * so the deployment routes it to `debug`, which means anything written there
   * is invisible unless someone opted into `VIBEMOBILE_LOG=debug`. Restoring a
   * session that may act unattended is not that kind of message.
   */
  onNotice?: (line: string) => void
}

// ------------------------------------------------------------------- state

interface PendingApproval {
  requestId: string
  sessionId: string
  turnId: string
  toolName: string
  input: Record<string, unknown>
  suggestions: unknown
  /**
   * The CLI's `tool_use` id, which is what the transcript card is keyed by
   * (`claude:tool:<toolUseId>`).
   *
   * Kept separately from `requestId` because the two are not the same value:
   * `requestId` prefers the callback's own `requestId` when the CLI supplies
   * one, so the sheet's `itemId` used to point at a card that does not exist.
   */
  toolUseId?: string
  resolve: (result: PermissionResult | null) => void
  /** Detaches the abort listener once the approval is settled. */
  detach: () => void
}

interface PendingPush {
  turnId: string
  commandUuid: string
  input: AgentInput[]
  turnInput: AgentInput[]
}

interface LiveSession {
  id: string
  cwd: string
  title: string | null
  model: string | null
  /**
   * The model's context window, learned from the last result's `modelUsage`.
   *
   * Cleared when the model changes: a window observed for one model must not
   * size the compaction budget of another. Until the first result of a turn
   * arrives there is no value, and the CLI's own policy applies.
   */
  contextWindow?: number
  /** Reasoning effort the user picked, or null for the model's default. */
  effort: string | null
  permissionMode: PermissionMode
  createdAt: number
  updatedAt: number
  status: SessionStatus
  mapper: ClaudeEventMapper
  /** The turn currently running, or null when nothing is in flight. */
  run: {
    turnId: string
    commandUuid: string
    query: Query
    interrupted: boolean
    /**
     * The open stdin stream for this turn's subprocess. `steer` pushes into it
     * so the CLI can fold the message into the running turn.
     */
    input: TurnInput
    /** False once a `result` frame lands: no more messages are accepted. */
    accepting: boolean
  } | null
  /**
   * The newest turn, kept after it ends so the transcript can render it.
   *
   * This cannot be derived from `run`. `turn.completed` is emitted from inside
   * the frame loop while the subprocess is still draining, and the CLI's JSONL
   * lags the turn it records — so right after a turn there is a window where
   * the turn is over but not yet on disk, and a reload in that window would
   * find it in neither place. Tracking the turn itself, plus the `commandUuid`
   * that marks where the replay must stop, closes that window.
   */
  lastTurn: {
    turnId: string
    commandUuid: string
    status: TranscriptTurn['status']
    /**
     * When the prompt was accepted. Kept separately from `updatedAt`, which is
     * bumped by every frame and is therefore the last activity, not the start.
     */
    startedAt: number
    completedAt: number | null
  } | null
  /** Turns pushed while another was running; each gets its own subprocess. */
  pending: PendingPush[]
  approvals: Map<string, PendingApproval>
  /** True once a subprocess has been started for this session, ever. */
  started: boolean
  /** True once a `system:init` frame has proven the CLI came up. */
  sawInit: boolean
  /**
   * The CLI's slash commands, as published by `system:init`.
   *
   * Per session rather than per provider even though the CLI's list is global:
   * a session that has never run a turn has none to show, and the composer only
   * ever asks about the session it is in. Kept after the turn ends so
   * `#replayLiveState` can hand it back to a page that reloaded.
   */
  commands: string[]
}

const ATTENTION: SessionStatus[] = ['waitingApproval', 'waitingInput']

// ------------------------------------------------------------- the provider

export class ClaudeProvider extends EventEmitter implements AgentProvider {
  readonly id = 'claude'
  readonly displayName = 'Claude Code'

  #roots: string[]
  #onLog?: (line: string) => void
  #onNotice: (line: string) => void
  #sessions = new Map<string, LiveSession>()
  /**
   * Session id -> the CLI's JSONL transcript for it.
   *
   * A session's file never moves, so this is resolved once and re-stat'ed on
   * every use (the size is what tells `getTranscript` whether the cheap tail
   * path applies). A stale path is dropped and resolved again.
   */
  #sessionFiles = new Map<string, string>()
  /**
   * The model and effort each session was last driven with. Nothing else
   * remembers them: see `sessionPrefs.ts`.
   */
  #prefs: SessionPrefsStore
  /**
   * Cache of the pictures a user attached, or undefined without a `stateDir`
   * (tests, one-shot scripts) — in which case bubbles simply carry no images.
   *
   * A separate instance from the image route's, and safe because the class
   * holds no in-memory state (see `images/store.ts`).
   */
  #images?: ImageStore
  /** Learned from the first `system:init`; until then probe reports the SDK's. */
  #cliVersion: string | null = null
  /**
   * Catalogue alias -> resolved model name, from `listModels()`.
   *
   * Used only to guess a first-turn context window (see
   * `guessedContextWindowForModel`). The authoritative window still comes from
   * `modelUsage.contextWindow` once a turn has run.
   */
  #resolvedModels = new Map<string, string>()
  #started = false

  constructor(opts: ClaudeProviderOptions) {
    super()
    this.#roots = opts.workspaceRoots
    this.#onLog = opts.onLog
    // Falls back to the log line so a caller that only wired `onLog` still
    // receives it — the notice must not be droppable by omission.
    this.#onNotice = opts.onNotice ?? ((line) => this.#log(line))
    this.#prefs = new SessionPrefsStore(
      opts.stateDir ? path.join(opts.stateDir, 'claude-sessions.json') : undefined,
      opts.onLog,
    )
    this.#images = opts.stateDir ? new ImageStore(path.join(opts.stateDir, 'images'), opts.onLog) : undefined
  }

  /**
   * Store the images of one outgoing message and return their tokens, in the
   * order they were attached.
   *
   * Called BEFORE `beginTurn`, and that order is load-bearing: the mapper keeps
   * the item it builds for the whole life of the session (it is the live replay
   * source), so a raw `data:` URL handed to it would sit in memory until the
   * session was closed.
   *
   * Rejected images are simply absent from the result. Sending a message must
   * never fail because one of its pictures was unreadable.
   */
  #storeImages(input: AgentInput[]): string[] {
    const store = this.#images
    if (!store) return []
    const tokens: string[] = []
    for (const part of input) {
      if (part.type !== 'image') continue
      if (tokens.length >= MAX_PER_MESSAGE) break
      const token = store.put(part.url)
      if (token) tokens.push(token)
    }
    return tokens
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.#started = true
  }

  async stop(): Promise<void> {
    this.#started = false
    for (const session of this.#sessions.values()) {
      // Settle every outstanding approval first: a `canUseTool` promise that
      // never resolves keeps the CLI's event loop alive and the process will
      // not exit.
      this.#settleApprovals(session, null, 'The VibeMobile server shut down.')
      if (session.run) {
        // `close()` is synchronous — it sends the child its stdin EOF and
        // returns; the process itself exits afterwards. So there is nothing to
        // await here, and it would be wrong to pretend otherwise to look tidy.
        //
        // The turn's child is therefore not *reaped* by this call, and the
        // SIGINT handler does exit as soon as `app.close()` resolves. That is
        // survivable rather than ideal: exiting closes the parent's end of the
        // child's stdin pipe too, so the child still sees EOF and goes on its
        // own — it just is not waited for. Waiting would mean holding the whole
        // server's shutdown open on a ~230 MB child, which is worse.
        try {
          session.run.query.close()
        } catch {
          // Already gone.
        }
        session.run = null
      }
      session.mapper.finish('interrupted', 'The VibeMobile server shut down.')
    }
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }

  #emit(event: AgentEvent): void {
    this.emit('event', event)
  }

  #log(line: string): void {
    this.#onLog?.(line)
    this.emit('log', line)
  }

  // --------------------------------------------------------------- probing

  /**
   * Health and auth, without running a turn.
   *
   * `initializationResult()` answers on a query whose prompt stream is empty —
   * measured to emit no frames and make no API call — so this costs a process
   * spawn and nothing else. We never claim `authenticated` before the CLI has
   * actually answered.
   */
  async probe(): Promise<ProviderProbe> {
    try {
      const init = await this.#readInit()
      if (!init) {
        return {
          id: this.id,
          displayName: this.displayName,
          available: false,
          authenticated: false,
          detail: 'the Claude CLI did not respond to initialization',
        }
      }
      const account = (init as any).account
      const authenticated = isAuthenticated(account)
      return {
        id: this.id,
        displayName: this.displayName,
        available: true,
        version: this.#cliVersion ?? `sdk ${sdkVersion()}`,
        authenticated,
        detail: authenticated
          ? account?.apiProvider
            ? `api: ${account.apiProvider}`
            : undefined
          : `no credentials (tokenSource: none) in ${configDir()} — the CLI is using its built-in model catalogue`,
      }
    } catch (err) {
      return {
        id: this.id,
        displayName: this.displayName,
        available: false,
        authenticated: false,
        detail: (err as Error).message,
      }
    }
  }

  /**
   * The model aliases the CLI accepts, labelled with what they actually resolve
   * to.
   *
   * Both halves matter. `value` is the alias you must pass back (`opus`,
   * `haiku`, …) — the resolved name is NOT accepted as an option. But the alias
   * means nothing on its own: on this machine `default` resolves to
   * `deepseek-v4.1-flash[1m]`, which the local proxy rejects outright, so a
   * list showing only "Default (recommended)" would send the user straight into
   * a failed turn with no clue why. Appending the resolved name makes that
   * visible before they pick.
   */
  async listModels(): Promise<ModelInfo[]> {
    const init = await this.#readInit()
    const models = (init as any)?.models ?? []
    this.#resolvedModels.clear()
    return models.map((m: any) => {
      this.#resolvedModels.set(String(m.value), String(m.resolvedModel ?? m.value))
      return {
        id: m.value,
        displayName: label(m),
        efforts: m.supportsEffort ? m.supportedEffortLevels : undefined,
        // The CLI reports no per-model default, so this is the documented one for
        // the whole session. See DEFAULT_EFFORT.
        defaultEffort: m.supportsEffort ? DEFAULT_EFFORT : undefined,
      }
    })
  }

  /** Spawn a throwaway query purely to ask it about itself, then close it. */
  async #readInit(): Promise<unknown | null> {
    const q = query({ prompt: emptyStream(), options: this.#baseOptions(process.cwd()) })
    try {
      return await withTimeout(q.initializationResult(), 60_000)
    } finally {
      try {
        q.close()
      } catch {
        // Nothing to close.
      }
    }
  }

  async listProjects(): Promise<Project[]> {
    return Promise.all(
      this.#roots.map(async (root): Promise<Project> => {
        const git = await readGitInfo(root)
        return {
          id: root,
          name: path.basename(root) || root,
          path: root,
          isGitRepo: git.isRepo,
          gitBranch: git.branch,
        }
      }),
    )
  }

  // -------------------------------------------------------------- sessions

  /**
   * Every session the CLI knows about, across all project directories.
   *
   * `dir` is deliberately NOT passed to `listSessions`/`getSessionMessages`:
   * measured on this machine, supplying it returns zero rows even for a
   * session that plainly exists, because the project key is derived from the
   * CLI's own (8.3 short) view of the path and neither the short nor the
   * expanded spelling matches. Omitting it searches all projects — a few
   * directories, so the cost is irrelevant next to being wrong.
   */
  async listSessions(opts: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const wanted = opts.cwd ? normalizePath(opts.cwd) : null
    // Folded once, not per row: `toLowerCase()` on the needle inside the loop
    // would allocate for every session in the list.
    const needle = opts.search?.trim().toLowerCase() ?? ''
    const cap = opts.limit ?? 50

    // `limit` is pushed down to the SDK, but only as a page size: the filters
    // below (cwd / search / archived) run AFTER the SDK has sorted by mtime, so
    // a page can contain fewer usable rows than it has entries. Asking for all
    // sessions instead was measured at 327 ms for 3,000 transcripts versus
    // 26 ms for a `limit`-ed page — the SDK opens the head and tail of every
    // file it is asked about, and the page path stops after enough rows.
    //
    // Doubling, not a fixed over-fetch: the first page is enough for the
    // unfiltered list (the common case), while a search matching a minority of
    // old sessions still ends up scanning everything — but only the sessions
    // before its last hit, and only when the user asked for that search.
    let page = Math.max(cap * 2, 100)
    for (;;) {
      const infos = await sdkListSessions({ limit: page })
      const rows: SessionSummary[] = []
      for (const info of infos) {
        if (wanted && normalizePath(info.cwd ?? '') !== wanted) continue
        // Summaries are built before the filters, not after, because two of the
        // three things being filtered on — `archived` and `pinned` — live in the
        // prefs file and only reach a summary through `#summaryFromInfo`.
        const summary = this.#summaryFromInfo(info)
        // Arguably the one place this provider and Codex differ observably:
        // archiving here is a flag we keep ourselves, so the filter is ours too,
        // while Codex asks the app-server for the archive. Same contract either
        // way — the caller gets the archived set, or everything else.
        if (Boolean(summary.archived) !== Boolean(opts.archived)) continue
        // Matched against the title the row actually shows, so a hit is a hit on
        // something the user can see. Not the transcript: nothing here has been
        // read into memory, and the SDK has no search parameter to push it down
        // to. See `ListSessionsOptions.search`.
        if (needle && !summary.title.toLowerCase().includes(needle)) continue
        rows.push(summary)
        // The cap is on rows RETURNED, so it is applied last — a limit applied
        // before the filters above would silently return short pages whenever a
        // search matched a minority of sessions.
        if (rows.length >= cap) break
      }
      // A page shorter than asked for means the SDK ran out of sessions; no
      // larger page can add rows the filters would accept.
      if (rows.length >= cap || infos.length < page) return rows.slice(0, cap)
      page *= 2
    }
  }

  /**
   * Locate the CLI's JSONL transcript for a session.
   *
   * The SDK exposes no "where is this file" call — `getSessionMessages` takes
   * only an id — so the tail path has to find the file the same way the SDK
   * does: under `<config>/projects/<project>/<id>.jsonl`. The project directory
   * names are the CLI's mangled cwd, which is why every project is searched
   * rather than deriving the name ourselves (and why `dir` is never passed to
   * the SDK either).
   *
   * Null means "not a local session file" (a session store, an id we do not
   * recognise, or a path that has gone away). The caller then falls back to
   * the SDK — which answers, but only with the current post-compaction
   * segment. That is a degraded transcript, not an equivalent one.
   */
  async #locateSessionFile(sessionId: string): Promise<{ file: string; size: number } | null> {
    // Ids reach here from a URL. Checking the UUID shape is what keeps a
    // `../` id from turning the tail reader into an arbitrary-file reader.
    if (!UUID_RE.test(sessionId)) return null

    const cached = this.#sessionFiles.get(sessionId)
    if (cached) {
      try {
        const stat = await fs.promises.stat(cached)
        if (stat.isFile()) return { file: cached, size: stat.size }
      } catch {
        // Removed or moved; fall through and search again.
      }
      this.#sessionFiles.delete(sessionId)
    }

    const projects = path.join(claudeConfigDir(), 'projects')
    let names: string[]
    try {
      names = await fs.promises.readdir(projects)
    } catch {
      return null
    }
    let best: { file: string; size: number; mtimeMs: number } | null = null
    for (const name of names) {
      const file = path.join(projects, name, `${sessionId}.jsonl`)
      try {
        const stat = await fs.promises.stat(file)
        if (!stat.isFile()) continue
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { file, size: stat.size, mtimeMs: stat.mtimeMs }
        }
      } catch {
        // Not in this project directory.
      }
    }
    if (!best) return null
    this.#sessionFiles.set(sessionId, best.file)
    return { file: best.file, size: best.size }
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    const live = this.#sessions.get(sessionId)
    if (live) return this.#summaryFromLive(live)
    const info = await getSessionInfo(sessionId)
    return info ? this.#summaryFromInfo(info) : null
  }

  #summaryFromInfo(info: any): SessionSummary {
    const live = this.#sessions.get(info.sessionId)
    // A session that is not live — the list, or anything after a restart — has
    // no in-process state at all, so its model and effort come from the prefs
    // file. This is the branch that used to report `model: null` unconditionally
    // and made every reopened session look like it had never been configured.
    const remembered = this.#prefs.get(info.sessionId)
    return {
      // `customTitle` is the user's /rename; `summary` is the auto-generated
      // one, which is a far better list label than "Untitled".
      id: info.sessionId,
      provider: this.id,
      title: info.customTitle ?? info.summary ?? info.firstPrompt?.slice(0, 60) ?? 'Untitled',
      preview: info.firstPrompt ?? '',
      cwd: info.cwd ?? '',
      projectId: info.cwd ?? null,
      status: live?.status ?? 'idle',
      model: live?.model ?? remembered?.model ?? null,
      reasoningEffort: live?.effort ?? remembered?.effort ?? null,
      // All three fall back the same way: live state first, then what this
      // session was last told, then the default. The permission pair matters
      // most here — it is what seeds the phone's picker, and getting it wrong
      // is what silently downgraded a session on its next message.
      ...permissionOptionsFor(asPermissionMode(live?.permissionMode ?? remembered?.permissionMode)),
      createdAt: info.createdAt ?? info.lastModified ?? Date.now(),
      updatedAt: info.lastModified ?? Date.now(),
      needsAttention: ATTENTION.includes(live?.status ?? 'idle'),
      ...this.#filedAs(info.sessionId),
    }
  }

  #summaryFromLive(live: LiveSession): SessionSummary {
    return {
      id: live.id,
      provider: this.id,
      title: live.title ?? 'New session',
      preview: '',
      cwd: live.cwd,
      projectId: live.cwd,
      status: live.status,
      model: live.model,
      reasoningEffort: live.effort,
      ...permissionOptionsFor(live.permissionMode),
      createdAt: live.createdAt,
      updatedAt: live.updatedAt,
      needsAttention: ATTENTION.includes(live.status),
      ...this.#filedAs(live.id),
    }
  }

  /**
   * How a session is filed in the list, shaped for a `SessionSummary`.
   *
   * Both fields come from `sessionPrefs.ts` here, unlike Codex where only
   * `pinned` does: this backend has nowhere else to put an archive. Omitted
   * rather than written as `false` — an absent field already means "not
   * archived, not pinned" to every consumer, and these ride on every row of
   * every listing (see `SessionSummary.archived`).
   *
   * Read on every summary, including the live ones, because this is the only
   * source: a session pinned on the phone and then reopened has no other way to
   * report it, and a summary built without it is what makes a pin look like it
   * silently did nothing.
   */
  #filedAs(sessionId: string): Pick<SessionSummary, 'archived' | 'pinned'> {
    const stored = this.#prefs.get(sessionId)
    if (!stored) return {}
    const out: Pick<SessionSummary, 'archived' | 'pinned'> = {}
    if (stored.archived) out.archived = true
    if (stored.pinned) out.pinned = true
    return out
  }

  /**
   * Mint a session locally.
   *
   * Nothing is spawned here: the UUID becomes the CLI's session id on the first
   * turn, via `options.sessionId`. That is what keeps the "one subprocess per
   * turn" model from costing us a stable identity to route events by.
   */
  async createSession(opts: CreateSessionOptions): Promise<SessionSummary> {
    const id = randomUUID()
    const now = Date.now()
    const live: LiveSession = {
      id,
      cwd: opts.cwd,
      title: null,
      model: opts.model ?? null,
      // Creation has no effort picker; the first turn's composer supplies one.
      effort: null,
      permissionMode: permissionModeFor(opts.sandbox, opts.approvalPolicy),
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      mapper: this.#makeMapper(id),
      run: null,
      lastTurn: null,
      pending: [],
      approvals: new Map(),
      started: false,
      sawInit: false,
      commands: [],
    }
    this.#sessions.set(id, live)
    return this.#summaryFromLive(live)
  }

  /**
   * Attach to a session, or report on one already attached.
   *
   * In Codex this re-established a server-side subscription, so it was a real
   * operation. Here it is cheap and idempotent: sessions must be resumed by
   * `options.resume` on the NEXT turn, and a turn already in flight keeps
   * running regardless. Its real job is the reload case — when a turn is live,
   * replay `turn.started`, the status, and every item so far, so a client that
   * just reconnected renders the running turn instead of an empty transcript
   * with no stop button.
   */
  async resumeSession(sessionId: string): Promise<SessionSummary | null> {
    const existing = this.#sessions.get(sessionId)
    if (existing) {
      this.#replayLiveState(existing)
      return this.#summaryFromLive(existing)
    }

    const info = await getSessionInfo(sessionId)
    if (!info) return null
    const now = Date.now()
    const remembered = this.#prefs.get(sessionId)
    const live: LiveSession = {
      id: sessionId,
      cwd: info.cwd ?? this.#roots[0] ?? process.cwd(),
      title: info.customTitle ?? info.summary ?? null,
      // Read back from the prefs file, not reset. `resume` runs the next turn
      // on whatever this session was last driven with; losing that here was
      // why a restart put every session back on the CLI's default model.
      model: remembered?.model ?? null,
      effort: remembered?.effort ?? null,
      // Restored for the same reason the two above are, and it is the one that
      // was reported as a bug: a session set to 完全访问 came back on the
      // default pair, so the next message the phone sent downgraded it and the
      // approval sheets returned.
      permissionMode: asPermissionMode(remembered?.permissionMode),
      createdAt: info.createdAt ?? now,
      updatedAt: info.lastModified ?? now,
      status: 'idle',
      mapper: this.#makeMapper(sessionId),
      run: null,
      lastTurn: null,
      pending: [],
      approvals: new Map(),
      // The session already exists on disk, so the next turn must RESUME it.
      // Naming it again via `sessionId` would start a second, empty session
      // under an id that is already taken.
      started: true,
      sawInit: false,
      commands: [],
    }
    this.#sessions.set(sessionId, live)
    // Logged here and not in the summary builders: those also run for every
    // entry of every session list, and a line per row would be noise. This is
    // the one moment a session actually attaches, so it is the one moment the
    // restore is worth recording. See `sessionPrefs.ts` for why the permission
    // mode is remembered at all, and why the phone still shows it.
    if (needsDangerousAck(live.permissionMode)) {
      this.#onNotice(`session ${sessionId} resumed with ${live.permissionMode}: unattended tool calls`)
    }
    return this.#summaryFromLive(live)
  }

  /**
   * Re-emit what a freshly connected client needs to render the live turn.
   *
   * Emitted as ordinary events rather than a bespoke "snapshot" message so the
   * client's existing reducer handles it: `store.applyEvent` is idempotent for
   * every kind below, and approvals are keyed by requestId, so replaying them
   * to a client that already has them changes nothing.
   */
  #replayLiveState(session: LiveSession): void {
    for (const approval of session.approvals.values()) {
      this.#emit({
        kind: 'approval.requested',
        approval: this.#approvalPayload(approval),
      })
    }

    // Before the early return: the command list belongs to the session, not to
    // a running turn, and a page that reloads while the session is idle is
    // exactly the case that would otherwise lose the composer's menu.
    if (session.commands.length) {
      this.#emit({ kind: 'commands.updated', threadId: session.id, commands: session.commands })
    }

    if (!session.run) return
    const turnId = session.run.turnId
    this.#emit({ kind: 'turn.started', threadId: session.id, turnId })
    this.#emit({ kind: 'session.status', threadId: session.id, status: session.status })
    for (const item of session.mapper.itemsForTurn(turnId)) {
      this.#emit({ kind: 'item.completed', threadId: session.id, turnId, item })
    }
    if (session.mapper.retryNotice) this.#emit(session.mapper.retryNotice)
  }

  async forkSession(sessionId: string): Promise<SessionSummary> {
    const result = await sdkForkSession(sessionId)
    // Before the summary below, so the fork reports the model it inherited
    // instead of null. The SDK copies the transcript; it copies no settings.
    this.#prefs.copy(sessionId, result.sessionId)
    const info = await getSessionInfo(result.sessionId)
    return this.#summaryFromInfo({
      sessionId: result.sessionId,
      summary: info?.customTitle ?? info?.summary ?? 'Fork',
      lastModified: Date.now(),
      cwd: info?.cwd,
      createdAt: Date.now(),
    })
  }

  /**
   * Hide a session from the list, or bring it back.
   *
   * Nothing is asked of the CLI, because it has no concept of an archive and
   * the JSONL on disk is not ours to move: the whole implementation is one flag
   * in `sessionPrefs.ts`, and `listSessions` filters on it. (Codex does this
   * with `thread/archive` instead — the asymmetry is the app-server's, not a
   * choice made here.)
   *
   * Unarchiving is just the same call with `false`, which is what makes the
   * action undoable on this provider; the flag is never dropped, only flipped.
   * `deleteSession` is the one that forgets.
   */
  async archiveSession(sessionId: string, archived = true): Promise<void> {
    this.#prefs.set(sessionId, { archived })
  }

  /** Purely this app's state — see the note on `AgentProvider.pinSession`. */
  async pinSession(sessionId: string, pinned: boolean): Promise<void> {
    this.#prefs.set(sessionId, { pinned })
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await sdkRenameSession(sessionId, name)
    const live = this.#sessions.get(sessionId)
    if (live) live.title = name
  }

  async deleteSession(sessionId: string): Promise<void> {
    const live = this.#sessions.get(sessionId)
    if (live?.run) {
      try {
        live.run.query.close()
      } catch {
        // Already gone.
      }
    }
    this.#sessions.delete(sessionId)
    this.#prefs.forget(sessionId)
    // The on-disk session may not exist yet — a session created but never
    // messaged has no JSONL. That is not an error the user needs to see.
    try {
      await sdkDeleteSession(sessionId)
    } catch (err) {
      if (!/not found|no such file|ENOENT/i.test((err as Error).message)) throw err
    }
  }

  // ------------------------------------------------------------ transcript

  /**
   * Rebuild the conversation as turns.
   *
   * The SDK hands back a flat `SessionMessage[]`; `Transcript` wants turns, so
   * they are synthesised here.
   *
   * The newest turn is taken from live state rather than from disk, and the
   * replay is CUT where it begins (`sliceAt` = the uuid we stamped on its
   * push, which `result.user_message_uuid` was measured to echo back). Two
   * problems are solved by the same cut:
   *
   *  - the CLI appends to the JSONL as the turn runs, so mid-turn the blocks
   *    being streamed are already on disk and would render twice;
   *  - a replayed turn cannot know it was interrupted — a captured interrupt
   *    reported `subtype: 'success'`, `is_error: false` — so the live status is
   *    the only truthful one, and keeping the live copy is how the phone shows
   *    a stopped turn as stopped after a reload.
   *
   * When a turn has never run in this process there is no live state and the
   * replay stands alone, which is the case after a server restart.
   */
  async getTranscript(
    sessionId: string,
    opts: { limit?: number; cursor?: string; targetItems?: number } = {},
  ): Promise<Transcript | null> {
    const session = await this.getSession(sessionId)
    if (!session) return null

    const live = this.#sessions.get(sessionId)

    // The file reader pages by counting from the newest end, so the cursor is
    // just how many turns to skip. It is opaque to the route and the client;
    // an unrecognised value means "start over from the newest page" rather
    // than an error, which is also what a cursor minted before a restart or by
    // another build should degrade into.
    const cursor = /^c:(\d+)$/.exec(opts.cursor ?? '')
    const parsed = cursor ? Number(cursor[1]) : 0
    // Capped, not just parsed: the skip becomes the reader's prompt count, and
    // a digit string that overflows to Infinity would make it read the whole
    // JSONL. An absurd cursor starts over from the newest page, like an
    // unrecognised one.
    const skip = Number.isSafeInteger(parsed) && parsed <= MAX_CURSOR_SKIP ? parsed : 0

    // Always read the JSONL ourselves when it is on this machine. The SDK
    // cannot answer this: `getSessionMessages` reconstructs only the current
    // post-compaction chain at EVERY size (below 5 MB the old boundary roots
    // are disconnected from the newest leaf; above it the SDK explicitly takes
    // the buffer after the last boundary), and `includeSystemMessages` strips
    // the subtype/metadata before we could find the boundaries. The reader
    // also works backwards from the end, so it is the cheap path: the SDK
    // parses the whole file and was measured at 640 ms / ~280 MB heap for a
    // 200 MB session.
    const targetItems =
      opts.targetItems && Number.isFinite(opts.targetItems) && opts.targetItems > 0 ? Math.floor(opts.targetItems) : 0
    const limitTurns = opts.limit && opts.limit > 0 ? opts.limit : 0
    // The skipped turns are newer than this page and are still needed to reach
    // back far enough. One extra prompt for the live turn: its replay is cut
    // at `sliceAt`, so it does not count on its own.
    const liveExtra = live?.lastTurn ? 1 : 0

    const assemble = (messages: any[]) => {
      const built = buildTurns(messages, {
        sliceAt: live?.lastTurn?.commandUuid,
        images: this.#images,
      })
      if (!live?.lastTurn) return built
      // Compaction items are the one kind both sources can name: the replay id
      // is `claude:compaction:<uuid>` and the live mapper now uses the same
      // one, so a boundary that was written before `sliceAt` and also arrived
      // on the stream is kept once.
      const replayed = new Set(built.flatMap((turn) => turn.items.map((item) => item.id)))
      built.push({
        id: live.lastTurn.turnId,
        status: live.lastTurn.status,
        items: live.mapper.itemsForTurn(live.lastTurn.turnId).filter((item) => !replayed.has(item.id)),
        startedAt: live.lastTurn.startedAt,
        completedAt: live.lastTurn.completedAt,
        durationMs: null,
      })
      return built
    }

    let turns: TranscriptTurn[] | null = null
    let tailCut = false
    try {
      const located = await this.#locateSessionFile(sessionId)
      if (located && targetItems) {
        // The page is budgeted by items but cut on turn boundaries, and a turn
        // can be one card or several hundred. Start with one prompt and double
        // until the budget is met: reading `targetItems` prompts up front would
        // pull most of a 200 MB file whenever the newest turn already has
        // enough cards. Each turn carries at least one item, so `targetItems`
        // prompts is the upper bound; the sum of the re-reads stays within
        // ~2x the final window.
        let prompts = 1
        for (;;) {
          const read = await readTranscriptMessages(located.file, located.size, skip + prompts + liveExtra)
          tailCut = read.truncated
          turns = assemble(read.messages)
          const page = pageTurnsByItems(turns, targetItems, skip)
          if (page.items >= targetItems || !read.truncated || prompts >= targetItems) break
          prompts = Math.min(prompts * 2, targetItems)
        }
      } else if (located) {
        // No item budget: the old turn-count contract. No limit means "all of
        // it", which the reader answers by starting its window at `size`.
        const neededPrompts = limitTurns ? limitTurns + skip + liveExtra : Number.POSITIVE_INFINITY
        const read = await readTranscriptMessages(located.file, located.size, neededPrompts)
        tailCut = read.truncated
        turns = assemble(read.messages)
      }
    } catch {
      // File replaced or unreadable mid-read; the SDK still answers, scoped to
      // the current segment. A partial transcript beats none.
    }
    if (!turns) turns = assemble(await getSessionMessages(sessionId))

    // Counted from the end: `skip` drops the turns already on screen. With an
    // item budget the cut moves by whole turns until the budget is met; without
    // one it is a fixed number of turns. `start` is what says whether anything
    // older exists *within* the window; `tailCut` says whether the window
    // itself stopped short of the beginning of the transcript.
    let start: number
    let end: number
    if (targetItems) {
      ;({ start, end } = pageTurnsByItems(turns, targetItems, skip))
    } else if (limitTurns) {
      end = Math.max(0, turns.length - skip)
      start = Math.max(0, end - limitTurns)
    } else {
      start = 0
      end = turns.length
    }
    const limited = turns.slice(start, end)
    const hasMore = start > 0 || tailCut

    return {
      session,
      turns: limited,
      // No cursor for an empty page: the skip count points past everything we
      // can see (the transcript shrank, or the cursor came from another build),
      // and repeating it would make the client ask forever.
      nextCursor: hasMore && limited.length > 0 ? `c:${skip + limited.length}` : null,
      ...(hasMore ? { hasMore: true } : {}),
    }
  }

  // ----------------------------------------------------------------- turns

  async startTurn(
    sessionId: string,
    rawInput: AgentInput[],
    opts?: { model?: string; effort?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode },
  ): Promise<{ turnId: string }> {
    const session = this.#requireSession(sessionId)
    // Trimmed once, at the one point this provider's turns all funnel through,
    // so the CLI, the transcript's echo and the image store cannot disagree
    // about how many pictures the message had.
    const input = capImages(rawInput)
    // Truthy, not `!== undefined`, matching Codex: an empty value means "no
    // opinion, keep what this session is already on" rather than "clear it".
    // The composer sends `turnModel || undefined`, so a session that never
    // touched the picker does not overwrite a remembered choice with nothing.
    if (opts?.model) {
      if (opts.model !== session.model) session.contextWindow = undefined
      session.model = opts.model
    }
    if (opts?.effort) session.effort = opts.effort
    if (opts?.sandbox || opts?.approvalPolicy) {
      session.permissionMode = permissionModeFor(opts?.sandbox, opts?.approvalPolicy)
    }
    // Written here rather than on every frame: this is the one moment these
    // three are decided, and it costs one small file write per turn. The gate is
    // `opts`, not `session` — a turn that carried no opinion must not overwrite
    // what this session was told earlier with a value it happened to inherit.
    if (opts?.model || opts?.effort || opts?.sandbox || opts?.approvalPolicy) {
      this.#prefs.set(session.id, {
        model: session.model ?? undefined,
        effort: session.effort ?? undefined,
        permissionMode: session.permissionMode,
      })
    }

    const text = input
      .filter((i): i is { type: 'text'; text: string } => i.type === 'text')
      .map((i) => i.text)
      .join('\n\n')

    const commandUuid = randomUUID()
    const { turnId, started } = session.mapper.beginTurn(text, commandUuid, this.#storeImages(input))
    // Newest turn wins, queued or not: `getTranscript` appends exactly this
    // turn from live state and cuts the replay where it begins.
    session.lastTurn = { turnId, commandUuid, status: 'inProgress', startedAt: Date.now(), completedAt: null }
    session.updatedAt = Date.now()

    const push: PendingPush = { turnId, commandUuid, input, turnInput: input }
    if (started) {
      this.#spawnTurn(session, push)
    } else {
      // An explicit second `startTurn` means "another task", not "interject":
      // it waits for its own subprocess and its own turn. (The composer never
      // sends this while a turn runs — it sends `steer`, which folds into the
      // live stream instead; this path is for a client that missed that
      // distinction or raced the turn's end.)
      session.pending.push(push)
    }
    return { turnId }
  }

  async steer(sessionId: string, turnId: string, rawInput: AgentInput[]): Promise<void> {
    const session = this.#requireSession(sessionId)
    const input = capImages(rawInput)
    const text = input
      .filter((i): i is { type: 'text'; text: string } => i.type === 'text')
      .map((i) => i.text)
      .join('\n\n')
    const imageIds = this.#storeImages(input)

    // A live subprocess has an OPEN stdin stream (see `#spawnTurn`), so the
    // message can go into the turn that is already running. The CLI delivers
    // it to the model at the next boundary inside that turn; one `result`
    // closes both. A tool call already in flight is NOT cancelled — the model
    // only sees the message once that tool returns — which is the same
    // guarantee Codex's `turn/steer` gives.
    const run = session.run
    if (run?.accepting) {
      const steerUuid = randomUUID()
      const folded = session.mapper.interject(text, steerUuid, imageIds)
      if (folded.folded) {
        run.input.push(steerUuid, input)
        session.updatedAt = Date.now()
        return
      }
    }

    // No live stream: the result has landed, the process is between turns, or
    // it died. Queue the message as its own next turn, exactly as before.
    const commandUuid = randomUUID()
    const next = session.mapper.beginTurn(text, commandUuid, imageIds)
    session.lastTurn = {
      turnId: next.turnId,
      commandUuid,
      status: 'inProgress',
      startedAt: Date.now(),
      completedAt: null,
    }
    session.pending.push({ turnId: next.turnId, commandUuid, input, turnInput: input })
    // `session.run` may still be draining the previous turn's final frames. In
    // that case `#pump` starts this one from the consume loop's `finally`;
    // spawning here would overwrite `run` under the old process.
    if (next.started && !session.run) {
      const push = session.pending.pop()!
      this.#spawnTurn(session, push)
    }
    // `turnId` is deliberately unused rather than checked. It exists so a
    // client can name the turn it is steering, but a phone that steers a
    // heartbeat after the turn ended would then get an error instead of having
    // its message delivered — and delivering it is what the user meant.
  }

  async interrupt(sessionId: string, turnId: string): Promise<void> {
    const session = this.#requireSession(sessionId)
    const run = session.run

    if (!run) {
      // Nothing running: drop any queued turn for this id so the caller's
      // request still has a visible effect.
      session.pending = session.pending.filter((p) => p.turnId !== turnId)
      return
    }

    session.mapper.markInterrupted(run.turnId)
    try {
      await run.query.interrupt()
    } catch (err) {
      // If the process already died there is nothing to interrupt; the
      // consume loop's error path will close the turn.
      this.#log(`interrupt failed for ${sessionId}: ${(err as Error).message}`)
    }
    run.interrupted = true
  }

  /** Start the subprocess for one turn and pump its frames into the mapper. */
  #spawnTurn(session: LiveSession, push: PendingPush): void {
    const effort = effortLevel(session.effort)
    // The observed window is authoritative. Before the first result of a
    // resumed session there is none, so fall back to the catalogue's `[1m]`
    // marker; otherwise the CLI's own policy applies.
    const resolvedModel = this.#resolvedModels.get(session.model ?? 'default')
    const autoCompactWindow = autoCompactWindowFor(session.contextWindow ?? guessedContextWindowForModel(resolvedModel))
    const options: Options = {
      ...this.#baseOptions(session.cwd),
      // Keep auto-compaction explicitly on. The CLI's default is not reliable
      // for proxy models such as DeepSeek 1M: whether compaction is considered
      // enabled depends on the model catalogue the CLI has, and an unknown
      // model can reach the API's hard limit without ever compacting. Once a
      // result has told us the window, size the trigger with 20% headroom;
      // before that, leave the window to the CLI's own policy.
      settings: {
        autoCompactEnabled: true,
        ...(autoCompactWindow ? { autoCompactWindow } : {}),
      },
      permissionMode: session.permissionMode,
      // Straight through to the SDK's own control. Until this line existed the
      // picker was decorative on this provider: `opts.effort` was accepted by
      // `startTurn` and then read nowhere, so every turn ran on the model's
      // default while the phone showed the level the user had chosen.
      ...(effort ? { effort } : {}),
      ...(needsDangerousAck(session.permissionMode) ? { allowDangerouslySkipPermissions: true } : {}),
      // The first turn NAMES the session with the UUID we minted; every later
      // turn resumes it. Driving this off `started` rather than off frame
      // history matters: a session loaded from disk has no frames here but
      // must still resume.
      ...(session.started ? { resume: session.id } : { sessionId: session.id }),
      ...(session.model ? { model: session.model } : {}),
      // Passed unconditionally, including under 完全访问, where the SDK ignores
      // it and says so on stderr (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`): in
      // `bypassPermissions` every tool call is auto-approved before the callback
      // is consulted. Dropping it there would save that one warning line and
      // nothing else, at the cost of a second code path through the one place
      // in this app that hands a phone an unattended machine. The mode is
      // re-read per turn, so a turn that downgrades needs the callback in place
      // anyway.
      canUseTool: (toolName, toolInput, o) => this.#requestApproval(session, push.turnId, toolName, toolInput, o),
    }

    // The input stream stays OPEN for the whole turn. That is what gives this
    // provider mid-turn steering: `steer` pushes another user message into it
    // and the CLI folds that message into the running turn (one result). A
    // generator that yields once and closes — what this used to be — closes
    // the CLI's stdin immediately and makes that impossible.
    const input = new TurnInput()
    input.push(push.commandUuid, push.input)

    const q = query({ prompt: input, options })
    session.started = true
    session.run = {
      turnId: push.turnId,
      commandUuid: push.commandUuid,
      query: q,
      interrupted: false,
      input,
      accepting: true,
    }

    void (async () => {
      try {
        for await (const msg of q as AsyncGenerator<SDKMessage>) {
          if (msg.type === 'system' && (msg as any).subtype === 'init') {
            session.sawInit = true
            const version = (msg as any).claude_code_version
            if (version) this.#cliVersion = version
            this.#noteCommands(session, msg)
          }
          session.mapper.handle(msg)
          // The result ends this subprocess's one turn. Close stdin so the CLI
          // exits and `#pump` can start anything queued behind it; `accepting`
          // goes false first so a steer racing this frame is queued instead of
          // written into a stream that is about to end.
          if (msg.type === 'result' && session.run?.turnId === push.turnId) {
            session.run.accepting = false
            input.close()
          }
          session.updatedAt = Date.now()
        }
      } catch (err) {
        // A subprocess that dies mid-turn must still close its turn, or the
        // phone sits on "运行中" forever with a stop button that does nothing.
        this.#log(`claude turn failed for ${session.id}: ${(err as Error).message}`)
        session.mapper.finish('failed', (err as Error).message, push.turnId)
      } finally {
        // Idempotent after result/catch; a clean EOF without result is still a failure.
        session.mapper.finish('failed', '代理进程提前退出，未返回执行结果。', push.turnId)
        input.close()
        if (session.run?.turnId === push.turnId) session.run = null
        this.#settleApprovals(session, push.turnId, 'The turn ended before this was answered.')
        this.#pump(session)
      }
    })()
  }

  /**
   * Take the composer menu's contents off the `system:init` frame.
   *
   * `terminal_slash_commands` are subtracted and the SDK is explicit about why:
   * they are "bound to the local terminal (e.g. exit, statusline). Phone/remote
   * UIs should hide these from command menus". Measured here, that is
   * `doctor`, `color` and `reload-plugins` out of 46 — small, but it is the
   * difference between offering the phone a command that only makes sense on a
   * keyboard and not.
   *
   * Emitted on every init frame rather than only when the list changed: the
   * comparison would be against a list that is identical in the common case, and
   * a client that connected between two turns has nothing to compare against.
   */
  #noteCommands(session: LiveSession, init: any): void {
    const all: unknown = init?.slash_commands
    if (!Array.isArray(all)) return
    const terminal = new Set(Array.isArray(init?.terminal_slash_commands) ? init.terminal_slash_commands : [])
    const commands = all.filter((c): c is string => typeof c === 'string' && !terminal.has(c))
    session.commands = commands
    this.#emit({ kind: 'commands.updated', threadId: session.id, commands })
  }

  /** Start the next queued turn, if the previous one has finished. */
  #pump(session: LiveSession): void {
    if (session.run) return
    const next = session.pending.shift()
    if (!next) return
    this.#spawnTurn(session, next)
  }

  // ------------------------------------------------------------- approvals

  /**
   * Bridge `canUseTool` to the phone.
   *
   * The returned promise is what actually blocks the turn, so two things
   * matter beyond wiring the answer back:
   *  - `opts.signal` MUST be honoured. If the turn is interrupted or the
   *    process is shut down while the sheet is open, an unresolved promise
   *    leaves the CLI waiting and it will not exit.
   *  - `requestId` is the id the phone answers with, so it is what we key on.
   */
  #requestApproval(
    session: LiveSession,
    turnId: string,
    toolName: string,
    input: Record<string, unknown>,
    o: any,
  ): Promise<PermissionResult | null> {
    const requestId = String(o?.requestId ?? o?.toolUseID ?? randomUUID())

    return new Promise<PermissionResult | null>((resolve) => {
      const approval: PendingApproval = {
        requestId,
        sessionId: session.id,
        turnId,
        toolName,
        input,
        suggestions: o?.suggestions,
        toolUseId: typeof o?.toolUseID === 'string' ? o.toolUseID : undefined,
        resolve,
        detach: () => {},
      }
      // The abort signal fires when the turn ends while the user still has the
      // sheet open. It settles the callback through the same path as every
      // other teardown, so the sheet is taken down rather than left to be
      // replayed at the next connection.
      const onAbort = (): void => {
        if (!session.approvals.has(requestId)) return
        this.#settleApproval(session, approval, 'The turn ended before this was answered.')
      }
      o?.signal?.addEventListener?.('abort', onAbort, { once: true })
      approval.detach = (): void => o?.signal?.removeEventListener?.('abort', onAbort)

      session.approvals.set(requestId, approval)
      session.status = 'waitingApproval'
      session.mapper.noteAwaitingApproval()

      this.#emit({ kind: 'approval.requested', approval: this.#approvalPayload(approval) })
    })
  }

  /**
   * Deny one approval and tell the clients it is gone.
   *
   * The `approval.resolved` event is not optional bookkeeping. The hub keeps
   * its pending map — and re-serves it to every client that connects — until it
   * sees one, and the web sheet only comes down on it. Denying the callback
   * without emitting left a sheet on screen that could not be dismissed, came
   * back on every reload, and answered with a nack for the rest of the
   * process's life.
   */
  #settleApproval(session: LiveSession, approval: PendingApproval, message: string): void {
    session.approvals.delete(approval.requestId)
    approval.detach()
    approval.resolve({ behavior: 'deny', message })
    this.#emit({ kind: 'approval.resolved', threadId: session.id, requestId: approval.requestId })
  }

  /**
   * Settle every outstanding approval for a turn, or every one at all when
   * `turnId` is null.
   *
   * An approval denied here never passes through `answerApproval`, which is the
   * only other place that lifts a session out of `waitingApproval` — so without
   * the status reset the session would report `needsAttention` (and show the
   * badge on the list) for the rest of the process's life.
   */
  #settleApprovals(session: LiveSession, turnId: string | null, message: string): void {
    for (const approval of [...session.approvals.values()]) {
      if (turnId !== null && approval.turnId !== turnId) continue
      this.#settleApproval(session, approval, message)
    }
    if (session.status !== 'idle' && session.approvals.size === 0 && !session.run) {
      session.status = 'idle'
      this.#emit({ kind: 'session.status', threadId: session.id, status: 'idle' })
    }
  }

  #approvalPayload(approval: PendingApproval): ApprovalRequest {
    const { toolName, input } = approval
    const isFileTool = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(toolName)
    // A question is not a permission request. It arrives through the same
    // callback, but the answer is an option, not a verdict — so it gets its own
    // type, its own buttons, and the questions themselves carried structurally
    // for the sheet to render as a form. `askUser.ts` has the measurements.
    const questions = toolName === ASK_USER_TOOL ? questionsFrom(input) : undefined
    const type: ApprovalRequest['type'] = questions
      ? 'userInput'
      : toolName === 'Bash'
        ? 'command'
        : isFileTool
          ? 'fileChange'
          : 'other'

    // `title` came back undefined on the very first live probe (a Write), so it
    // is a suggestion, not a guarantee — always fall back to our own summary
    // rather than rendering an empty sheet header.
    const title =
      (typeof approval.suggestions === 'object' && (approval as any).title) ||
      toolDisplayTitle(toolName, input) ||
      toolName

    const detail =
      toolName === 'Bash'
        ? String(input?.command ?? '')
        : isFileTool
          ? String(input?.file_path ?? input?.notebook_path ?? '')
          : JSON.stringify(input, null, 2)

    return {
      requestId: approval.requestId,
      threadId: approval.sessionId,
      turnId: approval.turnId,
      // The tool_use id IS our item id suffix, so the approval sheet and the
      // transcript card point at the same thing without extra bookkeeping.
      itemId: `claude:tool:${approval.toolUseId ?? approval.requestId}`,
      type,
      title,
      // The form replaces the JSON dump rather than sitting under it.
      detail: questions ? undefined : detail,
      cwd: null,
      reason: null,
      // No `acceptForSession` for a question: "always allow this" is a rule
      // about a tool, and there is no rule to install — the next question is a
      // different question. The form sends `accept` with the choices attached.
      availableDecisions: questions
        ? ['accept', 'decline', 'cancel']
        : ['accept', 'acceptForSession', 'decline', 'cancel'],
      questions,
    }
  }

  async answerApproval(requestId: string, decision: ApprovalDecision, answers?: string[][]): Promise<void> {
    for (const session of this.#sessions.values()) {
      const approval = session.approvals.get(requestId)
      if (!approval) continue

      session.approvals.delete(requestId)
      approval.detach()

      const questions = questionsFrom(approval.input)
      const answer = questions ? answersFor(questions, answers) : null
      const accepting = decision === 'accept' || decision === 'acceptForSession'

      if (accepting && questions && !answer) {
        // Never fall through to `allow` here: an allowed question with no
        // answers is the original bug — the model is told the user did not
        // answer while the phone shows a tap that looked like it worked.
        approval.resolve({
          behavior: 'deny',
          message: 'The question was not answered from VibeMobile.',
        })
      } else if (accepting) {
        approval.resolve({
          behavior: 'allow',
          // The answer travels inside the input — that is the only channel the
          // tool reads. Everything else about the call is passed through as-is.
          updatedInput: answer ? { ...approval.input, answers: answer } : approval.input,
          // "accept for session" is exactly the SDK's permission-update path:
          // it supplied suggestions, and applying them is what makes the
          // choice stick instead of asking again for the same tool.
          ...(decision === 'acceptForSession' && approval.suggestions
            ? { updatedPermissions: approval.suggestions as any }
            : {}),
        })
      } else {
        approval.resolve({
          behavior: 'deny',
          message: decision === 'cancel' ? 'Cancelled from VibeMobile.' : 'Declined from VibeMobile.',
        })
      }

      session.status = 'working'
      session.mapper.noteApprovalResolved()
      this.#emit({ kind: 'approval.resolved', threadId: session.id, requestId })
      return
    }
    // Typed, not plain: the hub has to tell "this request is gone" (drop the
    // sheet everywhere) from "the answer failed to land" (keep it — the turn is
    // still blocked on it). See `UnknownApprovalError`.
    throw new UnknownApprovalError(requestId)
  }

  // --------------------------------------------------------------- helpers

  #baseOptions(cwd: string): Options {
    return {
      cwd,
      // The entire streaming design rests on this. Without it the SDK reports
      // whole messages only, and there is nothing for the phone to animate.
      includePartialMessages: true,
      // Claude Code's real system prompt and tool set, so the phone drives the
      // same agent the desktop does.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'default',
      stderr: (data: string) => this.#log(`[claude] ${data}`),
      // `env` is deliberately NOT set. That option REPLACES the subprocess
      // environment wholesale, and this machine authenticates through an
      // ANTHROPIC_BASE_URL proxy configured in ~/.claude/settings.json —
      // passing `env` would drop it and every turn would fail to authenticate.
    }
  }

  #makeMapper(sessionId: string): ClaudeEventMapper {
    return new ClaudeEventMapper({
      threadId: sessionId,
      emit: (event) => {
        const live = this.#sessions.get(sessionId)
        if (live) {
          if (event.kind === 'session.status') live.status = event.status
          // `modelUsage[*].contextWindow` is the only place the CLI publishes
          // the window it believes the model has. Keep the newest one so the
          // next turn's auto-compact budget is sized from the real model.
          if (event.kind === 'usage.updated' && event.usage.contextWindow) {
            live.contextWindow = event.usage.contextWindow
          }
          // `lastTurn` is created in `startTurn`/`steer`, where the turn id and
          // its command uuid are both in hand; here we only record how it
          // ended. Doing it the other way round would not work: `turn.started`
          // is emitted from inside `beginTurn`, before `startTurn` has anything
          // to store, and the mapper forgets its own uuid mapping the moment
          // the result lands.
          if (event.kind === 'turn.completed' && live.lastTurn?.turnId === event.turnId) {
            live.lastTurn = { ...live.lastTurn, status: event.status, completedAt: Date.now() }
          }
          live.updatedAt = Date.now()
        }
        this.#emit(event)
      },
    })
  }

  #requireSession(sessionId: string): LiveSession {
    const session = this.#sessions.get(sessionId)
    if (!session) throw new Error(`unknown session ${sessionId}`)
    return session
  }

  /** Approvals still awaiting an answer, for the hub's replay on connect. */
  pendingApprovalsFor(sessionId: string): ApprovalRequest[] {
    const session = this.#sessions.get(sessionId)
    if (!session) return []
    return [...session.approvals.values()].map((a) => this.#approvalPayload(a))
  }
}

// ------------------------------------------------------------------ helpers

/** An empty prompt stream: starts the CLI, runs no turn, ends when closed. */
async function* emptyStream(): AsyncGenerator<SDKUserMessage> {
  // Intentionally yields nothing.
}

/**
 * The prompt stream for one turn's CLI subprocess.
 *
 * It starts with the message that opened the turn and then PARKS instead of
 * closing, which is what keeps the CLI's stdin open. `steer` pushes into it:
 * a message that arrives while a turn runs is folded into that turn (one
 * `result`), not run as a separate turn. `#spawnTurn` closes it when the turn's
 * `result` lands so the process can exit — a stream left open keeps the CLI
 * alive indefinitely, since it is waiting for more user input.
 */
