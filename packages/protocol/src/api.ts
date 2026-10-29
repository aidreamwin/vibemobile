/**
 * REST + WebSocket DTOs shared by the server and the web client.
 */
import type {
  AgentEvent,
  AgentInput,
  AgentItem,
  ApprovalDecision,
  ProviderId,
  SessionStatus,
  TurnStatus,
} from './events.js'

// -------------------------------------------------------------- provider

export interface ProviderStatus {
  id: ProviderId
  displayName: string
  available: boolean
  version?: string
  authenticated?: boolean
  /** Human-readable reason when `available` is false. */
  detail?: string
}

export interface ModelInfo {
  id: string
  displayName: string
  /** Reasoning effort levels this model advertises, cheapest first. */
  efforts?: string[]
  /** The provider's default effort when a turn does not override it. */
  defaultEffort?: string
}

/** A workspace root the agent may operate in. */
export interface Project {
  id: string
  name: string
  path: string
  isGitRepo: boolean
  gitBranch?: string | null
}

// ----------------------------------------------------------------- health

/**
 * Which build one half of the app is running.
 *
 * This exists because a deployment is TWO halves that go stale independently:
 * the web `dist` is read from disk on every request, so rebuilding the front end
 * takes effect immediately, while the server loads its `dist` once at process
 * start. So "am I running the latest code?" has two different answers at the same
 * moment, and only the build itself can supply them.
 *
 * `commit` is deliberately nullable: the Docker build does not copy `.git`, so
 * there is nothing to ask. Consumers must compare commits only when BOTH sides
 * have one, and must never treat a null as "different".
 */
export interface BuildInfo {
  version: string
  /** Short commit the build came from, when the build could see a git repo. */
  commit: string | null
  /** True when the tree had uncommitted changes — the commit alone then lies. */
  dirty: boolean
  /**
   * When the build ran, or null when there was no build: `vite serve` compiles
   * on the fly, and a server reporting null is running its sources (`tsx watch`)
   * or a hand-rolled `tsc` output that never went through `postbuild`.
   */
  builtAt: number | null
}

/**
 * `GET /api/health` — unauthenticated, so it carries nothing secret.
 */
export interface HealthResponse {
  ok: true
  /** Seconds since the process started; 0 right after a restart. */
  uptime: number
  /** The build the running process loaded — fixed at startup, on purpose. */
  build: BuildInfo
  /**
   * The stamp sitting in `dist` right now. Different from `build` means the
   * backend was rebuilt but the service was never restarted, which is the
   * failure this whole pair of fields exists to make visible. Null when there
   * is no such file (development).
   */
  buildOnDisk: BuildInfo | null
  providers: { id: ProviderId; ready: boolean | null }[]
  roots: string[]
  terminal: { enabled: boolean; reason?: string }
}

// --------------------------------------------------------------- sessions

export interface SessionSummary {
  id: string
  provider: ProviderId
  title: string
  preview: string
  cwd: string
  projectId?: string | null
  status: SessionStatus
  model?: string | null
  createdAt: number
  updatedAt: number
  /** True when the agent is blocked waiting on the user. */
  needsAttention: boolean
  /**
   * Hidden from the list unless the caller asks for archived ones.
   *
   * The two providers disagree about where this lives, and that is deliberate:
   * Codex has it in the app-server (`thread/archive` / `thread/unarchive`), so
   * the flag is read straight off the thread. Claude has no such concept, so
   * its provider keeps the flag in `providers/sessionPrefs.ts` instead. Either
   * way it is reported here, because the client cannot tell the difference and
   * must not have to.
   *
   * Omitted rather than `false` in the common case: this rides on every summary
   * and the listing of 50 sessions should not carry 50 falses.
   */
  archived?: boolean
  /**
   * Pinned to the top of the list, above the "recently touched" order.
   *
   * Purely this app's own state — neither backend has a notion of it — so both
   * providers keep it in `sessionPrefs.ts`. See the eviction caveat there.
   */
  pinned?: boolean
  /** Current/default reasoning effort for the selected model, when known. */
  reasoningEffort?: string | null
  /**
   * The permission level this backend last drove the session with, when it
   * knows one.
   *
   * A starting point for the picker, not a claim about the machine: it is what
   * this backend last SENT, and the next message re-asserts whatever the picker
   * shows. So the load-bearing invariant is "the card on screen == the pair in
   * the next `turn/start`", which holds regardless of what anything else has
   * done to the same session since (a desktop client, say). That is why these
   * two fields seed the composer instead of the composer's own default — it is
   * what stops a session created with 完全访问 from being silently downgraded by
   * the first message.
   *
   * Both providers learn it the same way, from `providers/sessionPrefs.ts`,
   * because neither backing store can report it: Claude's SDK knows nothing
   * about how a session was configured, and a Codex `Thread` has no
   * sandbox/approvalPolicy field. The two halves are kept independent rather
   * than collapsed into a level, because the app-server treats them that way.
   *
   * A pair naming `approvalPolicy: 'auto'` is Claude's 自动判断 rung and is never
   * reported for a Codex session (that provider cannot accept the value, so it
   * records nothing). Consumers offering a picker must leave the rung out for
   * anything that is not Claude rather than render it and send it.
   *
   * `undefined` means "not known" and is a real answer — a session this backend
   * never drove, one whose entry was evicted, or a Codex pair outside the three
   * cards the composer can express (it offers sandbox and approval policy as
   * two independent choices, so nine combinations can be created and only three
   * are expressible here). Consumers must fall back to their own default, never
   * to the last level the user picked — and an unrecognized pair must never
   * light up the unattended one.
   */
  sandbox?: SandboxMode | null
  approvalPolicy?: ApprovalPolicy | null
}

