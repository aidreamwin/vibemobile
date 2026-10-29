/**
 * Translation layer: Codex app-server notifications -> normalized AgentEvent.
 *
 * Everything Codex-specific about the event stream lives in this file. The
 * rest of the server (and the entire web client) only sees AgentEvent.
 */
import type {
  AgentEvent,
  AgentItem,
  ApprovalQuestion,
  ApprovalRequest,
  ItemStatus,
  PlanStep,
  SessionStatus,
  TurnStatus,
  Usage,
} from '@vibemobile/protocol'

// --------------------------------------------------------------- primitives

export function mapItemStatus(status: string): ItemStatus {
  switch (status) {
    case 'inProgress':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'declined':
      return 'declined'
    default:
      return 'running'
  }
}

/**
 * A `Turn.completedAt` as epoch milliseconds.
 *
 * Codex writes Unix seconds (see the generated `Turn`). Undefined in,
 * undefined out: an absent value must stay absent so the client can use its
 * own arrival time instead of receiving a fabricated one.
 */
function turnEpoch(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value < 1e12 ? value * 1000 : value)
}

export function mapThreadStatus(status: any): SessionStatus {
  switch (status?.type) {
    case 'idle':
      return 'idle'
    case 'systemError':
      return 'error'
    case 'notLoaded':
      return 'idle'
    case 'active': {
      const flags: string[] = status.activeFlags ?? []
      if (flags.includes('waitingOnApproval')) return 'waitingApproval'
      if (flags.includes('waitingOnUserInput')) return 'waitingInput'
      return 'working'
    }
    default:
      return 'idle'
  }
}

/**
 * `thread/tokenUsage/updated` → `Usage`.
 *
 * Takes the whole `tokenUsage` object, not a breakdown, because which of the
 * two breakdowns to show is the entire question. Measured against a recorded
 * rollout (2026-10-15): `total` grows monotonically for the whole thread
 * (17 304 → 37 485 → 66 459 → 108 133 across four requests) while `last`
 * describes the newest request only (17 304 → 20 181 → 28 974 → 41 674, i.e.
 * the prompt as it grew). A counter labelled "context" fed from `total` would
 * climb past the context window and never come down.
 *
 * Codex's `inputTokens` already contains `cachedInputTokens`, so the prompt is
 * `inputTokens` itself here — unlike Claude, where the cached part sits
 * outside it. That asymmetry is why `Usage.promptTokens` is defined by meaning
 * rather than by field names; see the note on `Usage` in the protocol.
 */
export function mapUsage(tokenUsage: any): Usage {
  const last = tokenUsage?.last ?? tokenUsage?.total ?? {}
  const total = tokenUsage?.total
  const window = tokenUsage?.modelContextWindow
  return {
    promptTokens: last.inputTokens ?? 0,
    cachedTokens: last.cachedInputTokens ?? 0,
    outputTokens: last.outputTokens ?? 0,
    reasoningOutputTokens: last.reasoningOutputTokens ?? 0,
    // Omitted rather than zeroed when the app-server reports none: a session
    // total of 0 is a claim, and the client renders undefined as "unknown".
    ...(typeof total?.totalTokens === 'number' ? { sessionTokens: total.totalTokens } : {}),
    ...(typeof window === 'number' && window > 0 ? { contextWindow: window } : {}),
  }
}

// -------------------------------------------------------------------- items

function textParts(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : value == null ? [] : [value]
  return parts
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) {
        return typeof part.text === 'string' ? part.text : ''
      }
      return ''
    })
    .filter((part) => part.trim().length > 0)
}

/**
 * How a mapper resolves an attached image into a token. Supplied by the
 * provider, which owns the `ImageStore`; the mapper stays pure and file-system
 * free so it can be unit-tested directly.
 *
 * Resolving through a callback rather than attaching the raw `data:` URL and
 * rewriting it later is deliberate: the raw URL is 4–80 KB of base64, and any
 * escape hatch that carried it on an item would put it on the WebSocket the
 * first time some path forgot to rewrite. Here it cannot reach an item at all.
 */
