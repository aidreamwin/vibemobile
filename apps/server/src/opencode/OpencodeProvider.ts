/**
 * The opencode AgentProvider.
 *
 * Transport is HTTP + SSE to either the user's own opencode service or a
 * private `opencode serve`; see `server.ts` for why attach-first matters. This
 * class is the only place that knows both the wire and the app's provider
 * contract — `client.ts` is transport, `transcript.ts` is grouping,
 * `mapEvents.ts` is live state, `permission.ts` is the permission vocabulary.
 *
 * It never writes opencode's session files or database: sessions, messages and
 * permissions live there, and this is a client.
 */
import { EventEmitter } from 'node:events'
import path from 'node:path'
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
import { capImages } from '../images/store.js'
import { AgentProfileError } from '../agents/profiles.js'
import type { AgentConnection } from '../agents/profileRuntime.js'
import { SessionPrefsStore } from '../providers/sessionPrefs.js'
import {
  SessionNotFoundError,
  UnknownApprovalError,
  type AgentProvider,
  type CreateSessionOptions,
  type ListSessionsOptions,
  type ProviderProbe,
} from '../providers/types.js'
import { OpencodeClient, OpencodeHttpError } from './client.js'
import { OpencodeEventMapper } from './mapEvents.js'
import { cardFromPair, pairFor, rulesetFor } from './permission.js'
import { OpencodeService } from './server.js'
import { fetchTranscript } from './transcript.js'
import {
  asEventFrame,
  asModelRef,
  asRecord,
  asString,
  type OpencodeEventFrame,
  type OpencodeForm,
  type OpencodeInboxUser,
  type OpencodeMessageList,
  type OpencodeModelInfo,
  type OpencodeProjectInfo,
  type OpencodeSessionInfo,
  type OpencodeSessionList,
} from './types.js'

export interface OpencodeProviderOptions {
  connection?: AgentConnection
  workspaceRoots: string[]
  stateDir?: string
  agentsDir?: string
  attachUrl?: string
  port: number
  bin?: string
  password?: string
  serviceFile?: string
  noAttach?: boolean
  onLog?: (line: string) => void
  onNotice?: (line: string) => void
}

interface ModelEntry {
  info: OpencodeModelInfo
  composite: string
}

const MODEL_TTL_MS = 5 * 60_000
const ACTIVE_TTL_MS = 2_000
const RECONNECT_DELAYS = [500, 1_000, 2_000, 5_000, 10_000, 15_000]

function composite(model: { providerID: string; id: string }): string {
  return `${model.providerID}/${model.id}`
}

function splitComposite(value: string): { providerID: string; id: string } | null {
  const index = value.indexOf('/')
  if (index <= 0 || index === value.length - 1) return null
  return { providerID: value.slice(0, index), id: value.slice(index + 1) }
}

function dataUrl(value: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value)
  return match ? { mime: match[1] ?? '', base64: match[2] ?? '' } : null
}

