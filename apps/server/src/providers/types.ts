/**
 * The provider contract.
 *
 * A provider adapts one agent backend (Codex today; Claude, or anything else
 * later) to a normalized surface. Everything above this interface — routes,
 * the WebSocket hub, and the entire web client — is provider-agnostic.
 *
 * To add a provider:
 *   1. implement `AgentProvider`
 *   2. register it in providers/registry.ts
 *   3. list it in config (PROVIDERS)
 * No frontend changes required.
 */
import type {
  AgentEvent,
  AgentInput,
  ApprovalDecision,
  ApprovalPolicy,
  ModelInfo,
  Project,
  SandboxMode,
  SessionSummary,
  Transcript,
} from '@vibemobile/protocol'

export interface ProviderProbe {
  id: string
  displayName: string
  available: boolean
  version?: string
  authenticated?: boolean
  detail?: string
}

export interface ListSessionsOptions {
  cwd?: string
  limit?: number
  archived?: boolean
  /**
   * Case-insensitive substring to filter titles by.
   *
   * What it matches is the provider's business and the two do differ: Codex
   * forwards it as the app-server's own `searchTerm`, which matches ONLY the
   * extracted thread title, while Claude filters the `SDKSessionInfo` list it
   * already holds in memory and can also look at the summary and first prompt.
   * A client therefore must not promise that a hit is in the message body —
   * neither provider searches transcripts.
   */
  search?: string
}

export interface CreateSessionOptions {
  cwd: string
  model?: string
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
}

export class SessionInUseError extends Error {
  readonly code = 'session_in_use'

  constructor(readonly sessionId: string) {
    super('This session is open in another Codex client and cannot be resumed concurrently.')
    this.name = 'SessionInUseError'
  }
}

/**
 * The provider has no record of this session.
 *
 * Its own error rather than `null` because the interface cannot return `null`
 * from every method that can meet an unknown id — `deleteSession` and
 * `renameSession` return nothing. Thrown where the provider only finds out
 * mid-call, so the routes can answer 404 instead of the 500 a raw backend
 * error would produce. Both providers are expected to throw this for an id
 * they do not know, and to prefix nothing: the id is in `sessionId`.
 */
export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found'

  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

/**
 * The provider no longer holds this approval, so it can never be answered.
 *
 * Its own error rather than a plain one because the hub has to tell two cases
 * apart that otherwise look identical: "this request is gone" means the hub
 * must drop the entry AND broadcast `approval.resolved`, or the phone keeps a
 * sheet it can never dismiss and every client that connects afterwards is
 * served it again. Any other failure must leave the sheet alone — a live
 * approval whose answer merely failed would otherwise be dropped, leaving the
 * turn blocked with nothing on screen to unblock it.
 */
export class UnknownApprovalError extends Error {
  readonly code = 'unknown_approval'

  constructor(readonly requestId: string) {
    super(`no pending approval ${requestId}`)
    this.name = 'UnknownApprovalError'
  }
}

export interface AgentProvider {
  readonly id: string
  readonly displayName: string

  /** Health, version and auth state. Must never throw. */
  probe(): Promise<ProviderProbe>

  start(): Promise<void>
  stop(): Promise<void>

  /** Subscribe to normalized events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentEvent) => void): () => void

  listModels(): Promise<ModelInfo[]>
  listProjects(): Promise<Project[]>

  listSessions(opts?: ListSessionsOptions): Promise<SessionSummary[]>
  getSession(sessionId: string): Promise<SessionSummary | null>
  /**
   * A page of turns in render order (oldest first).
   *
   * `cursor` is the `nextCursor` of the previous page, opaque to the route and
   * to the client. A provider that cannot page must return `hasMore` without a
   * cursor rather than a cursor nobody can spend.
   */
  getTranscript(
    sessionId: string,
    opts?: {
      /** Page size in turns, when `targetItems` is absent. */
      limit?: number
      /**
       * Approximate page size in rendered items.
       *
       * Takes precedence over `limit`. Providers always cut on a turn
       * boundary, so the returned page may exceed the budget — and a single
       * huge turn is returned alone — but never returns an empty page while
       * turns remain. The cursor still names a turn position.
       */
      targetItems?: number
      cursor?: string
    },
  ): Promise<Transcript | null>
  createSession(opts: CreateSessionOptions): Promise<SessionSummary>
  /** Establish (or re-establish) a live subscription to a session. */
  resumeSession(sessionId: string): Promise<SessionSummary | null>
  /** Copy a session's history into a new session that can be controlled independently. */
  forkSession?(sessionId: string): Promise<SessionSummary>
  renameSession(sessionId: string, name: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  archiveSession?(sessionId: string, archived?: boolean): Promise<void>
  /**
   * Pin a session to the top of the list, or unpin it.
   *
   * Optional only because a provider could in principle have nowhere to put it;
   * both of today's implement it against `sessionPrefs.ts`, since neither the
   * app-server nor the Claude SDK has the concept. A route that finds it absent
   * must answer honestly rather than report a success — a pin that silently
   * does nothing is worse than a button that is not offered.
   */
  pinSession?(sessionId: string, pinned: boolean): Promise<void>

  startTurn(
    sessionId: string,
    input: AgentInput[],
    opts?: { model?: string; effort?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode },
  ): Promise<{ turnId: string }>
  steer(sessionId: string, turnId: string, input: AgentInput[]): Promise<void>
  interrupt(sessionId: string, turnId: string): Promise<void>

  /**
   * `answers` carries the user's choices for a request that asked a question
   * rather than permission (see `ApprovalRequest.questions`), one entry per
   * question in order. Optional because most requests are verdicts: a provider
   * that has no use for it must still accept it, and one that needs it must
   * cope with it being absent (an older client).
   */
  answerApproval(requestId: string, decision: ApprovalDecision, answers?: string[][]): Promise<void>

  /** Re-subscribe every known session. Called after a backend reconnect. */
  resubscribeAll?(): Promise<void>
}