export interface MapItemOptions {
  onImage?: (dataUrl: string) => string | null
}

/**
 * The image parts of an echoed user message, resolved to store tokens.
 *
 * Both field names are read, because the SAME item is serialized two ways and
 * both were measured on 0.162.1:
 *
 *   wire (`item/started`/`item/completed`, and `thread/turns/list`) → `url`
 *     {"type":"image","url":"data:image/png;base64,...","detail":null}
 *   rollout JSONL (`event_msg` / `item_completed`)                 → `image_url`
 *     {"type":"image","image_url":"data:image/png;base64,..."}
 *
 * The rollout is not read by this code today, so `url` alone would be enough —
 * and the first version of this function did read only `image_url`, taken from
 * the rollout, which silently matched nothing on the live path. `smoke-image.ts`
 * is what caught it. Both are accepted because the two spellings are the same
 * field in two sinks, not a guess about a future version; the risk of a
 * regression here is a picture that quietly never appears.
 *
 * `url` is also the name `toCodexInput` SENDS, which is a coincidence worth
 * noticing: the round trip is symmetrical on the wire and only diverges in the
 * file on disk.
 */
function imagesFromContent(content: any[], onImage: (dataUrl: string) => string | null): string[] {
  const tokens: string[] = []
  for (const part of content) {
    if (part?.type !== 'image') continue
    // Only inline data URLs qualify — the store parses and re-hashes those, and
    // a http(s) URL here would mean the bytes are not ours to serve.
    const url = part.url ?? part.image_url
    if (typeof url !== 'string' || !url.startsWith('data:')) continue
    const token = onImage(url)
    if (token) tokens.push(token)
  }
  return tokens
}

/** Codex `ThreadItem` -> normalized `AgentItem`. */
export function normalizeItem(item: any, opts?: MapItemOptions): AgentItem {
  if (!item || typeof item !== 'object') {
    return { kind: 'unknown', id: 'unknown', type: 'malformed' }
  }

  switch (item.type) {
    case 'agentMessage':
      return { kind: 'message', id: item.id, role: 'assistant', text: item.text ?? '' }

    case 'userMessage': {
      // User messages echo back what we sent. Text is rendered; images are
      // resolved to tokens so the transcript can show what was attached.
      const content = Array.isArray(item.content) ? item.content : []
      const text = content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
      const images = opts?.onImage ? imagesFromContent(content, opts.onImage) : []
      // Two separate returns so the key is absent rather than empty: `images:
      // []` would be a second representation of "no images" for every consumer
      // to handle, and the common case has none.
      return images.length
        ? { kind: 'message', id: item.id, role: 'user', text, images }
        : { kind: 'message', id: item.id, role: 'user', text }
    }

    case 'reasoning':
      return {
        kind: 'reasoning',
        id: item.id,
        // Thread items use string arrays while raw Responses API items use
        // `{ type, text }` parts. Accept both because app-server snapshots and
        // live notifications have used both shapes across versions.
        summary: textParts(item.summary),
        content: textParts(item.content),
      }

    case 'commandExecution':
      return {
        kind: 'command',
        id: item.id,
        command: item.command ?? '',
        cwd: item.cwd ?? null,
        status: mapItemStatus(item.status),
        output: item.aggregatedOutput ?? '',
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null,
      }

    case 'fileChange':
      return {
        kind: 'fileChange',
        id: item.id,
        status: mapItemStatus(item.status),
        changes: (item.changes ?? []).map((c: any) => ({
          path: c.path,
          kind: patchChangeKind(c.kind),
          diff: c.diff ?? '',
          movePath: c.kind?.movePath ?? null,
        })),
      }

    case 'mcpToolCall':
      return {
        kind: 'mcpTool',
        id: item.id,
        server: item.server ?? '',
        tool: item.tool ?? '',
        status: mapItemStatus(item.status),
        args: item.arguments,
        result: item.result,
        error: item.error,
      }

    // `status` is hardcoded because the item type has no status field at all
    // (generated `WebSearchItem` is `{id, query, action, results}`) and this
    // frame only ever arrives once the search is over. `action` and `results`
    // are dropped when absent rather than defaulted, so the card can tell
    // "the backend did not say" from "the backend said nothing happened".
    case 'webSearch':
      return {
        kind: 'webSearch',
        id: item.id,
        query: item.query ?? '',
        status: 'done',
        ...(item.action && typeof item.action === 'object' ? { action: item.action } : {}),
        ...(Array.isArray(item.results) && item.results.length > 0 ? { results: item.results } : {}),
      }

    case 'plan':
      return { kind: 'plan', id: item.id, text: item.text ?? '' }

    case 'imageView':
      return { kind: 'image', id: item.id, url: item.url ?? '' }

    // Was falling through to `unknown`, which `ItemCard` renders as nothing at
    // all — so the one event that explains why the agent can no longer see the
    // start of the conversation was the one event the user could not see. The
    // item is literally `{id, type}` (see the generated
    // `ContextCompactionThreadItem`), hence no detail beyond the fact.
    case 'contextCompaction':
      return { kind: 'compaction', id: item.id, status: 'done' }

    case 'error':
      return { kind: 'error', id: item.id, message: item.message ?? 'unknown error' }

    default:
      return { kind: 'unknown', id: item.id ?? 'unknown', type: String(item.type) }
  }
}