export interface TranscriptTurn {
  id: string
  status: TurnStatus
  items: AgentItem[]
  startedAt?: number | null
  completedAt?: number | null
  durationMs?: number | null
}

export interface Transcript {
  session: SessionSummary
  turns: TranscriptTurn[]
  /**
   * Opaque cursor for loading the next (older) page, passed back verbatim as
   * the `cursor` query parameter of `GET /api/sessions/:id`.
   *
   * Provider-specific on purpose: Codex hands back the app-server's own
   * cursor, Claude a synthetic one, and neither is interpreted by the route.
   */
  nextCursor?: string | null
  /**
   * The page was cut short — older turns exist and are not here.
   *
   * Separate from `nextCursor`, and not merely "is there a cursor": a provider
   * with no paging of its own can say "there is more" without being able to
   * hand out a cursor, and the client must then show the missing turns as
   * unreachable rather than offering a button that cannot work.
   *
   * Omitted when false, since this rides on every transcript.
   */
  hasMore?: boolean
}

export interface CreateSessionOptions {
  provider: ProviderId
  cwd: string
  model?: string
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
/**
 * The union is deliberately WIDER than either backend's vocabulary: `'auto'` is
 * Claude's classifier mode and means nothing to the Codex app-server.
 *
 * It travels in this field rather than in one of its own because the pair is the
 * only channel a permission level has: the composer sends `(sandbox,
 * approvalPolicy)` on every turn and the session reports the same pair back, so
 * "the card on screen == the pair in the next turn/start" stays literally true
 * with one source. A second field would give the card two sources and an
 * untested precedence rule between them.
 *
 * This package cannot enforce anything (types only). The enforcement points are
 * `codex/permission.ts`'s `isApprovalPolicy` — called by `CodexProvider` wherever
 * a client-supplied value would otherwise reach the app-server — and the web
 * app's `permissionCardsFor`, which does not offer the card for a provider that
 * has no such mode.
 */
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never' | 'auto'

// ------------------------------------------------------------------ files

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

export interface FileContent {
  path: string
  text: string
  truncated: boolean
  bytes: number
  /**
   * A short digest of the bytes this text was decoded from, for the save path's
   * optimistic-concurrency check.
   *
   * Necessary rather than polite: an agent is usually editing the same tree, so
   * a phone that saved what it read ten minutes ago would silently revert
   * everything written in between. Sent back with the save, and a mismatch is a
   * 409 the client resolves by re-reading — never by overwriting.
   *
   * Absent for a file too large to read whole (`truncated`), which is also the
   * one case that cannot be saved at all.
   */
  rev?: string
}

// --------------------------------------------------------------- runners

export interface RunnerInfo {
  id: string
  name: string
  online: boolean
  lastSeen: number | null
  /**
   * Present only on runners whose credentials live in the Hub's store (i.e.
   * created from the settings page or `create-runner.mjs`). The Hub's default
   * local runner is managed by the Hub process and has no flag.
   */
  managed?: boolean
}

export interface CreateRunnerRequest {
  name: string
}

/** The only response that ever carries a plaintext token; it is not stored. */
export interface RunnerTokenResponse {
  id: string
  name: string
  token: string
}

// ------------------------------------------------------------------- auth

export interface LoginRequest {
  pin: string
}
export interface LoginResponse {
  ok: true
  expiresAt: number
}
export interface MeResponse {
  authenticated: boolean
}

// -------------------------------------------------------- ws: client -> server

export type ClientMessage =
  | { type: 'subscribe'; threadId: string }
  | { type: 'unsubscribe'; threadId: string }
  | {
      type: 'startTurn'
      threadId: string
      input: AgentInput[]
      model?: string
      effort?: string
      approvalPolicy?: ApprovalPolicy
      sandbox?: SandboxMode
    }
  | { type: 'steer'; threadId: string; turnId: string; input: AgentInput[] }
  | { type: 'interrupt'; threadId: string; turnId: string }
  | {
      type: 'answerApproval'
      requestId: string
      decision: ApprovalDecision
      /**
       * Chosen option labels, one entry per `ApprovalRequest.questions` entry,
       * in the same order — empty for a request with no questions, and for any
       * request whose answer is a verdict rather than a choice.
       *
       * Positional rather than keyed by question text: the text is prose the
       * agent wrote, and a provider that needs it as a key can reconstruct that
       * pairing itself (Claude's does). Multipart answers — the ones where the
       * user picked several options — are the whole array for that question,
       * not a pre-joined string: joining is the provider's encoding to choose.
       */
      answers?: string[][]
    }
  | { type: 'ping' }

/**
 * A client message as it appears on the wire: the union above plus the
 * correlation id the client generates. The server MUST echo it back verbatim
 * in the `ack`/`nack`, otherwise the client cannot match the reply to the
 * request it is waiting on and the command hangs.
 *
 * This field is deliberately NOT called `requestId`: `answerApproval` already
 * has a `requestId` meaning the id of the approval being answered. Two
 * different things under one name in the same object is not a hypothetical
 * hazard — the client builds its envelope by spreading the message and adding
 * the correlation id, so the later property silently wins and the approval id
 * is lost on the wire.
 */
export type ClientRequest = ClientMessage & { clientRequestId?: string }

// -------------------------------------------------------- ws: server -> client

export type ServerMessage =
  | { type: 'hello'; subscribed: string[] }
  | { type: 'event'; event: AgentEvent }
  | { type: 'ack'; requestId: string; ok: true; data?: unknown }
  | { type: 'nack'; requestId: string; ok: false; error: string }
  | { type: 'pong' }
