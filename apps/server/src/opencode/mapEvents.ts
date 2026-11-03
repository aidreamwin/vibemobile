/**
 * opencode SSE frames -> normalized AgentEvents.
 *
 * Stateful because the wire is: text arrives as start/delta/end, tools as
 * input/call/result, and a turn has no id at all. The mapper is the one place
 * that remembers which turn is open, which assistant message a delta belongs
 * to, and which approvals are still waiting for a human.
 *
 * Two rules worth stating because getting them wrong is silent:
 *
 *  - `session.idle` is a STATUS, not the end of a turn. Only
 *    `session.execution.*` ends a turn. A session can go idle between two
 *    executions of the same turn (a tool step), and completing there would
 *    split the transcript.
 *  - Events for sessions this app has never listed are ignored. opencode also
 *    runs hidden title/summary/compaction sessions and every subagent; letting
 *    their `session.status` through would put ghost "working" rows on the phone.
 */
import type { AgentEvent, AgentItem, ApprovalRequest, SessionStatus, Usage } from '@vibemobile/protocol'
import {
  answersToForm,
  decisionToReply,
  FORM_REQUEST_PREFIX,
  formToApproval,
  PERMISSION_REQUEST_PREFIX,
  permissionToApproval,
} from './permission.js'
import type {
  OpencodeEventFrame,
  OpencodeForm,
  OpencodeInboxUser,
  OpencodeModelRef,
  OpencodePermissionRequest,
  OpencodeTokenUsage,
  OpencodeToolContent,
  OpencodeToolState,
} from './types.js'
import { asNumber, asRecord, asString, asStructuredError, asTokenUsage } from './types.js'

interface PendingPermission {
  kind: 'permission'
  sessionID: string
  requestId: string
  approval: ApprovalRequest
}

interface PendingForm {
  kind: 'form'
  sessionID: string
  requestId: string
  approval: ApprovalRequest
  form: OpencodeForm
  plan: NonNullable<ReturnType<typeof formToApproval>>
}

export type PendingApproval = PendingPermission | PendingForm

interface LiveSession {
  id: string
  turnId: string | null
  running: boolean
  status: SessionStatus
  userMessageID: string | null
  items: Map<string, AgentItem>
  text: Map<string, string>
  reasoning: Map<string, string>
  toolInput: Map<string, string>
  toolNames: Map<string, string>
  model: OpencodeModelRef | null
  lastUsage: Usage | null
  sessionTokens: number | undefined
  compactionId: string | null
  compactionText: string
  pending: Map<string, PendingApproval>
  resolved: Set<string>
}

export interface MapperOptions {
  emit: (event: AgentEvent) => void
  cwdOf: (sessionID: string) => string | undefined
  contextWindowOf: (model: OpencodeModelRef | null) => number | undefined
  onLog?: (line: string) => void
}

const HIDDEN_AGENTS = new Set(['title', 'summary', 'compaction', 'checkpoint'])