function joinText(input: AgentInput[]): string {
  return input
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class OpencodeProvider extends EventEmitter implements AgentProvider {
  readonly id = 'opencode'
  readonly displayName = 'OpenCode'

  #opts: OpencodeProviderOptions
  #service: OpencodeService
  #client: OpencodeClient | null = null
  #mapper: OpencodeEventMapper
  #prefs: SessionPrefsStore
  #started = false
  #stopped = false
  #loopStarted = false
  #abort?: AbortController
  #eventsConnected = false

  #sessions = new Map<string, OpencodeSessionInfo>()
  #cwd = new Map<string, string>()
  #models: ModelEntry[] = []
  #modelsAt = 0
  #modelsFetch: Promise<void> | null = null
  #active = new Set<string>()
  #activeAt = 0
  #noticed = new Set<string>()

  constructor(opts: OpencodeProviderOptions) {
    super()
    this.#opts = opts
    this.#service = new OpencodeService({
      attachUrl: opts.attachUrl,
      port: opts.port,
      bin: opts.bin,
      password: opts.password,
      serviceFile: opts.serviceFile,
      noAttach: opts.noAttach,
      agentsDir: opts.agentsDir,
      cwd: opts.workspaceRoots[0],
      onLog: (line) => this.#log(line),
      connection: opts.connection,
    })
    this.#prefs = new SessionPrefsStore(
      opts.stateDir ? path.join(opts.stateDir, 'opencode-sessions.json') : undefined,
      (line) => this.#log(line),
    )
    this.#mapper = new OpencodeEventMapper({
      emit: (event) => this.#emit(event),
      cwdOf: (sessionID) => this.#cwd.get(sessionID),
      contextWindowOf: (model) => this.#contextWindow(model),
      onLog: (line) => this.#log(line),
    })
    this.#service.on('exit', () => {
      this.#eventsConnected = false
      this.#client = null
    })
    this.#service.on('restarted', () => {
      this.#eventsConnected = false
      this.#client = null
      void this.#ensureService().catch((err) => this.#log(`reconnect failed: ${(err as Error).message}`))
    })
  }

  get ready(): boolean {
    return this.#eventsConnected
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    await this.#ensureService()
    this.#startLoop()
    // Do not return before the event stream is open: a prompt sent by a client
    // that connected during startup would otherwise miss its first turn.
    await this.#waitConnected(5_000)
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#abort?.abort()
    this.#abort = undefined
    await this.#service.stop()
    this.#eventsConnected = false
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }

  async probe(): Promise<ProviderProbe> {
    try {
      const status = await this.#service.status()
      if (!status.available) {
        return { id: this.id, displayName: this.displayName, available: false, detail: status.detail }
      }
      // A probe is often the first thing that touches the provider after a
      // startup failure; make sure a successful service also starts the event
      // loop rather than waiting for the first list request.
      void this.#ensureService().catch((err) => this.#log(`event stream start failed: ${(err as Error).message}`))
      return {
        id: this.id,
        displayName: this.displayName,
        available: true,
        ...(status.version ? { version: status.version } : {}),
        detail: status.detail,
      }
    } catch (err) {
      return {
        id: this.id,
        displayName: this.displayName,
        available: false,
        detail: this.#service.lastError ?? (err as Error).message,
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.#ensureService()
    await this.#fetchModels()
    const configured = this.#opts.connection?.()?.model
    const ordered =
      configured && !this.profileLimitation
        ? [
            ...this.#models.filter((model) => model.composite === `vibemobile/${configured}`),
            ...this.#models.filter((model) => model.composite !== `vibemobile/${configured}`),
          ]
        : this.#models
    return ordered.map(({ info, composite: id }) => ({
      id,
      displayName: info.name,
      efforts: [
        'default',
        ...(info.variants ?? []).map((variant) => variant.id).filter((value) => value !== 'default'),
      ],
      defaultEffort: 'default',
    }))
  }

  async listProjects(): Promise<Project[]> {
    await this.#ensureService()
    const rows = await this.#requireClient().get<OpencodeProjectInfo[]>('/api/project')
    return (rows ?? []).map((project) => ({
      id: project.id,
      name: project.name ?? path.basename(project.canonical),
      path: project.canonical,
      isGitRepo: Boolean(project.vcs),
      gitBranch: null,
    }))
  }

  // ---------------------------------------------------------------- sessions

  async listSessions(opts: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    await this.#ensureService()
    const params = new URLSearchParams()
    params.set('limit', String(opts.limit ?? 50))
    if (opts.cwd) params.set('directory', opts.cwd)
    if (opts.search) params.set('search', opts.search)
    params.set('archived', opts.archived ? 'true' : 'false')
    const response = await this.#requireClient().get<OpencodeSessionList>(`/api/session?${params.toString()}`)
    await this.#refreshActive().catch(() => undefined)
    const summaries: SessionSummary[] = []
    for (const info of response.data ?? []) {
      this.#remember(info)
      summaries.push(this.#summary(info))
    }
    return summaries
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    try {
      await this.#ensureService()
      const response = await this.#requireClient().get<{ data: OpencodeSessionInfo }>(
        `/api/session/${encodeURIComponent(sessionId)}`,
      )
      this.#remember(response.data)
      await this.#refreshActive().catch(() => undefined)
      return this.#summary(response.data)
    } catch (err) {
      if (err instanceof OpencodeHttpError && err.status === 404) return null
      throw err
    }
  }

  async getTranscript(
    sessionId: string,
    opts: { limit?: number; targetItems?: number; cursor?: string } = {},
  ): Promise<Transcript | null> {
    await this.#ensureService()
    const session = await this.getSession(sessionId)
    if (!session) return null
    const fetched = await fetchTranscript((request) => this.#messagePage(sessionId, request), {
      limit: opts.limit,
      targetItems: opts.targetItems,
      cursor: opts.cursor,
    })
    const turns = fetched.turns.map((turn) => ({ ...turn }))
    this.#mergeLiveTail(sessionId, turns)
    return {
      session,
      turns,
      ...(fetched.nextCursor ? { nextCursor: fetched.nextCursor } : {}),
      ...(fetched.hasMore ? { hasMore: true } : {}),
    }
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionSummary> {
    await this.#ensureService()
    const card = cardFromPair(opts.sandbox, opts.approvalPolicy)
    const model = this.#modelRef(opts.model)
    const response = await this.#requireClient().post<{ data: OpencodeSessionInfo }>('/api/session', {
      location: { directory: opts.cwd },
      ...(model ? { model } : {}),
      agent: 'build',
      permissions: rulesetFor(card),
    })
    const info = response.data
    this.#remember(info)
    this.#prefs.set(info.id, {
      ...(opts.model ? { model: opts.model } : {}),
      effort: 'default',
      sandbox: pairFor(card).sandbox,
      approvalPolicy: pairFor(card).approvalPolicy,
    })
    return this.#summary(info)
  }

  async resumeSession(sessionId: string): Promise<SessionSummary | null> {
    const session = await this.getSession(sessionId)
    if (!session) return null
    this.#mapper.track(sessionId)
    this.#mapper.replayRunning(sessionId)
    this.#mapper.replayPending(sessionId)
    await this.#refreshPending(sessionId).catch((err) =>
      this.#log(`pending approvals for ${sessionId} failed: ${(err as Error).message}`),
    )
    this.#noticeUnattended(sessionId)
    return session
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.#ensureService()
    try {
      await this.#requireClient().patch(`/api/session/${encodeURIComponent(sessionId)}`, { title: name })
    } catch (err) {
      throw this.#notFoundOr(err, sessionId)
    }
    const cached = this.#sessions.get(sessionId)
    if (cached) cached.title = name
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#ensureService()
    try {
      await this.#requireClient().del(`/api/session/${encodeURIComponent(sessionId)}`)
    } catch (err) {
      if (!(err instanceof OpencodeHttpError && err.status === 404)) throw err
    }
    this.#prefs.forget(sessionId)
    this.#sessions.delete(sessionId)
    this.#cwd.delete(sessionId)
    this.#mapper.forget(sessionId)
  }

  async archiveSession(sessionId: string, archived = true): Promise<void> {
    await this.#ensureService()
    try {
      await this.#requireClient().patch(`/api/session/${encodeURIComponent(sessionId)}`, { archived })
    } catch (err) {
      throw this.#notFoundOr(err, sessionId)
    }
  }

  async pinSession(sessionId: string, pinned: boolean): Promise<void> {
    this.#prefs.set(sessionId, { pinned })
  }

  async restartServer(): Promise<void> {
    await this.#modelsFetch?.catch(() => undefined)
    await this.#service.restart()
    this.#client = null
    this.#models = []
    this.#modelsAt = 0
    await this.#ensureService()
  }

  get profileLimitation(): string | undefined {
    return this.#opts.attachUrl || this.#service.mode === 'attach' ? 'agent_profile_external_service' : undefined
  }

  async assertProfileManaged(): Promise<void> {
    await this.#service.ensure()
    if (this.profileLimitation) throw new AgentProfileError('agent_profile_external_service', 409)
  }

  // ------------------------------------------------------------------ turns

  async startTurn(
    sessionId: string,
    input: AgentInput[],
    opts: { model?: string; effort?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode } = {},
  ): Promise<{ turnId: string }> {
    await this.#ensureService()
    await this.#waitConnected(2_000)
    this.#mapper.track(sessionId)
    const card = cardFromPair(opts.sandbox, opts.approvalPolicy)
    const model = this.#modelRef(opts.model)
    const variant = opts.effort && opts.effort !== 'default' ? opts.effort : undefined

    // Agent first: switching it may reset session-level rules, so the
    // permission PATCH must be the last write before the prompt.
    await this.#requireClient().post(`/api/session/${encodeURIComponent(sessionId)}/agent`, { agent: 'build' })
    if (model) {
      await this.#requireClient().post(`/api/session/${encodeURIComponent(sessionId)}/model`, {
        model: { ...model, ...(variant ? { variant } : {}) },
      })
    }
    // Re-assert the card last. Anything less and the card on screen stops
    // matching what the next turn runs under.
    await this.#requireClient().patch(`/api/session/${encodeURIComponent(sessionId)}`, {
      permissions: rulesetFor(card),
    })

    this.#prefs.set(sessionId, {
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      sandbox: pairFor(card).sandbox,
      approvalPolicy: pairFor(card).approvalPolicy,
    })

    const files = capImages(input)
      .filter((part): part is { type: 'image'; url: string } => part.type === 'image')
      .map((part) => dataUrl(part.url))
      .filter((value): value is { mime: string; base64: string } => value !== null)
      .map((value, index) => ({
        data: value.base64,
        mime: value.mime,
        source: { type: 'inline' as const },
        name: `image-${index + 1}`,
      }))

    const response = await this.#requireClient().post<{ data: OpencodeInboxUser }>(
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { text: joinText(input), ...(files.length > 0 ? { files } : {}), delivery: 'queue' },
    )
    const turnId = this.#mapper.beginTurn(sessionId, response.data)
    return { turnId }
  }

  async steer(sessionId: string, _turnId: string, input: AgentInput[]): Promise<void> {
    await this.#ensureService()
    await this.#waitConnected(2_000)
    this.#mapper.track(sessionId)
    const files = capImages(input)
      .filter((part): part is { type: 'image'; url: string } => part.type === 'image')
      .map((part) => dataUrl(part.url))
      .filter((value): value is { mime: string; base64: string } => value !== null)
      .map((value, index) => ({
        data: value.base64,
        mime: value.mime,
        source: { type: 'inline' as const },
        name: `image-${index + 1}`,
      }))
    await this.#requireClient().post(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      text: joinText(input),
      ...(files.length > 0 ? { files } : {}),
      delivery: 'steer',
    })
  }

  async interrupt(sessionId: string, _turnId: string): Promise<void> {
    await this.#ensureService()
    try {
      await this.#requireClient().post(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {})
    } catch (err) {
      throw this.#notFoundOr(err, sessionId)
    }
  }

  async answerApproval(requestId: string, decision: ApprovalDecision, answers?: string[][]): Promise<void> {
    const entry = this.#mapper.pending(requestId)
    if (!entry) throw new UnknownApprovalError(requestId)
    await this.#ensureService()
    if (entry.kind === 'permission') {
      const id = requestId.slice('opencode:permission:'.length)
      const reply = this.#mapper.permissionReply(decision)
      try {
        await this.#requireClient().post(
          `/api/session/${encodeURIComponent(entry.sessionID)}/permission/${encodeURIComponent(id)}/reply`,
          { decision: reply },
        )
      } catch (err) {
        if (err instanceof OpencodeHttpError && err.status === 404) {
          this.#mapper.resolve(requestId)
          throw new UnknownApprovalError(requestId)
        }
        throw err
      }
      this.#mapper.resolve(requestId)
      if (decision === 'cancel') await this.interrupt(entry.sessionID, '').catch(() => undefined)
      return
    }

    if (decision !== 'accept') {
      // Forms have no "reject and continue" in the API. Stop the turn so the
      // sheet does not leave the agent blocked on an answer it will never get.
      await this.interrupt(entry.sessionID, '').catch(() => undefined)
      this.#mapper.resolve(requestId)
      return
    }

    const answer = this.#mapper.formAnswer(requestId, answers)
    const id = requestId.slice('opencode:form:'.length)
    try {
      await this.#requireClient().post(
        `/api/session/${encodeURIComponent(entry.sessionID)}/form/${encodeURIComponent(id)}/reply`,
        { answer },
      )
    } catch (err) {
      if (err instanceof OpencodeHttpError && err.status === 404) {
        this.#mapper.resolve(requestId)
        throw new UnknownApprovalError(requestId)
      }
      throw err
    }
    this.#mapper.resolve(requestId)
  }

  async resubscribeAll(): Promise<void> {
    await this.#resync()
  }

  // ---------------------------------------------------------------- service

  async #ensureService(): Promise<void> {
    if (this.#stopped) throw new Error('opencode provider is stopped')
    const base = await this.#service.ensure()
    if (!this.#client || this.#client.baseUrl !== base.replace(/\/+$/, '')) {
      this.#client = new OpencodeClient({ baseUrl: base, password: this.#service.password ?? undefined })
    }
    this.#startLoop()
    void this.#fetchModels().catch(() => undefined)
  }

  #requireClient(): OpencodeClient {
    const client = this.#client
    if (!client) throw new Error('opencode client is not ready')
    return client
  }

  /** Model list, cached and single-flighted; also fills the context-window map. */
  #fetchModels(): Promise<void> {
    if (Date.now() - this.#modelsAt < MODEL_TTL_MS && this.#models.length > 0) return Promise.resolve()
    if (this.#modelsFetch) return this.#modelsFetch
    this.#modelsFetch = this.#loadModels().finally(() => {
      this.#modelsFetch = null
    })
    return this.#modelsFetch
  }

  async #loadModels(): Promise<void> {
    const response = await this.#requireClient().get<{ data: OpencodeModelInfo[] }>('/api/model?types=chat')
    this.#models = (response.data ?? [])
      .filter((model) => model.enabled !== false && model.type !== 'decision' && model.type !== 'image')
      .map((info) => ({ info, composite: composite({ providerID: info.providerID, id: info.modelID }) }))
    this.#modelsAt = Date.now()
  }

  #startLoop(): void {
    if (this.#loopStarted || this.#stopped) return
    this.#loopStarted = true
    void this.#eventLoop()
  }

  async #eventLoop(): Promise<void> {
    let attempt = 0
    while (!this.#stopped) {
      try {
        await this.#ensureService()
        await this.#resync()
        this.#abort = new AbortController()
        await this.#requireClient().streamEvents(
          (frame) => this.#onFrame(frame),
          this.#abort.signal,
          () => {
            this.#eventsConnected = true
            attempt = 0
          },
        )
      } catch (err) {
        this.#eventsConnected = false
        if (this.#stopped) return
        this.#log(`event stream lost: ${(err as Error).message}`)
      }
      this.#eventsConnected = false
      this.#client = null
      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)] ?? 15_000
      attempt++
      await sleep(delay)
      if (this.#stopped) return
      await this.#ensureService().catch((err) => this.#log(`reconnect failed: ${(err as Error).message}`))
    }
  }

  async #waitConnected(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.#eventsConnected && Date.now() < deadline) await sleep(50)
  }

  #onFrame(raw: unknown): void {
    const frame = asEventFrame(raw)
    if (!frame) return
    const sessionID = asString(frame.data.sessionID)
    if (sessionID && frame.location?.directory) this.#cwd.set(sessionID, frame.location.directory)
    if (frame.type === 'session.created') {
      const info = this.#fromCreated(frame)
      // Do not replace a full row (cost/tokens/model) with this event's
      // partial one; the event is only here to learn the id and directory.
      if (info && !this.#sessions.has(info.id)) this.#remember(info)
    }
    this.#mapper.handle(frame)
    if (frame.type === 'session.renamed') {
      const id = asString(frame.data.sessionID)
      const title = asString(frame.data.title)
      const cached = id ? this.#sessions.get(id) : undefined
      if (cached && title) cached.title = title
    }
  }

  #fromCreated(frame: OpencodeEventFrame): OpencodeSessionInfo | null {
    const data = frame.data
    const id = asString(data.sessionID)
    const projectID = asString(data.projectID)
    const directory = asString(asRecord(data.location)?.directory)
    if (!id || !projectID || !directory) return null
    return {
      id,
      projectID,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: frame.created, updated: frame.created },
      ...(asString(data.title) ? { title: asString(data.title) as string } : {}),
      ...(asString(data.agent) ? { agent: asString(data.agent) as string } : {}),
      ...(asModelRef(data.model) ? { model: asModelRef(data.model) as NonNullable<OpencodeSessionInfo['model']> } : {}),
      location: { directory },
    }
  }

  async #resync(): Promise<void> {
    this.#activeAt = 0
    await this.#refreshActive().catch((err) => this.#log(`active sessions failed: ${(err as Error).message}`))
    await this.#refreshPending().catch((err) => this.#log(`pending approvals failed: ${(err as Error).message}`))
    for (const id of this.#active) {
      this.#mapper.track(id)
      this.#mapper.replayRunning(id)
    }
  }

  async #refreshActive(): Promise<void> {
    if (Date.now() - this.#activeAt < ACTIVE_TTL_MS) return
    const response = await this.#requireClient().get<{ data: Record<string, unknown> }>('/api/session/active')
    this.#active = new Set(Object.keys(response.data ?? {}))
    this.#activeAt = Date.now()
  }

  async #refreshPending(sessionID?: string): Promise<void> {
    const [permissions, forms] = await Promise.all([
      this.#requireClient().get<{ data: unknown[] }>('/api/permission/request'),
      this.#requireClient().get<{ data: unknown[] }>('/api/form'),
    ])
    const permissionRows = (permissions.data ?? []) as Record<string, unknown>[]
    const formRows = (forms.data ?? []) as OpencodeForm[]
    const seen = new Set<string>()
    for (const row of permissionRows) {
      const id = asString(row.sessionID)
      if (!id || (sessionID && id !== sessionID)) continue
      this.#mapper.track(id)
      seen.add(`opencode:permission:${asString(row.id) ?? ''}`)
      this.#mapper.handle({ id: 'sync', created: Date.now(), type: 'permission.asked', data: row })
    }
    for (const row of formRows) {
      const id = asString(row.sessionID)
      if (!id || (sessionID && id !== sessionID)) continue
      this.#mapper.track(id)
      seen.add(`opencode:form:${asString(row.id) ?? ''}`)
      this.#mapper.handle({ id: 'sync', created: Date.now(), type: 'form.created', data: { form: row } })
    }
    const sessions = sessionID ? [sessionID] : [...this.#mapper.pendingSessions()]
    for (const id of sessions) {
      for (const approval of this.#mapper.pendingFor(id)) {
        if (!seen.has(approval.requestId)) this.#mapper.resolve(approval.requestId)
      }
    }
  }

  // --------------------------------------------------------------- sessions

  #remember(info: OpencodeSessionInfo): void {
    this.#sessions.set(info.id, info)
    this.#cwd.set(info.id, info.location.directory)
    this.#mapper.track(info.id)
  }

  #summary(info: OpencodeSessionInfo): SessionSummary {
    const prefs = this.#prefs.get(info.id)
    const pending = this.#mapper.pendingFor(info.id)
    const waiting = pending.some((entry) => entry.type === 'userInput')
    const approval = pending.length > 0
    const active = this.#active.has(info.id) || this.#mapper.isRunning(info.id)
    const status = waiting
      ? 'waitingInput'
      : approval
        ? 'waitingApproval'
        : active
          ? 'working'
          : info.outcome === 'failed'
            ? 'error'
            : 'idle'
    const model = info.model ? composite({ providerID: info.model.providerID, id: info.model.id }) : null
    const effort = info.model?.variant ?? prefs?.effort ?? 'default'
    const pair =
      prefs?.sandbox && prefs.approvalPolicy ? { sandbox: prefs.sandbox, approvalPolicy: prefs.approvalPolicy } : null
    return {
      id: info.id,
      provider: this.id,
      title: info.title ?? '未命名会话',
      preview: '',
      cwd: info.location.directory,
      projectId: info.projectID,
      status,
      model,
      createdAt: info.time.created,
      updatedAt: info.time.updated,
      needsAttention: waiting || approval,
      ...(info.time.archived ? { archived: true } : {}),
      ...(prefs?.pinned ? { pinned: true } : {}),
      reasoningEffort: effort,
      ...(pair ? pair : {}),
    }
  }

  #noticeUnattended(sessionID: string): void {
    if (this.#noticed.has(sessionID)) return
    const prefs = this.#prefs.get(sessionID)
    if (!prefs?.sandbox || !prefs.approvalPolicy) return
    if (cardFromPair(prefs.sandbox, prefs.approvalPolicy) !== 'unattended') return
    this.#noticed.add(sessionID)
    this.#opts.onNotice?.(`opencode session ${sessionID} restored on 完全放行`)
  }

  #mergeLiveTail(sessionID: string, turns: Transcript['turns']): void {
    if (!this.#mapper.isRunning(sessionID)) return
    const live = this.#mapper.itemsFor(sessionID)
    if (live.length === 0) return
    const turnId = this.#mapper.currentTurnId(sessionID)
    let turn = turns.find((candidate) => candidate.id === turnId)
    if (!turn) {
      turn = { id: turnId, status: 'inProgress', items: [] }
      turns.push(turn)
    }
    const known = new Set(turn.items.map((item) => item.id))
    for (const item of live) if (!known.has(item.id)) turn.items.push(item)
  }

  #messagePage(
    sessionID: string,
    opts: { order?: 'asc' | 'desc'; cursor?: string; limit?: number },
  ): Promise<OpencodeMessageList> {
    const params = new URLSearchParams()
    if (opts.cursor) params.set('cursor', opts.cursor)
    else params.set('order', opts.order ?? 'desc')
    if (opts.limit) params.set('limit', String(opts.limit))
    return this.#requireClient().get<OpencodeMessageList>(
      `/api/session/${encodeURIComponent(sessionID)}/message?${params.toString()}`,
    )
  }

  #modelRef(value: string | undefined): { providerID: string; id: string } | null {
    if (!value) {
      const configured = this.#opts.connection?.()?.model
      return configured && !this.profileLimitation ? { providerID: 'vibemobile', id: configured } : null
    }
    const parsed = splitComposite(value)
    if (parsed) return parsed
    const known = this.#models.find((entry) => entry.info.modelID === value)
    if (known) return { providerID: known.info.providerID, id: known.info.modelID }
    return { providerID: 'opencode', id: value }
  }

  #contextWindow(model: { providerID: string; id: string } | null): number | undefined {
    if (!model) return undefined
    const found = this.#models.find(
      (entry) => entry.info.providerID === model.providerID && entry.info.modelID === model.id,
    )
    return found?.info.limit.context
  }

  #notFoundOr(err: unknown, sessionID: string): Error {
    if (err instanceof OpencodeHttpError && err.status === 404) return new SessionNotFoundError(sessionID)
    return err as Error
  }

  #emit(event: AgentEvent): void {
    this.emit('event', event)
  }

  #log(line: string): void {
    if (this.#opts.onLog) this.#opts.onLog(line)
    else this.emit('log', line)
  }
}
