/**
 * Normalized agent event contract.
 *
 * This is the platform-independent surface that the web client consumes.
 * Nothing in here mentions Codex. A provider (Codex today, Claude later)
 * is responsible for translating its native protocol into these shapes.
 *
 * Adding a new provider must NOT require touching the frontend.
 */

// ------------------------------------------------------------------ basics

export type ProviderId = string // 'codex' | 'claude' | ...

export type SessionStatus = 'idle' | 'working' | 'waitingApproval' | 'waitingInput' | 'error'

export type ItemStatus = 'running' | 'done' | 'failed' | 'declined'

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

/**
 * Token accounting for a session, as far as the provider can tell it.
 *
 * The two backends do not count the same things, and the difference is not
 * cosmetic. Measured on 2026-10-15 (`scripts/probe-usage.ts` for Claude, a real
 * `~/.codex/sessions/**` rollout for Codex):
 *
 *   Claude  `input_tokens` EXCLUDES the cached part — a second turn in a 30k
 *           session reports 218 input and 29 952 cache_read. So the prompt that
 *           actually went to the model is input + cache_read + cache_creation,
 *           and calling `input + output` a total gives 220, which is true of
 *           nothing. `modelUsage[model].contextWindow` carries the window.
 *   Codex   `input_tokens` INCLUDES the cached part (20 181 input containing
 *           14 464 cached), and `total_tokens` is exactly input + output. Of
 *           the three figures the notification carries, `last` is the newest
 *           request and `total` is the thread's whole life; `last` is the one
 *           that describes the current context.
 *
 * `promptTokens` is therefore defined by what it means — the prompt a request
 * sent, cache included — rather than by whichever fields each side reports, and
 * every mapper does its own arithmetic to produce it. Adding up the raw fields
 * across providers double-counts the cache on one of them.
 */
export interface Usage {
  /** Prompt size of the newest request, cached part included. */
  promptTokens: number
  /** How much of `promptTokens` the provider served from cache. */
  cachedTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  /**
   * Everything the session has spent, when the backend keeps such a figure.
   *
   * Codex does (`tokenUsage.total`, measured to grow monotonically turn over
   * turn, and it counts turns that ran before this app was opened). Claude's
   * one-subprocess-per-turn model has no equivalent, so it is left undefined
   * there and must be rendered as "unknown" rather than as zero.
   */
  sessionTokens?: number
  /**
   * The model's context window, when the backend publishes one.
   *
   * The one figure both sides give (Codex `modelContextWindow`, Claude
   * `modelUsage[*].contextWindow`), and the reason a phone can show how full
   * the context is — the number that predicts the next compaction.
   */
  contextWindow?: number
}

export interface PlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed'
}

export interface FileChange {
  path: string
  kind: 'add' | 'delete' | 'update'
  diff: string
  /** Set when the change is a rename/move. */
  movePath?: string | null
}

// ------------------------------------------------------------------- items