function emptySession(id: string): LiveSession {
  return {
    id,
    turnId: null,
    running: false,
    status: 'idle',
    userMessageID: null,
    items: new Map(),
    text: new Map(),
    reasoning: new Map(),
    toolInput: new Map(),
    toolNames: new Map(),
    model: null,
    lastUsage: null,
    sessionTokens: undefined,
    compactionId: null,
    compactionText: '',
    pending: new Map(),
    resolved: new Set(),
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const value = part as { type?: unknown; text?: unknown; uri?: unknown }
      if (value.type === 'text' && typeof value.text === 'string') return value.text
      if (value.type === 'file' && typeof value.uri === 'string') return value.uri
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function itemStatus(state: OpencodeToolState): 'running' | 'done' | 'failed' {
  if (state.status === 'completed') return 'done'
  if (state.status === 'error') return 'failed'
  return 'running'
}

function commandName(name: string): boolean {
  return /^(bash|shell|execute|terminal)$/i.test(name) || /(^|_)(bash|shell|execute)$/i.test(name)
}

function toolInput(state: OpencodeToolState): unknown {
  return state.input
}

function toolItem(id: string, name: string, state: OpencodeToolState, cwd: string | undefined): AgentItem {
  if (commandName(name)) {
    const input =
      typeof state.input === 'object' && state.input !== null ? (state.input as Record<string, unknown>) : {}
    const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : ''
    const metadata =
      state.status === 'running' || state.status === 'completed' || state.status === 'error'
        ? state.metadata
        : undefined
    const exitCandidate = metadata?.exitCode ?? metadata?.exit
    const output = state.status === 'completed' || state.status === 'error' ? contentText(state.content) : ''
    return {
      kind: 'command',
      id: `oc:tool:${id}`,
      command,
      ...(cwd ? { cwd } : {}),
      status: itemStatus(state),
      output,
      ...(typeof exitCandidate === 'number' ? { exitCode: exitCandidate } : {}),
    }
  }
  return {
    kind: 'tool',
    id: `oc:tool:${id}`,
    name,
    title: name,
    status: itemStatus(state),
    input: toolInput(state),
    ...(state.status === 'completed' || state.status === 'error' ? { output: contentText(state.content) } : {}),
    ...(state.status === 'error' ? { error: state.error.message } : {}),
  }
}

function usageFrom(
  tokens: OpencodeTokenUsage,
  contextWindow: number | undefined,
  sessionTokens: number | undefined,
): Usage {
  return {
    // Measured against the live service: cache is reported separately, so the
    // prompt is input + cache reads + cache writes. Codex includes the cache in
    // `input`; opencode does not.
    promptTokens: tokens.input + tokens.cache.read + tokens.cache.write,
    cachedTokens: tokens.cache.read,
    outputTokens: tokens.output,
    reasoningOutputTokens: tokens.reasoning,
    ...(sessionTokens === undefined ? {} : { sessionTokens }),
    ...(contextWindow ? { contextWindow } : {}),
  }
}

export class OpencodeEventMapper {
  readonly #opts: MapperOptions
  readonly #sessions = new Map<string, LiveSession>()
  /** Sessions listed/created/resumed by this provider. Others are ignored. */
  readonly #tracked = new Set<string>()

  constructor(opts: MapperOptions) {
    this.#opts = opts
  }

  track(sessionID: string): void {
    if (!sessionID) return
    this.#tracked.add(sessionID)
    this.#state(sessionID)
  }

  forget(sessionID: string): void {
    this.#tracked.delete(sessionID)
    this.#sessions.delete(sessionID)
  }

  tracked(sessionID: string): boolean {
    return this.#tracked.has(sessionID)
  }

  statusOf(sessionID: string): SessionStatus {
    return this.#sessions.get(sessionID)?.status ?? 'idle'
  }

  currentTurnId(sessionID: string): string {
    return this.#sessions.get(sessionID)?.turnId ?? `oc:turn:${sessionID}`
  }

  isRunning(sessionID: string): boolean {
    return this.#sessions.get(sessionID)?.running ?? false
  }

  itemsFor(sessionID: string): AgentItem[] {
    return [...(this.#sessions.get(sessionID)?.items.values() ?? [])]
  }

  pendingFor(sessionID: string): ApprovalRequest[] {
    return [...(this.#sessions.get(sessionID)?.pending.values() ?? [])].map((entry) => entry.approval)
  }

  pendingSessions(): string[] {
    return [...this.#sessions.entries()].filter(([, session]) => session.pending.size > 0).map(([id]) => id)
  }

  pending(requestId: string): PendingApproval | undefined {
    for (const session of this.#sessions.values()) {
      const found = session.pending.get(requestId)
      if (found) return found
    }
    return undefined
  }

  /** Drop an approval the backend no longer holds, and tell every client. */
  resolve(requestId: string): void {
    for (const session of this.#sessions.values()) {
      const entry = session.pending.get(requestId)
      if (!entry) continue
      session.pending.delete(requestId)
      session.resolved.add(requestId)
      this.#emitResolved(session, requestId)
      this.#settleStatus(session)
      return
    }
  }

  /** Re-emit every pending approval for a session (subscribe/resync). */
  replayPending(sessionID: string): void {
    const session = this.#sessions.get(sessionID)
    if (!session) return
    for (const entry of session.pending.values()) {
      this.#opts.emit({ kind: 'approval.requested', approval: entry.approval })
    }
  }

  /** Called by the provider before a prompt, so the first delta has a turn. */
  beginTurn(sessionID: string, inbox: OpencodeInboxUser): string {
    this.track(sessionID)
    const session = this.#state(sessionID)
    session.userMessageID = inbox.id
    if (session.running && session.turnId) {
      // The execution may have started from the inbox event before the HTTP
      // response arrived. If it is this message's turn, re-upserting the user
      // item is harmless (items are keyed by id); a queued message belongs to a
      // later turn and must not be folded into this one.
      if (session.turnId === `oc:turn:${inbox.id}`) {
        this.#emitUserItem(session, inbox.id, inbox.payload.text, inbox.time.created, session.turnId, 'started')
        return session.turnId
      }
      // A queued prompt: its own turn starts when opencode delivers it.
      return `oc:turn:${inbox.id}`
    }
    this.#startTurn(session, inbox.id, inbox.time.created)
    const turnId = session.turnId ?? `oc:turn:${inbox.id}`
    this.#emitUserItem(session, inbox.id, inbox.payload.text, inbox.time.created, turnId, 'started')
    return turnId
  }

  /** Replay a still-running turn after a reconnect. */
  replayRunning(sessionID: string): void {
    const session = this.#sessions.get(sessionID)
    if (!session?.running || !session.turnId) return
    this.#opts.emit({ kind: 'turn.started', threadId: session.id, turnId: session.turnId })
    this.#opts.emit({ kind: 'session.status', threadId: session.id, status: 'working' })
    for (const item of session.items.values()) {
      this.#opts.emit({ kind: 'item.updated', threadId: session.id, turnId: session.turnId, item })
    }
  }

  handle(frame: OpencodeEventFrame): void {
    const data = frame.data
    const type = frame.type
    if (type === 'session.created') {
      this.#onSessionCreated(data)
      return
    }
    if (type === 'permission.asked') {
      this.#onPermissionAsked(data, frame)
      return
    }
    if (type === 'form.created') {
      this.#onFormCreated(data, frame)
      return
    }
    if (type === 'session.deleted') {
      const id = asString(data.sessionID)
      if (id) this.forget(id)
      return
    }
    if (type === 'session.renamed') {
      const id = asString(data.sessionID)
      const title = asString(data.title)
      if (id && this.#tracked.has(id)) this.#opts.emit({ kind: 'thread.title', threadId: id, title })
      return
    }

    const sessionID = asString(data.sessionID)
    if (!sessionID || !this.#tracked.has(sessionID)) return
    const session = this.#state(sessionID)

    switch (type) {
      case 'session.execution.started':
        if (!session.running) this.#startTurn(session, session.userMessageID, frame.created)
        session.status = 'working'
        this.#emitStatus(session, 'working')
        return
      case 'session.execution.succeeded':
        this.#endTurn(session, frame.created, 'completed')
        return
      case 'session.execution.failed': {
        const error = asStructuredError(data.error)
        this.#endTurn(session, frame.created, 'failed', error?.message)
        if (error) this.#opts.emit({ kind: 'error', threadId: session.id, message: error.message })
        return
      }
      case 'session.execution.interrupted':
        this.#endTurn(session, frame.created, 'interrupted')
        return
      case 'session.step.started': {
        const model = asRecord(data.model)
        const providerID = model ? asString(model.providerID) : null
        const id = model ? asString(model.id) : null
        const variant = model ? asString(model.variant) : null
        if (providerID && id) {
          session.model = { id, providerID, ...(variant ? { variant } : {}) }
        }
        if (!session.running) this.#startTurn(session, session.userMessageID, frame.created)
        return
      }
      case 'session.step.ended':
      case 'session.step.failed': {
        const tokens = asTokenUsage(data.tokens)
        if (tokens) this.#usage(session, tokens)
        if (type === 'session.step.failed') {
          const error = asStructuredError(data.error)
          if (error) this.#opts.emit({ kind: 'error', threadId: session.id, message: error.message })
        }
        return
      }
      case 'session.text.started':
        this.#textStart(session, data)
        return
      case 'session.text.delta':
        this.#textDelta(session, data)
        return
      case 'session.text.ended':
        this.#textEnd(session, data)
        return
      case 'session.reasoning.started':
        this.#reasonStart(session, data)
        return
      case 'session.reasoning.delta':
        this.#reasonDelta(session, data)
        return
      case 'session.reasoning.ended':
        this.#reasonEnd(session, data)
        return
      case 'session.tool.input.started':
        this.#toolInputStart(session, data)
        return
      case 'session.tool.input.delta':
        this.#toolInputDelta(session, data)
        return
      case 'session.tool.input.ended':
        this.#toolInputEnd(session, data)
        return
      case 'session.tool.called':
        this.#toolCalled(session, data, frame)
        return
      case 'session.tool.progress':
        this.#toolProgress(session, data)
        return
      case 'session.tool.success':
        this.#toolDone(session, data, 'success')
        return
      case 'session.tool.failed':
        this.#toolDone(session, data, 'failed')
        return
      case 'session.shell.started':
        this.#shell(session, data, false)
        return
      case 'session.shell.ended':
        this.#shell(session, data, true)
        return
      case 'session.compaction.started':
        this.#compactionStart(session, data, frame)
        return
      case 'session.compaction.delta':
        this.#compactionDelta(session, data)
        return
      case 'session.compaction.ended':
        this.#compactionEnd(session, data, 'done')
        return
      case 'session.compaction.failed':
        this.#compactionEnd(session, data, 'failed')
        return
      case 'session.retry.scheduled':
        this.#retry(session, data)
        return
      case 'session.status':
        this.#status(session, data)
        return
      case 'session.idle':
        this.#settleStatus(session)
        return
      case 'session.usage.updated':
        this.#sessionUsage(session, data)
        return
      case 'session.inbox.enqueued':
        this.#inbox(session, data, false)
        return
      case 'session.inbox.delivered':
        this.#inbox(session, data, true)
        return
      case 'session.inbox.cancelled':
        return
      case 'permission.replied':
        this.#resolveById(session, asString(data.requestID), PERMISSION_REQUEST_PREFIX)
        return
      case 'form.replied':
      case 'form.cancelled':
        this.#resolveById(session, asString(data.id), FORM_REQUEST_PREFIX)
        return
      case 'session.model.selected': {
        const model = asRecord(data.model)
        const id = model ? asString(model.id) : null
        const providerID = model ? asString(model.providerID) : null
        const variant = model ? asString(model.variant) : null
        if (id && providerID) session.model = { id, providerID, ...(variant ? { variant } : {}) }
        return
      }
      case 'session.step.streamed':
      case 'session.permissions':
      case 'session.archived':
      case 'session.unarchived':
      case 'session.moved':
      case 'session.metadata.updated':
      case 'session.viewed':
      case 'session.inbox.delivery.changed':
      case 'command.updated':
      case 'filesystem.changed':
      case 'session.instructions.updated':
      case 'session.synthetic':
      case 'session.skill.activated':
      case 'session.forked':
      case 'session.agent.selected':
        return
      default:
        this.#opts.onLog?.(`opencode: ignoring event ${type}`)
    }
  }

  /** The opencode decision for a permission sheet. */
  permissionReply(decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): 'once' | 'always' | 'reject' {
    if (decision === 'cancel') return 'reject'
    return decisionToReply(decision)
  }

  /** Turn the phone's positional form answers into opencode's keyed answer. */
  formAnswer(
    requestId: string,
    answers: readonly string[][] | undefined,
  ): Record<string, string | number | boolean | string[]> {
    const entry = this.pending(requestId)
    if (entry?.kind !== 'form') throw new Error(`not a form: ${requestId}`)
    return answersToForm(entry.plan.visible, entry.plan.hidden, answers)
  }

  // ------------------------------------------------------------- sessions

  #state(sessionID: string): LiveSession {
    const found = this.#sessions.get(sessionID)
    if (found) return found
    const created = emptySession(sessionID)
    this.#sessions.set(sessionID, created)
    return created
  }

  #onSessionCreated(data: Record<string, unknown>): void {
    const id = asString(data.sessionID)
    if (!id) return
    const parentID = asString(data.parentID)
    const agent = asString(data.agent)
    if (parentID || (agent && HIDDEN_AGENTS.has(agent))) return
    this.track(id)
  }

  #startTurn(session: LiveSession, userMessageID: string | null, at: number): void {
    session.running = true
    session.status = 'working'
    session.turnId = `oc:turn:${userMessageID ?? `${session.id}:${at}`}`
    session.items.clear()
    session.text.clear()
    session.reasoning.clear()
    session.toolInput.clear()
    session.toolNames.clear()
    session.compactionId = null
    session.compactionText = ''
    this.#opts.emit({ kind: 'turn.started', threadId: session.id, turnId: session.turnId })
    this.#emitStatus(session, 'working')
  }

  #endTurn(session: LiveSession, at: number, status: 'completed' | 'failed' | 'interrupted', error?: string): void {
    const turnId = session.turnId
    if (!turnId) return
    session.running = false
    session.status = status === 'failed' ? 'error' : 'idle'
    this.#opts.emit({
      kind: 'turn.completed',
      threadId: session.id,
      turnId,
      status,
      ...(error ? { error: { message: error } } : {}),
      at,
    })
    // A permission/form still on screen after its execution ended can never be
    // answered; leaving it there blocks the phone forever.
    for (const entry of session.pending.values()) {
      this.#emitResolved(session, entry.requestId)
    }
    session.pending.clear()
    this.#emitStatus(session, session.status)
  }

  #emitStatus(session: LiveSession, status: SessionStatus): void {
    // Waiting states outrank a backend that still calls itself busy.
    if (status !== 'waitingApproval' && status !== 'waitingInput' && session.pending.size > 0) return
    session.status = status
    this.#opts.emit({ kind: 'session.status', threadId: session.id, status })
  }

  #settleStatus(session: LiveSession): void {
    if (session.pending.size > 0) return
    this.#emitStatus(session, session.running ? 'working' : 'idle')
  }

  #status(session: LiveSession, data: Record<string, unknown>): void {
    const status = asRecord(data.status)
    const type = status ? asString(status.type) : null
    if (status?.type === 'retry') {
      this.#emitStatus(session, 'working')
      return
    }
    if (type === 'busy') {
      this.#emitStatus(session, 'working')
      return
    }
    if (type === 'idle') this.#settleStatus(session)
  }

  #inbox(session: LiveSession, data: Record<string, unknown>, delivered: boolean): void {
    const inboxID = asString(data.inboxID)
    if (!inboxID) return
    const item = asRecord(data.item)
    const payload = item ? asRecord(item.payload) : null
    const text = payload ? asString(payload.text) : null
    const delivery = item ? asString(item.delivery) : null
    const at = item ? (asNumber(asRecord(item.time)?.created) ?? Date.now()) : Date.now()
    if (!delivered) {
      if (text === null) return
      const turnId = delivery === 'steer' && session.running && session.turnId ? session.turnId : `oc:turn:${inboxID}`
      this.#emitUserItem(session, inboxID, text, at, turnId, 'started')
      return
    }
    // Delivered starts the execution. For a queued message the item was already
    // emitted under `oc:turn:<inboxID>`, which is exactly the id this turn gets.
    session.userMessageID = inboxID
    if (!session.running) this.#startTurn(session, inboxID, at)
  }

  #emitUserItem(
    session: LiveSession,
    inboxID: string,
    text: string,
    at: number,
    turnId: string,
    kind: 'started' | 'updated',
  ): void {
    this.#emitItem(session, turnId, { kind: 'message', id: `oc:user:${inboxID}`, role: 'user', text, at }, kind)
  }

  // -------------------------------------------------------------- approvals

  #onPermissionAsked(data: Record<string, unknown>, frame: OpencodeEventFrame): void {
    const request = parsePermission(data)
    if (!request) return
    if (!this.#tracked.has(request.sessionID)) return
    const session = this.#state(request.sessionID)
    const approval = permissionToApproval(request, {
      turnId: this.currentTurnId(session.id),
      cwd: this.#opts.cwdOf(session.id),
    })
    if (session.pending.has(approval.requestId)) return
    session.pending.set(approval.requestId, {
      kind: 'permission',
      sessionID: session.id,
      requestId: approval.requestId,
      approval,
    })
    this.#opts.emit({ kind: 'approval.requested', approval })
    this.#emitStatus(session, 'waitingApproval')
    void frame
  }

  #onFormCreated(data: Record<string, unknown>, frame: OpencodeEventFrame): void {
    const form = parseForm(data.form)
    if (!form) return
    if (!this.#tracked.has(form.sessionID)) return
    const session = this.#state(form.sessionID)
    const plan = formToApproval(form, {
      turnId: this.currentTurnId(session.id),
      cwd: this.#opts.cwdOf(session.id),
    })
    if (!plan) {
      // No sheet can be rendered, so do not claim a waiting state the phone
      // cannot clear. The error tells the operator to answer in opencode.
      this.#opts.emit({
        kind: 'error',
        threadId: session.id,
        message: '该表单包含手机无法回答的字段，请在 opencode 客户端回答',
      })
      return
    }
    if (session.pending.has(plan.approval.requestId)) return
    session.pending.set(plan.approval.requestId, {
      kind: 'form',
      sessionID: session.id,
      requestId: plan.approval.requestId,
      approval: plan.approval,
      form,
      plan,
    })
    this.#opts.emit({ kind: 'approval.requested', approval: plan.approval })
    this.#emitStatus(session, 'waitingInput')
    void frame
  }

  #resolveById(session: LiveSession, id: string | null, prefix: string): void {
    if (!id) return
    const requestId = prefix + id
    if (!session.pending.has(requestId)) return
    session.pending.delete(requestId)
    session.resolved.add(requestId)
    this.#emitResolved(session, requestId)
    this.#settleStatus(session)
  }

  #emitResolved(session: LiveSession, requestId: string): void {
    this.#opts.emit({ kind: 'approval.resolved', threadId: session.id, requestId })
  }

  // ------------------------------------------------------------------ items

  #assistantMessage(data: Record<string, unknown>): { messageID: string; turnId: string } | null {
    const messageID = asString(data.assistantMessageID)
    const sessionID = asString(data.sessionID)
    if (!messageID || !sessionID) return null
    const session = this.#state(sessionID)
    if (!session.turnId) return null
    return { messageID, turnId: session.turnId }
  }

  #emitItem(session: LiveSession, turnId: string, item: AgentItem, kind: 'started' | 'updated' | 'completed'): void {
    session.items.set(item.id, item)
    this.#opts.emit({
      kind: `item.${kind}` as 'item.started' | 'item.updated' | 'item.completed',
      threadId: session.id,
      turnId,
      item,
    })
  }

  #ordinal(data: Record<string, unknown>): number {
    return asNumber(data.ordinal) ?? 0
  }

  #textStart(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    if (!message) return
    const id = `oc:text:${message.messageID}:${this.#ordinal(data)}`
    session.text.set(id, '')
    this.#emitItem(session, message.turnId, { kind: 'message', id, role: 'assistant', text: '' }, 'started')
  }

  #textDelta(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    if (!message) return
    const id = `oc:text:${message.messageID}:${this.#ordinal(data)}`
    const delta = asString(data.delta) ?? ''
    const text = (session.text.get(id) ?? '') + delta
    session.text.set(id, text)
    this.#emitItem(session, message.turnId, { kind: 'message', id, role: 'assistant', text }, 'updated')
    this.#opts.emit({
      kind: 'delta',
      threadId: session.id,
      turnId: message.turnId,
      itemId: id,
      channel: 'text',
      text: delta,
    })
  }

  #textEnd(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    if (!message) return
    const id = `oc:text:${message.messageID}:${this.#ordinal(data)}`
    const text = asString(data.text) ?? session.text.get(id) ?? ''
    session.text.set(id, text)
    this.#emitItem(session, message.turnId, { kind: 'message', id, role: 'assistant', text }, 'completed')
  }

  #reasonStart(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    if (!message) return
    const id = `oc:reasoning:${message.messageID}:${this.#ordinal(data)}`
    session.reasoning.set(id, '')
    this.#emitItem(session, message.turnId, { kind: 'reasoning', id, summary: [], content: [''] }, 'started')
  }

  #reasonDelta(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    if (!message) return
    const id = `oc:reasoning:${message.messageID}:${this.#ordinal(data)}`
    const delta = asString(data.delta) ?? ''
    const text = (session.reasoning.get(id) ?? '') + delta
    session.reasoning.set(id, text)
    this.#opts.emit({
      kind: 'delta',
      threadId: session.id,
      turnId: message.turnId,
      itemId: id,
      channel: 'reasoning',
      text: delta,
    })
  }

  #reasonEnd(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    if (!message) return
    const id = `oc:reasoning:${message.messageID}:${this.#ordinal(data)}`
    const text = asString(data.text) ?? session.reasoning.get(id) ?? ''
    session.reasoning.set(id, text)
    this.#emitItem(session, message.turnId, { kind: 'reasoning', id, summary: [], content: [text] }, 'completed')
  }

  #toolId(data: Record<string, unknown>): string | null {
    return asString(data.id)
  }

  /**
   * The tool name is only carried by `input.started`/`called`; the result
   * events have just the id. Forgetting this turns every completed shell call
   * into a generic tool card instead of a command.
   */
  #toolName(session: LiveSession, id: string, data: Record<string, unknown>): string {
    const name = asString(data.name)
    if (name) {
      session.toolNames.set(id, name)
      return name
    }
    return session.toolNames.get(id) ?? 'tool'
  }

  #toolInputStart(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    const id = this.#toolId(data)
    if (!message || !id) return
    const name = this.#toolName(session, id, data)
    session.toolNames.set(id, name)
    session.toolInput.set(id, '')
    this.#emitItem(
      session,
      message.turnId,
      { kind: 'tool', id: `oc:tool:${id}`, name, title: name, status: 'running', input: '' },
      'started',
    )
  }

  #toolInputDelta(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    const id = this.#toolId(data)
    if (!message || !id) return
    const name = this.#toolName(session, id, data)
    const text = (session.toolInput.get(id) ?? '') + (asString(data.delta) ?? '')
    session.toolInput.set(id, text)
    this.#emitItem(
      session,
      message.turnId,
      { kind: 'tool', id: `oc:tool:${id}`, name, title: name, status: 'running', input: text },
      'updated',
    )
  }

  #toolInputEnd(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    const id = this.#toolId(data)
    if (!message || !id) return
    const name = this.#toolName(session, id, data)
    const text = asString(data.text) ?? session.toolInput.get(id) ?? ''
    session.toolInput.set(id, text)
    this.#emitItem(
      session,
      message.turnId,
      { kind: 'tool', id: `oc:tool:${id}`, name, title: name, status: 'running', input: text },
      'updated',
    )
  }

  #toolCalled(session: LiveSession, data: Record<string, unknown>, frame: OpencodeEventFrame): void {
    const message = this.#assistantMessage(data)
    const id = this.#toolId(data)
    if (!message || !id) return
    const name = this.#toolName(session, id, data)
    const state: OpencodeToolState = {
      status: 'running',
      input: asRecord(data.input) ?? {},
      metadata: asRecord(data.metadata) ?? {},
    }
    this.#emitItem(session, message.turnId, toolItem(id, name, state, this.#opts.cwdOf(session.id)), 'updated')
    void frame
  }

  #toolProgress(session: LiveSession, data: Record<string, unknown>): void {
    const message = this.#assistantMessage(data)
    const id = this.#toolId(data)
    if (!message || !id) return
    const name = this.#toolName(session, id, data)
    const input = asRecord(data.input) ?? {}
    const state: OpencodeToolState = {
      status: 'running',
      input,
      metadata: asRecord(data.metadata) ?? {},
    }
    this.#emitItem(session, message.turnId, toolItem(id, name, state, this.#opts.cwdOf(session.id)), 'updated')
  }

  #toolDone(session: LiveSession, data: Record<string, unknown>, outcome: 'success' | 'failed'): void {
    const message = this.#assistantMessage(data)
    const id = this.#toolId(data)
    if (!message || !id) return
    const name = this.#toolName(session, id, data)
    const input = asRecord(data.input) ?? {}
    const content = Array.isArray(data.content) ? (data.content as OpencodeToolContent[]) : []
    const error = asStructuredError(data.error)
    const state: OpencodeToolState =
      outcome === 'failed'
        ? {
            status: 'error',
            input,
            error: error ?? { type: 'tool', message: 'tool failed' },
            content,
            metadata: asRecord(data.metadata) ?? {},
          }
        : { status: 'completed', input, content, metadata: asRecord(data.metadata) ?? {} }
    this.#emitItem(session, message.turnId, toolItem(id, name, state, this.#opts.cwdOf(session.id)), 'completed')
  }

  #shell(session: LiveSession, data: Record<string, unknown>, ended: boolean): void {
    const shell = asRecord(data.shell)
    if (!shell) return
    const shellID = asString(shell.id)
    if (!shellID) return
    const command = asString(shell.command) ?? ''
    const output = asRecord(data.output)
    const text = output ? (asString(output.output) ?? '') : ''
    const exit = asNumber(shell.exit) ?? asNumber(output?.exit)
    const status: 'running' | 'done' | 'failed' = ended
      ? exit === undefined || exit === 0
        ? 'done'
        : 'failed'
      : 'running'
    const item: AgentItem = {
      kind: 'command',
      id: `oc:shell:${shellID}`,
      command,
      status,
      output: text,
      ...(typeof exit === 'number' ? { exitCode: exit } : {}),
    }
    const turnId = session.turnId ?? `oc:turn:${session.id}`
    this.#emitItem(session, turnId, item, ended ? 'completed' : 'started')
  }

  #compactionStart(session: LiveSession, data: Record<string, unknown>, frame: OpencodeEventFrame): void {
    const inputID = asString(data.inputID)
    const id = `oc:compaction:${inputID ?? frame.id}`
    session.compactionId = id
    session.compactionText = ''
    const turnId = session.turnId ?? `oc:turn:${session.id}`
    this.#emitItem(
      session,
      turnId,
      {
        kind: 'compaction',
        id,
        status: 'running',
        ...(asString(data.reason) === 'manual' || asString(data.reason) === 'auto'
          ? { trigger: asString(data.reason) as 'manual' | 'auto' }
          : {}),
      },
      'started',
    )
  }

  #compactionDelta(session: LiveSession, data: Record<string, unknown>): void {
    const id = session.compactionId
    if (!id) return
    session.compactionText += asString(data.text) ?? ''
  }

  #compactionEnd(session: LiveSession, data: Record<string, unknown>, status: 'done' | 'failed'): void {
    const id = session.compactionId ?? `oc:compaction:${session.id}`
    const turnId = session.turnId ?? `oc:turn:${session.id}`
    this.#emitItem(
      session,
      turnId,
      {
        kind: 'compaction',
        id,
        status,
        ...(asString(data.reason) === 'manual' || asString(data.reason) === 'auto'
          ? { trigger: asString(data.reason) as 'manual' | 'auto' }
          : {}),
      },
      'completed',
    )
    session.compactionId = null
    if (status === 'failed') {
      const error = asStructuredError(data.error)
      if (error) this.#opts.emit({ kind: 'error', threadId: session.id, message: error.message })
    }
  }

  #retry(session: LiveSession, data: Record<string, unknown>): void {
    const error = asStructuredError(data.error)
    const attempt = asNumber(data.attempt) ?? 0
    const delay = asNumber(data.at)
    this.#opts.emit({
      kind: 'error',
      threadId: session.id,
      message: error?.message ?? 'retrying',
      willRetry: true,
      retryAttempt: attempt,
      ...(delay !== null && delay > Date.now() ? { retryInMs: delay - Date.now() } : {}),
    })
    if (session.turnId) {
      this.#emitItem(
        session,
        session.turnId,
        {
          kind: 'retry',
          id: `oc:retry:${session.turnId}:${attempt}`,
          attempts: [{ attempt, message: error?.message ?? 'retrying' }],
        },
        'started',
      )
    }
  }

  #usage(session: LiveSession, tokens: OpencodeTokenUsage): void {
    const usage = usageFrom(tokens, this.#opts.contextWindowOf(session.model), session.sessionTokens)
    session.lastUsage = usage
    this.#opts.emit({
      kind: 'usage.updated',
      threadId: session.id,
      ...(session.turnId ? { turnId: session.turnId } : {}),
      usage,
    })
  }

  #sessionUsage(session: LiveSession, data: Record<string, unknown>): void {
    const tokens = asTokenUsage(data.tokens)
    if (!tokens) return
    const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    session.sessionTokens = total
    if (!session.lastUsage) return
    const usage: Usage = { ...session.lastUsage, sessionTokens: total }
    session.lastUsage = usage
    this.#opts.emit({
      kind: 'usage.updated',
      threadId: session.id,
      ...(session.turnId ? { turnId: session.turnId } : {}),
      usage,
    })
  }
}

