import { EventEmitter } from 'node:events'
import path from 'node:path'
import {
  ClientApp,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type InitializeResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SessionInfo,
} from '@agentclientprotocol/sdk'
import type {
  AgentEvent,
  AgentInput,
  ApprovalDecision,
  ModelInfo,
  SessionStatus,
  SessionSummary,
  Transcript,
  TurnStatus,
} from '@vibemobile/protocol'
import { resolveDirectory, resolveInside } from '../files/workspace.js'
import { ImageStore } from '../images/store.js'
import { readGitInfo } from '../providers/git.js'
import { SessionPrefsStore } from '../providers/sessionPrefs.js'
import {
  SessionNotFoundError,
  type AgentProvider,
  type CreateSessionOptions,
  type ListSessionsOptions,
  type ProviderProbe,
} from '../providers/types.js'
import { AgyApprovals } from './approvals.js'
import { connectCli, deadline } from './connection.js'
import { AgyTranscript, promptBlocks } from './transcript.js'

type Ready = { connection: ClientConnection; info: InitializeResponse }
type Controls = { configOptions?: SessionConfigOption[] | null; modes?: SessionModeState | null }
type TurnOptions = NonNullable<Parameters<AgentProvider['startTurn']>[2]>
type PageOptions = NonNullable<Parameters<AgentProvider['getTranscript']>[1]>
interface OpenSession {
  nativeId: string
  summary: SessionSummary
  history: AgyTranscript
  options: SessionConfigOption[]
  mode?: SessionModeState | null
  commands: string[]
  starting: boolean
  touched: number
  stale?: boolean
  revision?: string
}
interface ProviderOptions {
  bin: string
  workspaceRoots: string[]
  stateDir?: string
  apiKey?: () => string
  baseUrl?: () => string
  connect?: typeof connectCli
}

const publicId = (nativeId: string) => `agy:${nativeId}`
const loginHint = '请在设置的 Antigravity 页面保存 Gemini API Key，或在执行机上运行 agy acp --login。'
const authRequired = (err: unknown) => err instanceof RequestError && err.code === -32000
const clientError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode })
const selectOption = (options: SessionConfigOption[], category: string) =>
  options.find((opt) => opt.type === 'select' && (opt.category === category || opt.id === category))
const values = (option: ReturnType<typeof selectOption>) =>
  option?.type === 'select' ? option.options.flatMap((v) => ('options' in v ? v.options : [v])) : []

function checkPolicy(opts: TurnOptions) {
  if (
    (opts.sandbox && opts.sandbox !== 'workspace-write') ||
    (opts.approvalPolicy && opts.approvalPolicy !== 'on-request')
  )
    throw clientError('Antigravity 仅支持按需确认，工具权限由 CLI 规则控制。', 400)
}