/** A single unit of work shown as one card in the transcript. */
export type AgentItem =
  | {
      kind: 'message'
      id: string
      role: 'assistant' | 'user'
      text: string
      /**
       * Images the user attached to this message, as opaque tokens to be
       * fetched from `/api/images/<token>`.
       *
       * Tokens rather than bytes, and only on user messages: a transcript is
       * re-fetched whole on every open and every reconnect, so inlining data
       * URLs would make that cost grow with the number of pictures ever sent.
       * A token is content-addressed and therefore immutable, which is what
       * lets the route hand back a year-long cache header.
       *
       * Omitted entirely when there are none — producers must not write an
       * empty array for the common case.
       */
      images?: string[]
      /**
       * When this message was sent, in epoch milliseconds, when it is known.
       *
       * Per message rather than per turn on purpose: an interjection folded
       * into a running turn (Claude's streaming input, Codex's `turn/steer`)
       * arrives long after the turn started, and dating it with the turn's
       * start would be a lie.
       *
       * Absent means "not known", and clients must render nothing in that
       * case — never substitute the turn's start or the time the transcript
       * was read. Codex's stored `UserMessage` carries no timestamp, so its
       * historical batches are legitimately absent.
       */
      at?: number
    }
  | { kind: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      kind: 'command'
      id: string
      command: string
      cwd?: string | null
      status: ItemStatus
      output: string
      exitCode?: number | null
      durationMs?: number | null
    }
  | { kind: 'fileChange'; id: string; status: ItemStatus; changes: FileChange[] }
  | {
      kind: 'mcpTool'
      id: string
      server: string
      tool: string
      status: ItemStatus
      args?: unknown
      result?: unknown
      error?: unknown
    }
  | {
      kind: 'webSearch'
      id: string
      query: string
      status: ItemStatus
      /**
       * What the backend actually did, when it said. A `search` may carry the
       * several queries it really ran (`queries`), which is strictly more than
       * the one `query` the item records; `open_page` and `find_in_page` make
       * this an "opened this URL" card rather than a search at all.
       *
       * Structural rather than the generated `WebSearchAction`, because
       * `packages/protocol/src/generated/` is gitignored and only ever a
       * reference — importing it here would not build.
       */
      action?: { type: string; query?: string; queries?: string[]; url?: string; pattern?: string }
      /**
       * Structured results, when the backend ran the search itself.
       *
       * Opaque on purpose at the app-server boundary (see the generated
       * `WebSearchItem`), so this is a best-effort render and an item that
       * carries none must still read as something. Verified against every
       * `WebSearch` item in this machine's recorded rollouts: they have
       * `action` and no `results` key at all, because the agent's own
       * search tool did the work — the field is for standalone web search.
       */
      results?: unknown[]
    }
  /**
   * The conversation was compacted: older turns were replaced by a summary.
   *
   * Without a card for this the user watches the agent's memory of the session
   * shrink with nothing on screen to explain it — the transcript simply stops
   * matching what the agent can still see. Both backends do emit it (Claude as
   * `system`/`compact_boundary`, Codex as a `contextCompaction` item) but they
   * say different amounts about it: Claude reports the trigger and the token
   * counts before and after, whereas Codex's item is literally `{id, type}`, so
   * every field here but `id` is optional and the card must read sensibly with
   * none of them.
   */
  | {
      kind: 'compaction'
      id: string
      status: ItemStatus
      /** `manual` when the user asked for it, `auto` when the limit was hit. */
      trigger?: 'manual' | 'auto'
      preTokens?: number
      postTokens?: number
    }
  | { kind: 'plan'; id: string; text: string }
  | { kind: 'image'; id: string; url: string }
  | { kind: 'error'; id: string; message: string }
  | {
      kind: 'retry'
      id: string
      attempts: { attempt?: number; maxRetries?: number; delayMs?: number; message: string; at?: string }[]
    }
  /**
   * Catch-all for a tool that has no dedicated card. Providers have far more
   * tools than this union names (Claude alone ships ~20), and the alternative
   * to this item is `unknown`, which clients render as nothing at all — the
   * user sees a turn that stalled for no visible reason. A generic card is
   * strictly better than silence, and lets a provider ship a new tool without
   * a protocol change.
   */
  | {
      kind: 'tool'
      id: string
      /** Raw tool name as the provider calls it, e.g. `Task`. */
      name: string
      /** Human-facing one-liner; falls back to `name` when the provider has none. */
      title: string
      status: ItemStatus
      input?: unknown
      output?: string
      error?: string
      /** Set for subagent dispatch; the phone shows it as a badge, not a tree. */
      subagentType?: string | null
      /** Sub-tool calls seen so far, used as a "still working" heartbeat. */
      childCount?: number
    }
  | { kind: 'unknown'; id: string; type: string }

// ---------------------------------------------------------------- approvals

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

/**
 * A question the agent is blocked on, as opposed to a permission it wants.
 *
 * The distinction matters on the phone: a permission sheet is answered by
 * choosing a verdict, a question is answered by choosing an *option*. The
 * verdict buttons are actively wrong for the second case — answering "allow"
 * tells the agent nothing, and the tool then reports back to the model that
 * the user did not answer, which is exactly what happened before this type
 * existed. See `ApprovalRequest.questions`.
 */
export interface ApprovalQuestion {
  /** The question itself, and the key the answer is filed under. */
  question: string
  /** Short category the agent assigned, e.g. `Colour`. Rendered as a chip. */
  header?: string
  /** The user may pick more than one option. */
  multiSelect?: boolean
  /**
   * Choices, at least two. `preview` is deliberately not carried: the CLI uses
   * it for side-by-side artefacts that a 390px sheet cannot render, and a
   * half-rendered preview is worse than none.
   */
  options: { label: string; description?: string }[]
}