function patchChangeKind(kind: any): 'add' | 'delete' | 'update' {
  const t = typeof kind === 'string' ? kind : kind?.type
  if (t === 'add' || t === 'delete' || t === 'update') return t
  return 'update'
}

// -------------------------------------------------------------- approvals

/**
 * Build the normalized approval request shown in the UI.
 *
 * `availableDecisions` is experimental-gated; when the server omits it we fall
 * back to the full set (the UI still lets the user pick).
 */
export function normalizeApproval(method: string, params: any): ApprovalRequest {
  const base = {
    requestId: '', // filled in by the caller, which owns the JSON-RPC id
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
  }

  if (method === 'item/commandExecution/requestApproval') {
    const command: string = params.command ?? params.reason ?? ''
    return {
      ...base,
      type: 'command',
      title: params.reason ? `Approve: ${params.reason}` : 'Approve command',
      detail: command,
      cwd: params.cwd ?? null,
      reason: params.reason ?? null,
      availableDecisions: decisionList(params.availableDecisions, ['accept', 'acceptForSession', 'decline', 'cancel']),
    }
  }

  if (method === 'item/fileChange/requestApproval') {
    return {
      ...base,
      type: 'fileChange',
      title: params.reason ? `Approve file changes: ${params.reason}` : 'Approve file changes',
      detail: params.grantRoot ? `Write access under ${params.grantRoot}` : undefined,
      cwd: params.grantRoot ?? null,
      reason: params.reason ?? null,
      availableDecisions: decisionList(params.availableDecisions, ['accept', 'acceptForSession', 'decline', 'cancel']),
    }
  }

  if (method === 'item/permissions/requestApproval') {
    return {
      ...base,
      type: 'permissions',
      title: params.reason ?? 'Additional permissions requested',
      detail: params.permissions ? JSON.stringify(params.permissions, null, 2) : undefined,
      cwd: params.cwd ?? null,
      reason: params.reason ?? null,
      availableDecisions: ['accept', 'decline'],
    }
  }

  if (method === 'item/tool/requestUserInput') {
    const questions = questionsFor(params)
    return {
      ...base,
      // `userInput` + `questions` is the same pair Claude emits for its
      // AskUserQuestion, and it is what switches the phone's sheet from a
      // verdict card to a form. `questions` is omitted when the payload cannot
      // be read, which falls the sheet back to the ordinary card rather than
      // rendering a form nobody can submit.
      type: 'userInput',
      title: questions?.[0]?.question ?? 'The agent needs input',
      detail: questions ? undefined : questionsDetail(params),
      // No `acceptForSession`: "always allow" is a rule about a tool, and there
      // is no rule to install — the next question is a different question.
      availableDecisions: ['accept', 'decline', 'cancel'],
      questions,
    }
  }

  return {
    ...base,
    type: 'other',
    title: `Approval requested (${method})`,
    availableDecisions: ['accept', 'decline'],
  }
}