function parsePermission(data: Record<string, unknown>): OpencodePermissionRequest | null {
  const id = asString(data.id)
  const sessionID = asString(data.sessionID)
  const action = asString(data.action)
  const resources = Array.isArray(data.resources)
    ? data.resources.filter((value): value is string => typeof value === 'string')
    : null
  if (!id || !sessionID || !action || !resources) return null
  const source = asRecord(data.source)
  const sourceId = source ? asString(source.id) : null
  const sourceMessage = source ? asString(source.messageID) : null
  return {
    id,
    sessionID,
    action,
    resources,
    ...(typeof data.message === 'string' ? { message: data.message } : {}),
    ...(sourceId && sourceMessage ? { source: { type: 'tool', messageID: sourceMessage, id: sourceId } } : {}),
  }
}

function parseForm(value: unknown): OpencodeForm | null {
  const record = asRecord(value)
  if (!record) return null
  const id = asString(record.id)
  const sessionID = asString(record.sessionID)
  const title = asString(record.title)
  const fields = Array.isArray(record.fields) ? record.fields : null
  if (!id || !sessionID || title === null || !fields) return null
  return {
    id,
    sessionID,
    title,
    fields: fields as OpencodeForm['fields'],
    ...(asRecord(record.metadata) ? { metadata: asRecord(record.metadata) as Record<string, unknown> } : {}),
  }
}