export interface ApprovalRequest {
  /** Stable id used to answer this request. */
  requestId: string
  threadId: string
  turnId: string
  itemId: string
  type: 'command' | 'fileChange' | 'permissions' | 'userInput' | 'other'
  /** Best-effort one-line summary for the sheet header. */
  title: string
  /** e.g. the shell command, or the list of files being written. */
  detail?: string
  cwd?: string | null
  reason?: string | null
  /** Which buttons to render. Authoritative when the provider supplies it. */
  availableDecisions: ApprovalDecision[]
  /**
   * Present when the agent is asking the user something rather than asking
   * permission. A client that renders these MUST send the chosen labels back
   * on `answerApproval` — resolving the request without them is what produced
   * "The user did not answer the questions." on screen.
   */
  questions?: ApprovalQuestion[]
}

// ------------------------------------------------------------------ events

export type AgentEvent =
  | { kind: 'session.status'; threadId: string; status: SessionStatus }
  | { kind: 'thread.title'; threadId: string; title: string | null }
  | { kind: 'turn.started'; threadId: string; turnId: string }
  | {
      kind: 'turn.completed'
      threadId: string
      turnId: string
      status: TurnStatus
      error?: { message: string } | null
      /**
       * When the backend says the turn ended, in epoch milliseconds.
       *
       * Codex's `turn/completed` notification carries it. Claude's live frames
       * carry no timestamp, so there it is absent and the client records its
       * own arrival time — the moment this screen observed the end. Never
       * substitute "now" on the server: a replay would then date the turn to
       * the reconnection.
       */
      at?: number
    }
  /**
   * `item.started`, `item.updated` and `item.completed` all mean "upsert this
   * item by id". Clients should key items by `item.id` and overwrite.
   */
  | { kind: 'item.started'; threadId: string; turnId: string; item: AgentItem }
  | { kind: 'item.updated'; threadId: string; turnId: string; item: AgentItem }
  /**
   * Carries the authoritative final item. Clients that were accumulating
   * `delta` text for this item MUST replace their buffer with `item.text` /
   * `item.output` rather than keeping the concatenation — providers are not
   * required to emit deltas that concatenate to the final text.
   */
  | { kind: 'item.completed'; threadId: string; turnId: string; item: AgentItem }
  | {
      kind: 'delta'
      threadId: string
      turnId: string
      itemId: string
      channel: 'text' | 'reasoning' | 'commandOutput'
      text: string
    }
  | { kind: 'plan.updated'; threadId: string; turnId: string; plan: PlanStep[]; explanation?: string | null }
  | { kind: 'diff.updated'; threadId: string; turnId: string; diff: string }
  | { kind: 'usage.updated'; threadId: string; turnId?: string; usage: Usage }
  /**
   * The backend's own list of slash commands, for the composer's menu.
   *
   * An event rather than a `GET /api/providers/:id/commands` route because the
   * list is not available until the CLI has started once: it arrives on the
   * `system:init` frame of the first turn of a session. A route would answer
   * "empty" to a freshly created session and would never refresh, whereas this
   * lands exactly when the answer becomes known. Empty is a legitimate value
   * (Codex has no such concept) and means "no menu", not "not yet known".
   *
   * The commands are the backend's, never this app's: `/usage`, `/compact` and
   * the rest are expanded by the CLI from ordinary prompt text — measured with
   * `scripts/probe-slash.ts`, which sent `/usage` through `query()` and got the
   * CLI's own report back without a model request.
   */
  | { kind: 'commands.updated'; threadId: string; commands: string[] }
  | { kind: 'approval.requested'; approval: ApprovalRequest }
  | { kind: 'approval.resolved'; threadId: string; requestId: string }
  | {
      kind: 'error'
      threadId?: string
      turnId?: string
      message: string
      willRetry?: boolean
      retryAttempt?: number
      maxRetries?: number
      retryInMs?: number
    }

// ------------------------------------------------------------------- input

export type AgentInput =
  | { type: 'text'; text: string }
  /** Must be a data: URL for providers that reject remote fetch. */
  | { type: 'image'; url: string }