export class AntigravityProvider implements AgentProvider {
  readonly id = 'antigravity'
  readonly displayName = 'Antigravity'
  #events = new EventEmitter()
  #emit = (event: AgentEvent) => {
    this.#events.emit('event', event)
  }
  #pending?: Promise<Ready>
  #ready?: Ready
  #known = new Map<string, SessionSummary>()
  #revisions = new Map<string, string>()
  #opened = new Map<string, OpenSession>()
  #loading = new Map<string, Promise<OpenSession>>()
  #approvals = new AgyApprovals(this.#emit, (id) => this.#status(id))
  #models: ModelInfo[] = []
  #images?: ImageStore
  #prefs: SessionPrefsStore

  constructor(private opts: ProviderOptions) {
    this.#prefs = new SessionPrefsStore(opts.stateDir && path.join(opts.stateDir, 'antigravity-sessions.json'))
    if (opts.stateDir) this.#images = new ImageStore(path.join(opts.stateDir, 'images'))
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.#events.on('event', listener)
    return () => {
      this.#events.off('event', listener)
    }
  }

  #client() {
    if (this.#ready && !this.#ready.connection.signal.aborted) return Promise.resolve(this.#ready)
    this.#pending ??= this.#connect().finally(() => {
      this.#pending = undefined
    })
    return this.#pending
  }

  async #connect(): Promise<Ready> {
    const app = new ClientApp()
      .onNotification('session/update', ({ params }) => this.#update(params))
      .onRequest('session/request_permission', ({ params, signal }) => {
        const id = publicId(params.sessionId)
        const session = this.#opened.get(id)
        const turn = session?.history.turn
        if (!session?.history.live || !turn) return { outcome: { outcome: 'cancelled' } }
        return this.#approvals.request(id, turn.id, params, signal, () => this.interrupt(id, turn.id))
      })
    const cwd = this.opts.workspaceRoots[0]
    if (!cwd) throw new Error('Antigravity 需要至少一个工作区。')
    const apiKey = this.opts.apiKey?.()
    const connection = await (this.opts.connect ?? connectCli)(app, cwd, this.opts.bin, apiKey, this.opts.baseUrl?.())
    try {
      const info = await connection.agent.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'VibeMobile', version: '1' },
        },
        deadline(),
      )
      if (
        info.protocolVersion !== PROTOCOL_VERSION ||
        !info.agentCapabilities?.loadSession ||
        !info.agentCapabilities.sessionCapabilities?.list
      )
        throw new Error('此 Antigravity CLI 不支持所需的 ACP 会话接口，请更新 agy。')
      if (apiKey) {
        if (!info.authMethods?.some((method) => method.id === 'gemini-api-key'))
          throw new Error('此 Antigravity CLI 不支持 Gemini API Key 登录，请更新 agy。')
        try {
          await connection.agent.request('authenticate', { methodId: 'gemini-api-key' }, deadline())
        } catch {
          throw new Error('Antigravity 无法使用已保存的 Gemini API Key，请在设置中检查密钥。')
        }
      }
      this.#ready = { connection, info }
      void connection.closed.then(() => {
        if (this.#ready?.connection !== connection) return
        this.#ready = undefined
        for (const session of this.#opened.values()) {
          if (session.history.live) this.#finish(session, 'failed', 'Antigravity CLI 已断开连接。')
        }
        this.#opened.clear()
        this.#models = []
      })
      return this.#ready
    } catch (err) {
      connection.close()
      throw err
    }
  }

  async start() {
    await this.#client()
  }
  get hasActiveTurn() {
    return [...this.#opened.values()].some((session) => session.starting || session.history.live)
  }
  async stop() {
    const ready = this.#ready ?? (await this.#pending?.catch(() => undefined))
    ready?.connection.close()
    await ready?.connection.closed
  }

  async probe(): Promise<ProviderProbe> {
    const base = { id: this.id, displayName: this.displayName }
    try {
      const { connection, info } = await this.#client()
      const version = info.agentInfo?.version
      try {
        await connection.agent.request('session/list', { cwd: this.opts.workspaceRoots[0] }, deadline())
      } catch (err) {
        if (!authRequired(err)) throw err
        if (!this.#opened.size) connection.close() // Next probe picks up a login completed in a terminal.
        return { ...base, version, available: true, authenticated: false, detail: loginHint }
      }
      return { ...base, version, available: true, authenticated: true }
    } catch (err) {
      return { ...base, available: false, detail: (err as Error).message }
    }
  }

  async listModels() {
    return this.#models
  }
  async listProjects() {
    return Promise.all(
      this.opts.workspaceRoots.map(async (cwd) => {
        const git = await readGitInfo(cwd)
        return { id: cwd, path: cwd, name: path.basename(cwd), isGitRepo: git.isRepo, gitBranch: git.branch }
      }),
    )
  }

  #remember(info: SessionInfo, created = false) {
    const id = publicId(info.sessionId)
    let summary = this.#known.get(id)
    const time = Date.parse(info.updatedAt ?? '') || (created ? Date.now() : 0)
    const prefs = this.#prefs.get(id)
    if (!summary) {
      summary = {
        id,
        provider: this.id,
        title: '',
        preview: '',
        cwd: info.cwd,
        createdAt: time,
        updatedAt: time,
        needsAttention: false,
        status: 'idle',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        canDelete: Boolean(this.#ready?.info.agentCapabilities?.sessionCapabilities?.delete),
        ...(prefs?.pinned ? { pinned: true } : {}),
        ...(prefs?.archived ? { archived: true } : {}),
      }
      this.#known.set(id, summary)
    }
    if (info.updatedAt) {
      this.#revisions.set(id, info.updatedAt)
      const open = this.#opened.get(id)
      if (open && !open.starting && !open.history.live && open.revision !== info.updatedAt) open.stale = true
    }
    summary.title = prefs?.title ?? (info.title || summary.title)
    summary.updatedAt = Math.max(summary.updatedAt, time)
    return summary
  }

  #allowed(info: SessionInfo) {
    try {
      for (const dir of [info.cwd, ...(info.additionalDirectories ?? [])]) {
        if (!path.isAbsolute(dir)) return false
        resolveInside(this.opts.workspaceRoots, dir)
      }
      return true
    } catch {
      return false
    }
  }

  async #discover(cwd: string | undefined, visit: (summary: SessionSummary) => boolean) {
    const { connection } = await this.#client()
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await connection.agent.request('session/list', { ...(cwd ? { cwd } : {}), cursor }, deadline())
      for (const info of page.sessions) {
        if (this.#allowed(info) && visit(this.#remember(info))) return
      }
      cursor = page.nextCursor ?? undefined
      if (cursor && seen.has(cursor)) throw new Error('Antigravity 返回了重复的会话列表游标。')
      if (cursor) seen.add(cursor)
    } while (cursor)
  }

  async listSessions(opts: ListSessionsOptions = {}) {
    const found = new Map<string, SessionSummary>()
    const search = opts.search?.trim().toLowerCase()
    const include = (summary: SessionSummary) => {
      if (
        Boolean(summary.archived) === Boolean(opts.archived) &&
        (!opts.cwd || path.relative(opts.cwd, summary.cwd) === '') &&
        (!search || summary.title.toLowerCase().includes(search))
      )
        found.set(summary.id, summary)
    }
    // A new conversation may not appear in the native list until its first prompt.
    for (const open of this.#opened.values()) {
      if (open.history.live || !this.#revisions.has(open.summary.id)) include(open.summary)
    }
    try {
      await this.#discover(opts.cwd, (summary) => {
        include(summary)
        return false
      })
    } catch (err) {
      if (!authRequired(err)) throw err
    }
    return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, opts.limit)
  }

  async getSession(id: string) {
    if (!id.startsWith('agy:')) return null
    if (!this.#known.has(id)) await this.#discover(undefined, (s) => s.id === id)
    return this.#known.get(id) ?? null
  }

  #open(summary: SessionSummary) {
    const session: OpenSession = {
      nativeId: summary.id.slice(4),
      summary,
      options: [],
      commands: [],
      starting: false,
      revision: this.#revisions.get(summary.id),
      touched: Date.now(),
      history: new AgyTranscript(summary.id, this.#emit, this.#images),
    }
    this.#opened.set(summary.id, session)
    return session
  }

  #controls(session: OpenSession, data: Controls) {
    if (data.modes) session.mode = data.modes
    if (!data.configOptions) return
    session.options = data.configOptions
    const model = selectOption(session.options, 'model')
    const effort = selectOption(session.options, 'thought_level')
    if (model?.type === 'select') session.summary.model = model.currentValue
    if (effort?.type === 'select') session.summary.reasoningEffort = effort.currentValue
    this.#models = values(model).map((v) => ({
      id: v.value,
      displayName: v.name,
      efforts: values(effort).map((e) => e.value),
    }))
  }

  async #configure(session: OpenSession, connection: ClientConnection, opts: TurnOptions) {
    if (session.mode && session.mode.currentModeId !== 'default') {
      await connection.agent.request('session/set_mode', { sessionId: session.nativeId, modeId: 'default' }, deadline())
      session.mode.currentModeId = 'default'
    }
    for (const [category, value] of [
      ['model', opts.model],
      ['thought_level', opts.effort],
    ] as const) {
      if (!value) continue
      const option = selectOption(session.options, category)
      if (option?.type !== 'select' || !values(option).some((entry) => entry.value === value))
        throw clientError('Antigravity 不支持选定的模型或思考强度。', 400)
      if (value !== option.currentValue)
        this.#controls(
          session,
          await connection.agent.request(
            'session/set_config_option',
            { sessionId: session.nativeId, configId: option.id, value },
            deadline(),
          ),
        )
    }
  }

  async createSession(opts: CreateSessionOptions) {
    checkPolicy(opts)
    const cwd = await resolveDirectory(this.opts.workspaceRoots, opts.cwd)
    const { connection } = await this.#client()
    try {
      const result = await connection.agent.request('session/new', { cwd, mcpServers: [] }, deadline(30_000))
      const summary = this.#remember({ sessionId: result.sessionId, cwd }, true)
      const session = this.#open(summary)
      this.#controls(session, result)
      await this.#configure(session, connection, opts)
      this.#prune(session)
      return summary
    } catch (err) {
      if (authRequired(err)) throw clientError(loginHint, 409)
      throw err
    }
  }

  async #load(id: string): Promise<OpenSession> {
    const loading = this.#loading.get(id)
    if (loading) return loading
    const existing = this.#opened.get(id)
    if (existing && (!existing.stale || existing.starting || existing.history.live)) {
      existing.touched = Date.now()
      return existing
    }
    const pending = this.#restore(id, existing).finally(() => this.#loading.delete(id))
    this.#loading.set(id, pending)
    return pending
  }

  async #restore(id: string, existing?: OpenSession) {
    const summary = await this.getSession(id)
    if (!summary) throw new SessionNotFoundError(id)
    const cwd = await resolveDirectory(this.opts.workspaceRoots, summary.cwd)
    const { connection, info } = await this.#client()
    // An idle CLI conversation can advance in another client between phone visits.
    if (existing && info.agentCapabilities?.sessionCapabilities?.close)
      await connection.agent.request('session/close', { sessionId: existing.nativeId }, deadline())
    const session = this.#open(summary)
    try {
      const result = await connection.agent.request(
        'session/load',
        { sessionId: session.nativeId, cwd, mcpServers: [] },
        deadline(120_000),
      )
      session.history.finish('completed')
      this.#controls(session, result)
      this.#prune(session)
      return session
    } catch (err) {
      this.#opened.delete(id)
      if (err instanceof RequestError && err.code === -32002) {
        this.#known.delete(id)
        throw new SessionNotFoundError(id)
      }
      if (authRequired(err)) throw clientError(loginHint, 409)
      throw err
    }
  }

  #prune(current: OpenSession) {
    if (this.#opened.size <= 6) return
    const idle = [...this.#opened.values()].filter(
      (s) => s !== current && !s.starting && !s.history.live && !this.#loading.has(s.summary.id),
    )
    for (const session of idle.sort((a, b) => a.touched - b.touched)) {
      if (this.#opened.size <= 6) break
      this.#opened.delete(session.summary.id)
      if (this.#ready?.info.agentCapabilities?.sessionCapabilities?.close)
        void this.#ready.connection.agent
          .request('session/close', { sessionId: session.nativeId }, deadline())
          .catch(() => {})
    }
  }

  async getTranscript(id: string, opts: PageOptions = {}): Promise<Transcript | null> {
    if (!(await this.getSession(id))) return null
    const session = await this.#load(id)
    return { session: session.summary, ...session.history.page(opts) }
  }

  async resumeSession(id: string) {
    const summary = await this.getSession(id)
    if (!summary) return null
    const open = this.#opened.get(id)
    if (open && !open.stale && !open.starting && !open.history.live && Date.now() - open.touched > 5_000)
      await this.#discover(summary.cwd, (s) => s.id === id)
    const session = await this.#load(id)
    this.#emit({ kind: 'commands.updated', threadId: id, commands: session.commands })
    return session.summary
  }

  async renameSession(id: string, name: string) {
    const summary = await this.getSession(id)
    if (!summary) throw new SessionNotFoundError(id)
    this.#prefs.set(id, { title: name })
    summary.title = name
    this.#emit({ kind: 'thread.title', threadId: id, title: name })
  }

  async archiveSession(id: string, archived = true) {
    const summary = await this.getSession(id)
    if (!summary) throw new SessionNotFoundError(id)
    this.#prefs.set(id, { archived })
    summary.archived = archived
  }

  async pinSession(id: string, pinned: boolean) {
    const summary = await this.getSession(id)
    if (!summary) throw new SessionNotFoundError(id)
    this.#prefs.set(id, { pinned })
    summary.pinned = pinned
  }

  async deleteSession(id: string) {
    const summary = await this.getSession(id)
    if (!summary) throw new SessionNotFoundError(id)
    if (!summary.canDelete) throw clientError('此版本的 Antigravity CLI 仅支持在终端内删除会话。', 501)
    const open = this.#opened.get(id)
    if (open?.history.live || open?.starting || this.#loading.has(id))
      throw clientError('此 Antigravity 会话正在使用。', 409)
    const { connection } = await this.#client()
    await connection.agent.request('session/delete', { sessionId: id.slice(4) }, deadline())
    this.#opened.delete(id)
    this.#known.delete(id)
    this.#revisions.delete(id)
    this.#prefs.forget(id)
  }

  #update({ sessionId, update }: SessionNotification) {
    const id = publicId(sessionId)
    const session = this.#opened.get(id)
    if (!session) return
    switch (update.sessionUpdate) {
      case 'session_info_update':
        if (update.title && !this.#prefs.get(id)?.title) {
          session.summary.title = update.title
          if (session.history.live) this.#emit({ kind: 'thread.title', threadId: id, title: update.title })
        }
        break
      case 'config_option_update':
        this.#controls(session, update)
        break
      case 'current_mode_update':
        if (session.mode) session.mode.currentModeId = update.currentModeId
        break
      case 'available_commands_update':
        session.commands = update.availableCommands.map((c) => c.name.replace(/^\//, ''))
        if (session.history.live) this.#emit({ kind: 'commands.updated', threadId: id, commands: session.commands })
        break
      default:
        if (session.history.live || this.#loading.has(id)) session.history.update(update)
    }
  }

  #status(id: string) {
    const session = this.#opened.get(id)
    if (!session) return
    const status: SessionStatus = this.#approvals.has(id)
      ? 'waitingApproval'
      : session.history.live
        ? 'working'
        : 'idle'
    session.summary.status = status
    session.summary.needsAttention = status === 'waitingApproval'
    this.#emit({ kind: 'session.status', threadId: id, status })
  }

  #finish(session: OpenSession, status: TurnStatus, error?: string) {
    session.history.finish(status, error)
    session.history.live = false
    this.#approvals.clear(session.summary.id)
    session.summary.updatedAt = session.touched = Date.now()
    this.#status(session.summary.id)
  }

  async startTurn(id: string, input: AgentInput[], opts: TurnOptions = {}) {
    checkPolicy(opts)
    const session = await this.#load(id)
    if (session.starting || session.history.live) throw clientError('此 Antigravity 会话正在运行。', 409)
    session.starting = true
    try {
      const { connection, info } = await this.#client()
      const prompt = promptBlocks(input, Boolean(info.agentCapabilities?.promptCapabilities?.image))
      await this.#configure(session, connection, opts)
      session.history.live = true
      const turnId = session.history.begin()
      session.history.userInput(prompt)
      session.summary.updatedAt = Date.now()
      session.summary.preview = input.find((p) => p.type === 'text')?.text.slice(0, 180) ?? ''
      if (!session.summary.title) session.summary.title = session.summary.preview.slice(0, 80)
      this.#status(id)
      void connection.agent.request('session/prompt', { sessionId: session.nativeId, prompt }).then(
        ({ stopReason }) => {
          if (!session.history.live || session.history.turn?.id !== turnId) return
          this.#finish(session, stopReason === 'cancelled' ? 'interrupted' : 'completed')
        },
        (err: Error) => {
          if (session.history.live && session.history.turn?.id === turnId) this.#finish(session, 'failed', err.message)
        },
      )
      return { turnId }
    } finally {
      session.starting = false
    }
  }

  #running(id: string, turnId: string) {
    const session = this.#opened.get(id)
    if (!session?.history.live || session.history.turn?.id !== turnId || !this.#ready)
      throw clientError('Antigravity 回合已结束。', 409)
    return { session, ...this.#ready }
  }

  async steer(id: string, turnId: string, input: AgentInput[]) {
    const { session, info, connection } = this.#running(id, turnId)
    const prompt = promptBlocks(input, Boolean(info.agentCapabilities?.promptCapabilities?.image))
    session.history.userInput(prompt)
    await connection.agent.request('session/prompt', { sessionId: session.nativeId, prompt })
  }

  async interrupt(id: string, turnId: string) {
    const { session, connection } = this.#running(id, turnId)
    await connection.agent.notify('session/cancel', { sessionId: session.nativeId })
    this.#approvals.clear(id)
  }

  async answerApproval(id: string, decision: ApprovalDecision) {
    await this.#approvals.answer(id, decision)
  }
}
