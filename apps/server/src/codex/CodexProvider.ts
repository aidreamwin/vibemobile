import { TurnRetryStore } from '../providers/turnRetries.js'
/**
 * AgentProvider implementation backed by `codex app-server`.
 *
 * This is the only file that knows both worlds: it makes Codex RPC calls and
 * emits normalized AgentEvents. Swapping in a Claude provider later means
 * implementing the same interface in providers/types.ts — nothing above this
 * layer changes.
 */
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type {
  AgentEvent,
  AgentInput,
  ApprovalDecision,
  ModelInfo,
  Project,
  SessionSummary,
  SessionStatus,
  Transcript,
  TranscriptTurn,
  ApprovalPolicy,
  SandboxMode,
} from '@vibemobile/protocol'
import { AppServerClient, type ServerRequestContext } from './AppServerClient.js'
import { AppServerSupervisor } from './supervisor.js'
import {
  answersForQuestions,
  mapNotification,
  mapThreadStatus,
  normalizeApproval,
  normalizeItem,
  type MapItemOptions,
} from './mapEvents.js'
import {
  isApprovalPolicy,
  isUnattended,
  mergePermission,
  permissionPairFrom,
  sandboxPolicyFor,
  type PermissionPair,
} from './permission.js'
import {
  SessionInUseError,
  SessionNotFoundError,
  UnknownApprovalError,
  type ListSessionsOptions,
} from '../providers/types.js'
import { readGitInfo } from '../providers/git.js'
import { pageTurnsByItems } from '../providers/page.js'
import { SessionPrefsStore } from '../providers/sessionPrefs.js'
import { capImages, MAX_PER_MESSAGE, ImageStore } from '../images/store.js'

export interface CodexProviderOptions {
  attachUrl?: string
  port?: number
  /** Workspace roots the agent may operate in. First entry is the default. */
  workspaceRoots: string[]
  /**
   * Where to keep the per-thread memory of what each session was last driven
   * with. Omitting it (tests, one-shot scripts) keeps the store in memory, so
   * nothing outside the service can read or overwrite a real state directory.
   */
  stateDir?: string
  onLog?: (line: string) => void
  /**
   * A line an operator should see at the default log level, as opposed to
   * `onLog`'s diagnostics. Falls back to the log channel below so a caller that
   * wired only `onLog` still receives it — a restored 完全访问 must not be
   * droppable by omission (same reasoning as `ClaudeProviderOptions.onNotice`).
   */
  onNotice?: (line: string) => void
}

interface PendingApproval {
  ctx: ServerRequestContext
  /**
   * The wire ids a question answer is filed under, in the order the sheet
   * showed them. Set only for `item/tool/requestUserInput`.
   *
   * Kept here because `ApprovalQuestion` has no id: the phone answers
   * positionally (`answers[i]` belongs to `questions[i]`), and the response
   * shape is a map keyed by id — so somebody has to remember what each position
   * is called on the wire, and only the provider ever saw the original payload.
   */
  questionIds?: string[]
}

/** Statuses that mean "the agent is blocked on a human". */
const ATTENTION: SessionStatus[] = ['waitingApproval', 'waitingInput']

// A thread created by `thread/start` has no conversation on disk until the
// first message is sent, and the app-server rejects several calls on it with
// a generic -32600. The code alone cannot distinguish these — every invalid
// request shares it — so the message is what we have to match on. If a Codex
// upgrade rewords these, the symptom is a 500 on opening a brand-new session,
// which is exactly what these predicates exist to prevent.
//
// Measured wordings, all meaning "nothing written yet": `no rollout found`
// (thread/resume on a fresh thread, and thread/delete + thread/fork on an id
// that does not exist) and `is not materialized yet` (thread/turns/list on a
// fresh thread). The third spelling below is kept on purpose: through 0.154.0
// thread/turns/list said `invalid paginated history lineage … missing source
// rollout`, and 0.162.1 reworded it to the `is not materialized yet` form.
// None of it is in the generated types — it was found by calling these on a
// session created seconds earlier, and missing one is a 500 on opening a
// brand-new session, which is what these predicates exist to prevent.
function isUnmaterializedThreadError(err: unknown): boolean {
  const message = (err as Error)?.message ?? ''
  return (
    message.includes('no rollout found') ||
    message.includes('is not materialized yet') ||
    message.includes('missing source rollout')
  )
}

function isActiveWriterError(err: unknown): boolean {
  return ((err as Error)?.message ?? '').includes('already has an active writer')
}