/**
 * Read `item/tool/requestUserInput`'s questions into the protocol's shape.
 *
 * The wire's own shape (`ToolRequestUserInputQuestion`) is close but not the
 * same: options are optional there and every question carries an `id`, while
 * the protocol's form has no id — the phone answers positionally and only the
 * provider knows what each position is called on the wire (see
 * `CodexProvider.#questionIds`).
 *
 * `undefined` when there is nothing a form could render, so the caller falls
 * back to the ordinary approval card. That is a deliberate refusal to guess:
 * a form with an option list that cannot satisfy its own submit button is worse
 * than a card showing the raw payload.
 */
export function questionsFor(params: any): ApprovalQuestion[] | undefined {
  const raw = params?.questions
  if (!Array.isArray(raw) || raw.length === 0) return undefined

  const questions: ApprovalQuestion[] = []
  for (const item of raw) {
    const q = item as Record<string, any> | null
    const question = typeof q?.question === 'string' ? q.question.trim() : ''
    if (!question) return undefined

    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o: any) => ({
        label: typeof o?.label === 'string' ? o.label.trim() : '',
        description: typeof o?.description === 'string' ? o.description : undefined,
      }))
      .filter((o) => o.label)
    // Same floor as the Claude side: one option is not a question, and zero is
    // a question with no way to answer it. A secret question (`isSecret`) is
    // expected to arrive without options and lands here on purpose.
    if (options.length < 2) return undefined

    questions.push({
      question,
      header: typeof q?.header === 'string' && q.header.trim() ? q.header.trim() : undefined,
      options,
    })
  }
  return questions
}

/**
 * Encode the phone's choices for `ToolRequestUserInputResponse`, or `null` when
 * they do not line up.
 *
 * `null` is a refusal to guess, exactly as on the Claude side: an answer that is
 * incomplete or over-long is no answer at all rather than the first plausible
 * thing in the list. The caller answers the request with an empty map in that
 * case — the request has to be answered either way, or the turn hangs.
 *
 * The pairing is positional because the protocol's question shape carries no
 * id; `questionIds` is what the provider kept from the original payload.
 */
export function answersForQuestions(
  questionIds: string[],
  answers: string[][] | undefined,
): Record<string, { answers: string[] }> | null {
  if (!Array.isArray(answers) || answers.length !== questionIds.length) return null

  const out: Record<string, { answers: string[] }> = {}
  for (const [i, id] of questionIds.entries()) {
    if (!id) return null
    const picked = (Array.isArray(answers[i]) ? answers[i] : [])
      .filter((label): label is string => typeof label === 'string')
      .map((label) => label.trim())
      .filter(Boolean)
    if (picked.length === 0) return null
    out[id] = { answers: picked }
  }
  return out
}

/** The raw question text, for the fallback card that could not build a form. */
function questionsDetail(params: any): string {
  const raw = Array.isArray(params?.questions) ? params.questions : []
  return raw.map((q: any) => (typeof q?.question === 'string' ? q.question : JSON.stringify(q))).join('\n')
}

/**
 * The server's list is authoritative but can contain object forms
 * (`acceptWithExecpolicyAmendment`) that the mobile UI does not render yet.
 * Keep only the plain string decisions we support, preserving server order.
 */