/**
 * The app-server has no such thread: `no rollout found for thread id X` from
 * the calls that go through the rollout store (`thread/delete`, `thread/fork`),
 * `thread not loaded: X` from the ones that need it in memory (`thread/read`).
 * Measured, both `-32600`.
 *
 * Spelled out rather than composed from `isUnmaterializedThreadError` above,
 * even though they overlap, because the two answer different questions and one
 * of those wordings must not leak: `missing source rollout` is only ever about
 * a missing *history*, so letting it count as "no such thread" would turn a
 * session that exists but has not been messaged into a 404.
 *
 * The overlap is real, though, and it is why `resumeSession` treats
 * `no rollout found` as a fallback rather than a failure: for THAT call it
 * means the thread exists and simply has no rollout yet. Whether the same words
 * mean "fresh" or "gone" is decided by which RPC said them, not by the text.
 */
function isUnknownThreadError(err: unknown): boolean {
  const message = (err as Error)?.message ?? ''
  return (
    message.includes('no rollout found') ||
    message.includes('thread not loaded') ||
    message.includes('is not materialized yet')
  )
}

export class CodexProvider extends EventEmitter {
  readonly id = 'codex' as const
  readonly displayName = 'Codex'

  #client: AppServerClient
  #supervisor: AppServerSupervisor
  #roots: string[]
  #pendingApprovals = new Map<string, PendingApproval>()
  /** threadId -> live status, maintained from status-changed notifications. */
  #status = new Map<string, SessionStatus>()
  #retryNotices = new Map<string, Extract<AgentEvent, { kind: 'error' }>>()
  #retryHistory: TurnRetryStore
  #prefs: SessionPrefsStore
  /**
   * Where the pictures a user attached are cached, or undefined when there is
   * no state directory (tests, one-shot scripts). Undefined means images are
   * simply not shown — never that a raw `data:` URL reaches an item.
   *
   * A separate instance from the route's, and safe because this class is
   * stateless: the files are the whole of it (see `images/store.ts`).
   */
  #images?: ImageStore
  #onNotice: (line: string) => void
  /**
   * Threads whose restored permission level has already been reported.
   *
   * Not a nicety: `resumeSession` runs on every open (the web calls it twice —
   * `POST /open` and then the WS `subscribe`), on every reconnect via
   * `resubscribeAll()`, and once more per extra client that subscribes. Warning
   * each time would turn a phone that reconnects on a flaky network into a
   * stream of `warn` lines, which is how a real warning gets ignored.
   */
  #noticed = new Set<string>()
  #userAgent?: string
  #started = false