function decisionList(fromServer: unknown, fallback: string[]): any[] {
  if (!Array.isArray(fromServer) || fromServer.length === 0) return fallback
  const plain = fromServer.filter((d) => typeof d === 'string')
  return plain.length ? plain : fallback
}

// ----------------------------------------------------------- notifications

/**
 * Map one app-server notification to a normalized event.
 * Returns null for notifications we deliberately ignore.
 */
export function mapNotification(method: string, params: any, opts?: MapItemOptions): AgentEvent | null {
  switch (method) {
    case 'item/agentMessage/delta':
      return {
        kind: 'delta',
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        channel: 'text',
        text: params.delta ?? '',
      }

    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      return {
        kind: 'delta',
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        channel: 'reasoning',
        text: params.delta ?? '',
      }

    case 'item/commandExecution/outputDelta':
      return {
        kind: 'delta',
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        channel: 'commandOutput',
        text: params.delta ?? '',
      }

    case 'item/started':
      return {
        kind: 'item.started',
        threadId: params.threadId,
        turnId: params.turnId,
        item: normalizeItem(params.item, opts),
      }

    case 'item/completed':
      return {
        kind: 'item.completed',
        threadId: params.threadId,
        turnId: params.turnId,
        item: normalizeItem(params.item, opts),
      }

    case 'item/fileChange/patchUpdated': {
      // Streams the diff for a fileChange item that already started.
      const changes = (params.changes ?? []).map((c: any) => ({
        path: c.path,
        kind: patchChangeKind(c.kind),
        diff: c.diff ?? '',
        movePath: c.kind?.movePath ?? null,
      }))
      return {
        kind: 'item.updated',
        threadId: params.threadId,
        turnId: params.turnId,
        item: { kind: 'fileChange', id: params.itemId, status: 'running', changes },
      }
    }

    case 'turn/started':
      return { kind: 'turn.started', threadId: params.threadId, turnId: params.turn?.id }

    case 'turn/completed':
      return {
        kind: 'turn.completed',
        threadId: params.threadId,
        turnId: params.turn?.id,
        status: (params.turn?.status ?? 'completed') as TurnStatus,
        error: params.turn?.error ? { message: params.turn.error.message ?? 'turn failed' } : null,
        at: turnEpoch(params.turn?.completedAt),
      }

    case 'turn/plan/updated':
      return {
        kind: 'plan.updated',
        threadId: params.threadId,
        turnId: params.turnId,
        explanation: params.explanation ?? null,
        plan: (params.plan ?? []) as PlanStep[],
      }

    case 'turn/diff/updated':
      return {
        kind: 'diff.updated',
        threadId: params.threadId,
        turnId: params.turnId,
        diff: params.diff ?? '',
      }

    case 'thread/status/changed':
      return {
        kind: 'session.status',
        threadId: params.threadId,
        status: mapThreadStatus(params.status),
      }

    case 'thread/name/updated':
      return {
        kind: 'thread.title',
        threadId: params.threadId,
        title: params.threadName ?? null,
      }

    case 'thread/tokenUsage/updated':
      return {
        kind: 'usage.updated',
        threadId: params.threadId,
        turnId: params.turnId,
        // The whole `tokenUsage`, not one of its breakdowns: `mapUsage` needs
        // both (`last` for the context, `total` for the session) plus the
        // context window, which lives beside them.
        usage: mapUsage(params.tokenUsage),
      }

    case 'serverRequest/resolved':
      return {
        kind: 'approval.resolved',
        threadId: params.threadId,
        requestId: String(params.requestId),
      }

    case 'error':
      return {
        kind: 'error',
        threadId: params.threadId,
        turnId: params.turnId,
        message: params.error?.message ?? 'unknown error',
        willRetry: params.willRetry,
      }

    case 'warning':
      return {
        kind: 'error',
        threadId: params.threadId,
        message: params.message ?? 'warning',
      }

    default:
      return null
  }
}