  constructor(opts: CodexProviderOptions) {
    super()
    this.#roots = opts.workspaceRoots
    this.#retryHistory = new TurnRetryStore(
      opts.stateDir ? path.join(opts.stateDir, 'codex-retries.json') : undefined,
      opts.onLog,
    )
    this.#onNotice = opts.onNotice ?? ((line) => this.emit('log', line))
    this.#prefs = new SessionPrefsStore(
      opts.stateDir ? path.join(opts.stateDir, 'codex-sessions.json') : undefined,
      opts.onLog,
    )
    this.#images = opts.stateDir ? new ImageStore(path.join(opts.stateDir, 'images'), opts.onLog) : undefined
    this.#supervisor = new AppServerSupervisor({
      attachUrl: opts.attachUrl,
      port: opts.port,
      onLog: opts.onLog,
    })
    this.#client = new AppServerClient({ url: this.#supervisor.url })
    this.#wire()
  }

  /**
   * What this backend last drove `threadId` with, or `null` when it has never
   * driven it (or the stored value is unusable).
   *
   * Deliberately not asked of the app-server: `Thread` has no such fields, and
   * the ones `thread/start`/`thread/resume` return are documented as legacy
   * with an unclear "current vs creation default" meaning.
   */
  #remembered(threadId: string): PermissionPair | null {
    const stored = this.#prefs.get(threadId)
    if (!stored) return null
    return permissionPairFrom(stored.sandbox, stored.approvalPolicy)
  }

  /**
   * The remembered pair shaped for a `SessionSummary`: both fields or neither.
   *
   * Never half of one. The picker matches a card on the exact pair, so half a
   * pair could not seed it, and an absent field already means "not known" to
   * every consumer. Spread into the summary literals below.
   */
  #lastPair(threadId: string): Pick<SessionSummary, 'sandbox' | 'approvalPolicy'> {
    const pair = this.#remembered(threadId)
    if (!pair) return {}
    return { sandbox: pair.sandbox, approvalPolicy: pair.approvalPolicy }
  }

  /**
   * How a session is filed in the list, shaped for a `SessionSummary`.
   *
   * `pinned` is ours — the app-server has no such concept — so it comes from
   * `sessionPrefs.ts` like the permission pair does, and is omitted (rather
   * than written as `false`) when it was never set.
   *
   * `archived` is NOT here, and that asymmetry with Claude is deliberate:
   * archiving is the app-server's own state, and `Thread` carries no flag for
   * it — the only way to learn it is to ask `thread/list` for the archive, so a
   * single-thread read genuinely cannot report it. Every consumer of the flag
   * is looking at a row from that list. Storing a copy here as well would give
   * the same fact two sources that can disagree, which is worse than a field
   * that is absent where it is not knowable.
   */
  #filedAs(threadId: string): Pick<SessionSummary, 'pinned'> {
    const stored = this.#prefs.get(threadId)
    return stored?.pinned ? { pinned: true } : {}
  }

  /**
   * The mapper options for one item, carrying this provider's image store.
   *
   * Built per item rather than once, so the per-message cap below is a cap on
   * one message's images. Fresh options per call also mean a reply that fails
   * to store does not consume another image's budget.
   *
   * With no store (no `stateDir`) this returns nothing at all, and
   * `normalizeItem` then never looks at the image parts — which is what keeps
   * a test or a one-shot script from dragging `data:` URLs onto the wire.
   */
  #imageOptions(): MapItemOptions {
    const store = this.#images
    if (!store) return {}
    let stored = 0
    return {
      onImage: (dataUrl) => {
        if (stored >= MAX_PER_MESSAGE) return null
        const token = store.put(dataUrl)
        if (token) stored += 1
        return token
      },
    }
  }

  /**
   * A thread-scoped request, with "there is no such thread" turned into
   * `SessionNotFoundError` so the routes can answer 404.
   *
   * The prose is the only signal available — every one of these arrives as a
   * generic `-32600`, so a code check cannot separate an unknown thread from
   * any other invalid request (same constraint as the predicates above).
   * Wrapped here rather than at each call site so the wording lives in one
   * place and a future RPC cannot forget it.
   */
  async #threadRpc<T>(threadId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return (await this.#client.request(method, { threadId, ...params })) as T
    } catch (err) {
      if (isUnknownThreadError(err)) throw new SessionNotFoundError(threadId)
      throw err
    }
  }

  // ------------------------------------------------------------- lifecycle

  #wire() {
    this.#client.on('notification', (method, params) => {
      // Track status locally so session lists can badge "needs attention"
      // without polling every thread.
      if (method === 'thread/status/changed' && params?.threadId) {
        this.#status.set(params.threadId, mapThreadStatus(params.status))
      }
      // Images are stored here, on the one funnel every live event passes
      // through, so a raw data URL can never reach an AgentEvent. Same call for
      // `item/started` and `item/completed` — the latter replaces the former
      // wholesale, so resolving in only one of them would blank the thumbnail.
      let event = mapNotification(method, params, this.#imageOptions())
      // The app-server records no time on a message item. A user message
      // echoed while a turn runs (a steer) is its own bubble, so it gets the
      // moment it was accepted rather than the turn's start. Stamped here, on
      // the one funnel live events pass through, and only when the item is a
      // user message: `normalizeItem` is shared with the history read, where
      // "now" would be a fabrication.
      if (
        event &&
        (event.kind === 'item.started' || event.kind === 'item.updated' || event.kind === 'item.completed') &&
        event.item.kind === 'message' &&
        event.item.role === 'user'
      ) {
        event = { ...event, item: { ...event.item, at: event.item.at ?? Date.now() } }
      }
      if (event) {
        if ('threadId' in event && event.threadId) {
          if (event.kind === 'error' && event.willRetry) {
            this.#retryNotices.set(event.threadId, event)
            if (event.turnId) {
              const item = this.#retryHistory.add({ ...event, threadId: event.threadId, turnId: event.turnId })
              this.emit('event', { kind: 'item.updated', threadId: event.threadId, turnId: event.turnId, item })
            }
          } else if (
            event.kind === 'delta' ||
            event.kind === 'turn.started' ||
            event.kind === 'turn.completed' ||
            event.kind === 'error'
          )
            this.#retryNotices.delete(event.threadId)
        }
        // The app-server resolves a request by itself sometimes — the turn is
        // interrupted, or the client that was being asked goes away. The
        // resulting `approval.resolved` is broadcast like any other, but the
        // pending entry has to go too, or `answerApproval` keeps accepting an
        // answer for a request that no longer exists.
        if (event.kind === 'approval.resolved') this.clearApproval(event.requestId)
        this.emit('event', event)
      }
    })

    this.#client.setServerRequestHandler((ctx) => this.#onServerRequest(ctx))

    this.#client.on('ready', (info) => {
      this.#userAgent = info.userAgent
      this.emit('ready', info)
    })

    this.#client.on('reconnected', () => {
      // Subscriptions live in app-server memory and are gone after a restart.
      this.emit('reconnected')
    })

    this.#client.on('disconnected', (err) => this.emit('disconnected', err))
    this.#client.on('error', (err) => this.emit('error', err))
    this.#supervisor.on('log', (line: string) => this.emit('log', line))
  }

  async start(): Promise<void> {
    if (this.#started) return
    await this.#supervisor.start()
    await this.#client.start()
    this.#started = true
  }

  async stop(): Promise<void> {
    await this.#client.close()
    await this.#supervisor.stop()
    this.#started = false
  }

  /** Subscribe to normalized events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }

  get ready(): boolean {
    return this.#client.isReady
  }

  // --------------------------------------------------------------- probing

  async probe() {
    try {
      if (!this.ready) await this.start()
      const models = await this.listModels()
      return {
        id: this.id,
        displayName: this.displayName,
        available: true,
        version: this.#userAgent ?? undefined,
        authenticated: true,
        detail: models.length ? undefined : 'no models reported',
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

  async listModels(): Promise<ModelInfo[]> {
    const res = (await this.#client.request('model/list', {})) as any
    const data = res?.data ?? res?.models ?? []
    return data.map((m: any) => ({
      id: m.id ?? m.model ?? m.slug,
      displayName: m.displayName ?? m.name ?? m.id,
      efforts: m.supportedReasoningEfforts?.map((e: any) => e.reasoningEffort ?? e) ?? undefined,
      defaultEffort: m.defaultReasoningEffort ?? undefined,
    }))
  }

  async listProjects(): Promise<Project[]> {
    const projects = await Promise.all(
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
    return projects
  }

  // -------------------------------------------------------------- sessions

  async listSessions(opts: ListSessionsOptions = {}) {
    const res = (await this.#client.request('thread/list', {
      cwd: opts.cwd ?? undefined,
      limit: opts.limit ?? 50,
      // NOTE: ThreadSortKey is snake_case on the wire — 'recency_at', not
      // 'recencyAt'. The server rejects the camelCase form with -32600.
      sortKey: 'recency_at',
      sortDirection: 'desc',
      // true = the archive, and ONLY the archive; false = everything else. The
      // two are disjoint sets, not a widening, which is why the flag below can
      // be filled in from the request.
      archived: opts.archived ?? false,
      // The app-server's own title filter. Its documented scope is the
      // EXTRACTED THREAD TITLE and it does not look at the transcript, so a hit
      // is not a promise that the word appears in the conversation — see
      // `ListSessionsOptions.search`. Empty string would be a filter matching
      // nothing on some servers, so it is sent as absent.
      searchTerm: opts.search || undefined,
    })) as any

    const data = res?.data ?? []
    return data.map((t: any): SessionSummary => {
      const status = this.#status.get(t.id) ?? mapThreadStatus(t.status)
      return {
        id: t.id,
        provider: this.id,
        title: t.name ?? t.preview?.slice(0, 60) ?? 'Untitled',
        preview: t.preview ?? '',
        cwd: t.cwd ?? '',
        projectId: t.cwd ?? null,
        status,
        model: t.model ?? null,
        reasoningEffort: t.reasoningEffort ?? null,
        createdAt: toMillis(t.createdAt),
        updatedAt: toMillis(t.recencyAt ?? t.updatedAt),
        needsAttention: ATTENTION.includes(status),
        ...this.#lastPair(t.id),
        ...this.#filedAs(t.id),
        // Every row of an archive listing is archived by construction — the
        // app-server filtered on exactly that. See `#filedAs` for why the flag
        // cannot come from the thread itself.
        ...(opts.archived ? { archived: true } : {}),
      }
    })
  }

  async getSession(threadId: string): Promise<SessionSummary | null> {
    let res: any
    try {
      res = await this.#client.request('thread/read', { threadId, includeTurns: false })
    } catch (err) {
      // `thread not loaded` here means the app-server has neither a rollout for
      // this id nor the thread in memory. `null` is what this method promises
      // for "no such session", and returning it (rather than rethrowing) is
      // what lets `GET /api/sessions/:id` answer 404 and `resumeSession`'s
      // fallback below end as a 404 too, instead of both becoming a 500.
      if (isUnknownThreadError(err)) return null
      throw err
    }
    const t = res?.thread
    if (!t) return null
    const status = this.#status.get(t.id) ?? mapThreadStatus(t.status)
    return {
      id: t.id,
      provider: this.id,
      title: t.name ?? t.preview?.slice(0, 60) ?? 'Untitled',
      preview: t.preview ?? '',
      cwd: t.cwd ?? '',
      projectId: t.cwd ?? null,
      status,
      model: t.model ?? null,
      reasoningEffort: t.reasoningEffort ?? null,
      createdAt: toMillis(t.createdAt),
      updatedAt: toMillis(t.recencyAt ?? t.updatedAt),
      needsAttention: ATTENTION.includes(status),
      ...this.#lastPair(t.id),
      ...this.#filedAs(t.id),
    }
  }

  async createSession(opts: {
    cwd: string
    model?: string
    sandbox?: SandboxMode
    approvalPolicy?: ApprovalPolicy
  }): Promise<SessionSummary> {
    const sandbox = opts.sandbox ?? 'workspace-write'
    // Narrowed, not merely defaulted: since the protocol's `ApprovalPolicy` also
    // carries Claude's `'auto'`, this is the point where a value the app-server
    // has no meaning for would otherwise be forwarded verbatim — and the
    // `permissionPairFrom` below would record nothing, leaving the payload and
    // the store disagreeing about what the thread is on.
    const approvalPolicy = isApprovalPolicy(opts.approvalPolicy) ? opts.approvalPolicy : 'on-request'
    const res = (await this.#client.request('thread/start', {
      cwd: opts.cwd,
      model: opts.model ?? undefined,
      // NOTE: thread/start takes `sandbox` (enum string), NOT `sandboxPolicy`
      // (object) — the object form is only valid on turn/start.
      sandbox,
      approvalPolicy,
    })) as any

    const t = res.thread
    this.#status.set(t.id, 'idle')
    // Remember what `thread/start` was actually given — the defaults above are
    // ours, and after this call they are the thread's. Writing at creation
    // rather than at the first turn is the point: the phone may not send a
    // message for hours, and the composer seeds from this, so without it the
    // first message would go out as 按需确认 and downgrade the session the user
    // had just set up.
    const started = permissionPairFrom(sandbox, approvalPolicy)
    if (started) this.#prefs.set(t.id, started)
    return {
      id: t.id,
      provider: this.id,
      title: t.name ?? t.preview?.slice(0, 60) ?? 'New session',
      preview: t.preview ?? '',
      cwd: res.cwd ?? t.cwd ?? opts.cwd,
      projectId: res.cwd ?? opts.cwd,
      status: 'idle',
      model: res.model ?? null,
      reasoningEffort: t.reasoningEffort ?? null,
      createdAt: toMillis(t.createdAt ?? Date.now() / 1000),
      updatedAt: toMillis(t.updatedAt ?? Date.now() / 1000),
      needsAttention: false,
      ...this.#lastPair(t.id),
      ...this.#filedAs(t.id),
    }
  }

  /**
   * Load a session for interaction. `thread/resume` is what re-establishes the
   * subscription after an app-server restart, so this is called both when the
   * user opens a session and after every reconnect.
   */
  async resumeSession(threadId: string): Promise<SessionSummary | null> {
    let res: any
    try {
      res = await this.#client.request('thread/resume', {
        threadId,
        excludeTurns: true,
      })
    } catch (err) {
      // A thread with no messages yet has no rollout to resume. It is still
      // live in the app-server (we just created it), so this is not a failure
      // — fall back to `thread/read`, which works regardless. For an id the
      // app-server has never heard of, that read finds nothing either and this
      // returns null, which the route answers with a 404.
      if (isUnmaterializedThreadError(err)) return this.getSession(threadId)
      if (isActiveWriterError(err)) throw new SessionInUseError(threadId)
      // Anything else the app-server calls an unknown thread. Unreachable with
      // today's wording — `thread/resume` says `no rollout found`, which the
      // branch above takes — but this is the same class of answer as the RPCs
      // that go through `#threadRpc`, and a reworded message would otherwise
      // surface as a 500 on opening a session.
      if (isUnknownThreadError(err)) throw new SessionNotFoundError(threadId)
      throw err
    }
    const t = res?.thread
    const status = this.#status.get(threadId) ?? mapThreadStatus(t?.status)
    if (!t) return null
    const retry = this.#retryNotices.get(threadId)
    if (retry) this.emit('event', retry)
    // One line per thread per process when the level we are about to put back on
    // screen is an unattended one. The screen says it too — the picker renders
    // 完全访问 in the warning colour for as long as the session is on it — this
    // is for whoever reads the service log. Gated because this method runs on
    // every open, every reconnect and once per extra subscriber; see `#noticed`.
    const remembered = this.#remembered(t.id)
    if (remembered && isUnattended(remembered) && !this.#noticed.has(t.id)) {
      this.#noticed.add(t.id)
      this.#onNotice(
        `session ${t.id} opens on ${remembered.sandbox}/${remembered.approvalPolicy}: unattended tool calls`,
      )
    }
    return {
      id: t.id,
      provider: this.id,
      title: t.name ?? t.preview?.slice(0, 60) ?? 'Untitled',
      preview: t.preview ?? '',
      cwd: res.cwd ?? t.cwd ?? '',
      projectId: res.cwd ?? t.cwd ?? null,
      status,
      model: res.model ?? t.model ?? null,
      reasoningEffort: t.reasoningEffort ?? null,
      createdAt: toMillis(t.createdAt),
      updatedAt: toMillis(t.recencyAt ?? t.updatedAt),
      needsAttention: ATTENTION.includes(status),
      ...this.#lastPair(t.id),
      ...this.#filedAs(t.id),
    }
  }

  async forkSession(threadId: string): Promise<SessionSummary> {
    const res = await this.#threadRpc<any>(threadId, 'thread/fork', {
      excludeTurns: true,
      // A source thread may have an active goal. Copy it without immediately
      // starting work before the user sends the next message in the new thread.
      deferGoalContinuation: true,
    })

    const t = res.thread
    const status = mapThreadStatus(t.status)
    this.#status.set(t.id, status)
    // Before the summary below, so the fork reports what it inherited instead of
    // nothing. The app-server copies the transcript; it copies no settings.
    this.#prefs.copy(threadId, t.id)
    return {
      id: t.id,
      provider: this.id,
      title: t.name ?? t.preview?.slice(0, 60) ?? 'Untitled',
      preview: t.preview ?? '',
      cwd: res.cwd ?? t.cwd ?? '',
      projectId: res.cwd ?? t.cwd ?? null,
      status,
      model: res.model ?? t.model ?? null,
      reasoningEffort: t.reasoningEffort ?? null,
      createdAt: toMillis(t.createdAt),
      updatedAt: toMillis(t.recencyAt ?? t.updatedAt),
      needsAttention: ATTENTION.includes(status),
      ...this.#lastPair(t.id),
      ...this.#filedAs(t.id),
    }
  }

  /** Re-subscribe every thread we know about. Called after a reconnect. */
  async resubscribeAll(): Promise<void> {
    for (const threadId of this.#status.keys()) {
      try {
        await this.resumeSession(threadId)
      } catch {
        // Thread may have been deleted while we were away; drop it.
        this.#status.delete(threadId)
      }
    }
  }

  async getTranscript(
    threadId: string,
    opts: { limit?: number; cursor?: string; targetItems?: number } = {},
  ): Promise<Transcript | null> {
    const session = await this.getSession(threadId)
    if (!session) return null

    if (opts.targetItems && opts.targetItems > 0) {
      return this.#transcriptByItems(session, threadId, Math.floor(opts.targetItems), opts.cursor)
    }

    let res: any
    let turns: TranscriptTurn[]
    try {
      // `nextCursor` from an earlier descending page continues after its
      // last turn, which is the older page the phone asked for. Without one
      // this is the newest page, exactly as before.
      ;({ res, turns } = await this.#listTurns(threadId, opts.limit ?? 30, opts.cursor))
    } catch (err) {
      // The server refuses to list turns on a thread that has none, rather
      // than returning an empty page. An empty transcript is the correct
      // answer for a session the user just created and has not messaged yet.
      if (isUnmaterializedThreadError(err)) return { session, turns: [], nextCursor: null }
      throw err
    }

    // The server returns newest-first; the UI renders oldest-first.
    turns.reverse()

    // `nextCursor` is the app-server's own cursor, handed to the client so it
    // can ask for the older page. `hasMore` is still separate and is still the
    // question the UI asks: a provider that has no cursor must be able to say
    // "older turns exist" without pretending they can be reached. Omitted when
    // false, as both providers do — see `Transcript.hasMore`.
    // A cursored page that came back empty must not hand the same cursor back:
    // repeating it would make the client ask forever. Only a fresh (cursorless)
    // page may legitimately be empty and still carry a cursor.
    const nextCursor = opts.cursor && turns.length === 0 ? null : (res?.nextCursor ?? null)
    return {
      session,
      turns,
      nextCursor,
      ...(nextCursor ? { hasMore: true } : {}),
    }
  }

  /**
   * A page budgeted by rendered items instead of turn count.
   *
   * `thread/turns/list` only takes a turn limit, so this probes with one turn
   * and doubles the request until the budget is met. A session whose newest
   * turn already has enough cards costs one RPC and transfers one turn; the
   * pathological case (one item per turn) is about seven local calls, each
   * milliseconds, and is still cheaper than returning sixty turns of a file
   * whose turns are huge.
   */
  async #transcriptByItems(
    session: SessionSummary,
    threadId: string,
    targetItems: number,
    cursor: string | undefined,
  ): Promise<Transcript> {
    let res: any
    let newest: TranscriptTurn[] = []
    let fetchLimit = 1
    try {
      for (;;) {
        ;({ res, turns: newest } = await this.#listTurns(threadId, fetchLimit, cursor))
        const items = newest.reduce((n, turn) => n + turn.items.length, 0)
        // Each turn normally carries at least one item, so once the request
        // size reaches the item budget there is nothing older worth fetching.
        if (items >= targetItems || newest.length < fetchLimit || fetchLimit >= targetItems) break
        fetchLimit = Math.min(fetchLimit * 2, targetItems)
      }
    } catch (err) {
      if (isUnmaterializedThreadError(err)) return { session, turns: [], nextCursor: null }
      throw err
    }

    const ordered = [...newest].reverse()
    const { start, end } = pageTurnsByItems(ordered, targetItems, 0)
    const kept = end - start
    let page = ordered.slice(start, end)
    let pageRes = res

    // The doubling probe may have fetched turns this page does not return.
    // `nextCursor` names the turn after the LAST turn of its request, so
    // spending the probe's cursor would silently skip them. Ask for exactly
    // the turns being returned; that response's cursor is the one the next
    // page can use.
    if (kept > 0 && kept < newest.length) {
      try {
        ;({ res: pageRes, turns: newest } = await this.#listTurns(threadId, kept, cursor))
      } catch (err) {
        if (isUnmaterializedThreadError(err)) return { session, turns: [], nextCursor: null }
        throw err
      }
      page = [...newest].slice(0, kept).reverse()
    }

    const nextCursor = cursor && page.length === 0 ? null : (pageRes?.nextCursor ?? null)
    return {
      session,
      turns: page,
      nextCursor,
      ...(nextCursor ? { hasMore: true } : {}),
    }
  }

  /** One descending page of turns, mapped, still newest-first. */
  async #listTurns(
    threadId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<{ res: any; turns: TranscriptTurn[] }> {
    const res: any = await this.#client.request('thread/turns/list', {
      threadId,
      limit,
      sortDirection: 'desc',
      itemsView: 'full',
      ...(cursor ? { cursor } : {}),
    })
    const turns: TranscriptTurn[] = (res?.data ?? []).map((turn: any) => ({
      id: turn.id,
      status: turn.status,
      // A fresh options object per item: the per-message image cap is per
      // message. Re-`put`ting what a live event already stored returns the same
      // token (content-addressed), so replay and live agree, and a store that
      // was cleared rebuilds itself as soon as any transcript is read.
      items: [
        ...(turn.items ?? []).map((item: any) => normalizeItem(item, this.#imageOptions())),
        ...(this.#retryHistory.get(threadId, turn.id) ? [this.#retryHistory.get(threadId, turn.id)!] : []),
        ...(turn.status === 'failed' || turn.error
          ? [
              {
                kind: 'error' as const,
                id: `turn-error:${turn.id}`,
                message: turn.error?.message || '代理执行失败，未返回具体原因。',
              },
            ]
          : []),
      ],
      startedAt: turn.startedAt ? toMillis(turn.startedAt) : null,
      completedAt: turn.completedAt ? toMillis(turn.completedAt) : null,
      durationMs: turn.durationMs ?? null,
    }))
    return { res, turns }
  }

  async renameSession(threadId: string, name: string): Promise<void> {
    await this.#threadRpc(threadId, 'thread/name/set', { name })
  }

  async deleteSession(threadId: string): Promise<void> {
    await this.#threadRpc(threadId, 'thread/delete')
    this.#status.delete(threadId)
    // After the RPC, unlike Claude which forgets first: a delete that failed
    // leaves a live thread behind, and its remembered level should outlive the
    // attempt rather than be dropped by a call that never happened.
    this.#prefs.forget(threadId)
    this.#noticed.delete(threadId)
  }

  async archiveSession(threadId: string, archived = true): Promise<void> {
    await this.#threadRpc(threadId, archived ? 'thread/archive' : 'thread/unarchive')
    // Archiving hides a thread and keeps its record, so the memory stays too —
    // unarchiving puts the session back exactly as it was. (Spelled out because
    // `deleteSession` above forgets on purpose, and the asymmetry would
    // otherwise read as an oversight.)
  }

  /**
   * Purely ours — the app-server has no notion of a pinned thread — so this
   * writes to `sessionPrefs.ts` and touches nothing else. See `#filedAs` for how
   * it gets back onto a summary.
   *
   * Deliberately no existence check: the thread id may name a session this
   * backend has never opened, and the pin is still a valid thing to remember.
   * Unlike an archive there is nothing to write back to the backend, so there is
   * no "it refused" case to report — which is why this returns nothing and the
   * route does not have to invent an error for it.
   */
  async pinSession(threadId: string, pinned: boolean): Promise<void> {
    this.#prefs.set(threadId, { pinned })
  }

  // ----------------------------------------------------------------- turns

  async startTurn(
    threadId: string,
    rawInput: AgentInput[],
    opts?: { model?: string; effort?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode },
  ): Promise<{ turnId: string }> {
    // The app-server will accept any number of images; the cap is ours, and it
    // has to be applied here rather than only when the transcript is read back,
    // or the phone shows a picture the agent never got.
    const input = capImages(rawInput)
    // `threadId` is added by `#threadRpc` below, which needs it out of the
    // payload to name the thread in a not-found error.
    const payload: Record<string, any> = {
      input: input.map(toCodexInput),
      // Request a displayable reasoning summary. Without this override Codex
      // may emit an empty reasoning item, leaving the UI with a blank card.
      summary: 'detailed',
    }
    if (opts?.model) payload.model = opts.model
    if (opts?.effort) payload.effort = opts.effort
    // Same gate as `createSession`, and for the same reason: an unrecognized
    // value must not reach the app-server, because the pairing side of this turn
    // (below) would refuse to record it and the two would drift apart. `'auto'`
    // is the value that makes this reachable — it is Claude's, and the composer
    // only offers it there — so for Codex it is a silent no-op rather than an
    // undefined behaviour on the thread.
    if (isApprovalPolicy(opts?.approvalPolicy)) payload.approvalPolicy = opts.approvalPolicy
    if (opts?.sandbox) payload.sandboxPolicy = sandboxPolicyFor(opts.sandbox)
    // Record what this turn hands the app-server — the MERGED pair, not `opts`.
    // Only the fields actually sent are applied by the server, so a sandbox-only
    // turn leaves the thread's approval policy as it was; storing `opts` would
    // remember a combination the machine never received. Written before the
    // await, which keeps the recorded order equal to the call order — after it,
    // two overlapping turns could both read the old value and the later write
    // would discard the earlier turn's half. A turn that then fails records what
    // we tried to send, which is the card already on screen and what the next
    // message re-asserts anyway.
    const pair = mergePermission(this.#remembered(threadId), {
      sandbox: opts?.sandbox,
      approvalPolicy: opts?.approvalPolicy,
    })
    if (pair) this.#prefs.set(threadId, { sandbox: pair.sandbox, approvalPolicy: pair.approvalPolicy })
    const res = await this.#threadRpc<any>(threadId, 'turn/start', payload)
    return { turnId: res.turn.id }
  }

  async steer(threadId: string, turnId: string, rawInput: AgentInput[]): Promise<void> {
    await this.#threadRpc(threadId, 'turn/steer', {
      expectedTurnId: turnId,
      input: capImages(rawInput).map(toCodexInput),
    })
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.#threadRpc(threadId, 'turn/interrupt', { turnId })
  }

  // ------------------------------------------------------------- approvals

  #onServerRequest(ctx: ServerRequestContext) {
    const known = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
    ]

    if (!known.includes(ctx.method)) {
      // Unhandled requests must be refused explicitly — dropping them would
      // hang the turn until the server-side timeout.
      ctx.fail(-32601, `vibemobile does not implement ${ctx.method}`)
      return
    }

    const requestId = String(ctx.id)
    const params = ctx.params as any
    const approval = normalizeApproval(ctx.method, params)
    approval.requestId = requestId

    // Only captured when the payload actually produced a form, so the two
    // stay in lockstep: an answer keyed against questions the phone never
    // rendered would be silently mis-filed.
    const questionIds =
      approval.questions && Array.isArray(params?.questions)
        ? params.questions.map((q: any) => String(q?.id ?? ''))
        : undefined

    this.#pendingApprovals.set(requestId, { ctx, questionIds })
    if (params.threadId) this.#status.set(params.threadId, 'waitingApproval')

    this.emit('event', { kind: 'approval.requested', approval } satisfies AgentEvent)
  }

  async answerApproval(requestId: string, decision: ApprovalDecision, answers?: string[][]): Promise<void> {
    const pending = this.#pendingApprovals.get(requestId)
    // Typed, not plain: the hub has to tell "this request is gone" (drop the
    // sheet everywhere) from "the answer failed to land" (keep it — the turn is
    // still blocked on it). See `UnknownApprovalError`.
    if (!pending) throw new UnknownApprovalError(requestId)
    this.#pendingApprovals.delete(requestId)

    if (pending.questionIds) {
      // A question is not a decision: there is no `decision` field in this
      // response at all, and replying `{decision:'accept'}` to it is what made
      // the agent report that the user had not answered. Same gap Claude's
      // `askUser.ts` closes; this is the Codex half of it.
      //
      // An answer that does not line up is sent as `{answers:{}}` — empty
      // rather than fabricated. The request must still be answered or the turn
      // hangs, and the empty map is the honest encoding of "nothing was
      // chosen"; the model is then free to decide for itself.
      pending.ctx.respond({ answers: answersForQuestions(pending.questionIds, answers) ?? {} })
      return
    }

    pending.ctx.respond({ decision })
  }

  /**
   * Called when the server tells us an approval became moot.
   *
   * Without this the entry lives until the process exits: `answerApproval`
   * would still find it, answer a request the app-server has already discarded,
   * and report success — while `pendingApprovalCount` (which the tests and the
   * health surface read) kept counting requests that no longer exist.
   */
  clearApproval(requestId: string): void {
    this.#pendingApprovals.delete(requestId)
  }

  get pendingApprovalCount(): number {
    return this.#pendingApprovals.size
  }
}

// ------------------------------------------------------------------ helpers

/** Codex reports timestamps in seconds; the UI works in ms. */
function toMillis(seconds: number | undefined | null): number {
  if (!seconds) return Date.now()
  // Heuristic: anything below this threshold is seconds, not ms.
  return seconds < 1e12 ? Math.round(seconds * 1000) : Math.round(seconds)
}

function toCodexInput(input: AgentInput): unknown {
  if (input.type === 'text') return { type: 'text', text: input.text, text_elements: [] }
  // The server rejects remote image URLs; only data: URLs are accepted.
  return { type: 'image', url: input.url }
}
