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
  ApprovalPolicy,
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
import type { AgentConnection } from '../agents/profileRuntime.js'
import { acpModelId, startModelGateway, supplierModels } from './modelGateway.js'
import { AgyTranscript, promptBlocks } from './transcript.js'

type AcpClient = {
  connection: ClientConnection
  info: InitializeResponse
  gateway?: Awaited<ReturnType<typeof startModelGateway>>
  unattended: boolean
}
type Controls = { configOptions?: SessionConfigOption[] | null; modes?: SessionModeState | null }
type TurnOptions = NonNullable<Parameters<AgentProvider['startTurn']>[2]>
type PageOptions = NonNullable<Parameters<AgentProvider['getTranscript']>[1]>
interface OpenSession {
  client: AcpClient
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
  profile?: AgentConnection
  connect?: typeof connectCli
}

// agy 1.5.17 only exposes the first 32 gateway models to session/set_config_option.
const ACP_CATALOG_LIMIT = 32
const publicId = (nativeId: string) => `agy:${nativeId}`
// agy can return a file URL's pathname ("/D:/work") in session/list on Windows.
const workspacePath = (cwd: string) => (process.platform === 'win32' ? cwd.replace(/^\/(?=[A-Za-z]:\/)/, '') : cwd)
const loginHint = '请在设置的 Antigravity 页面保存 Gemini API Key，或在执行机上运行 agy acp --login。'
const authRequired = (err: unknown) => err instanceof RequestError && err.code === -32000
const clientError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode })
const selectOption = (options: SessionConfigOption[], category: string) =>
  options.find((opt) => opt.type === 'select' && (opt.category === category || opt.id === category))
const values = (option: ReturnType<typeof selectOption>) =>
  option?.type === 'select' ? option.options.flatMap((v) => ('options' in v ? v.options : [v])) : []

function permissionFor(opts: TurnOptions): ApprovalPolicy {
  const policy = opts.approvalPolicy ?? 'on-request'
  const expectedSandbox = policy === 'never' ? 'danger-full-access' : 'workspace-write'
  if (
    (opts.sandbox && opts.sandbox !== expectedSandbox) ||
    (policy === 'never' && opts.sandbox !== expectedSandbox) ||
    !['on-request', 'accept-edits', 'plan', 'auto', 'never'].includes(policy)
  )
    throw clientError('Antigravity 不支持该权限组合。', 400)
  return policy
}

const nativeMode = (policy: ApprovalPolicy) => (policy === 'on-request' || policy === 'never' ? 'default' : policy)

function permissionModes(data: Controls, client: AcpClient): ApprovalPolicy[] {
  const mode = selectOption(data.configOptions ?? [], 'mode')
  const available = mode
    ? values(mode).map((entry) => entry.value)
    : (data.modes?.availableModes.map((entry) => entry.id) ?? [])
  const policies: ApprovalPolicy[] = [
    'on-request',
    ...(['accept-edits', 'plan', 'auto'] as const).filter((entry) => available.includes(entry)),
  ]
  if (client.info.agentCapabilities?.sessionCapabilities?.close) policies.push('never')
  return policies
}

export class AntigravityProvider implements AgentProvider {
  readonly id = 'antigravity'
  readonly displayName = 'Antigravity'
  #events = new EventEmitter()
  #emit = (event: AgentEvent) => {
    this.#events.emit('event', event)
  }
  #clients = new Map<string, Promise<AcpClient>>()
  #permissionModes: ApprovalPolicy[] | undefined
  #known = new Map<string, SessionSummary>()
  #revisions = new Map<string, string>()
  #opened = new Map<string, OpenSession>()
  #loading = new Map<string, Promise<OpenSession>>()
  #closing = new Map<string, Promise<void>>()
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

  #client(model?: string, unattended = false) {
    const profile = this.opts.profile?.()
    const models = supplierModels(profile)
    const index = model && models.length ? models.indexOf(model) : 0
    if (index < 0) throw clientError('此供应商未配置选定的模型。', 400)
    // The CLI can also use the catalogue's first model for background requests.
    // Keep the supplier default first in every client.
    const pageSize = ACP_CATALOG_LIMIT - 1
    const group = Math.floor(Math.max(0, index - 1) / pageSize)
    const key = `${group}:${unattended}`
    const cached = this.#clients.get(key)
    if (cached) return cached
    const start = 1 + group * pageSize
    const catalog = models.slice(start, start + pageSize)
    if (models.length) catalog.unshift(models[0])
    const pending = this.#connect(profile, catalog, unattended)
    this.#clients.set(key, pending)
    const forget = () => {
      if (this.#clients.get(key) === pending) this.#clients.delete(key)
    }
    void pending.then(({ connection }) => connection.closed.then(forget), forget)
    return pending
  }

  async #connect(profile: ReturnType<AgentConnection>, models: string[], unattended: boolean): Promise<AcpClient> {
    let connection: ClientConnection
    const app = new ClientApp()
      .onNotification('session/update', ({ params }) => this.#update(params, connection))
      .onRequest('session/request_permission', ({ params, signal }) => {
        const id = publicId(params.sessionId)
        const session = this.#opened.get(id)
        const turn = session?.history.turn
        if (!session?.history.live || session.client.connection !== connection || !turn)
          return { outcome: { outcome: 'cancelled' } }
        return this.#approvals.request(id, turn.id, params, signal, () => this.interrupt(id, turn.id))
      })
    const cwd = this.opts.workspaceRoots[0]
    if (!cwd) throw new Error('Antigravity 需要至少一个工作区。')
    const useGateway = models.length > 0
    connection = await (this.opts.connect ?? connectCli)(
      app,
      cwd,
      this.opts.bin,
      profile?.apiKey,
      profile?.baseUrl,
      useGateway,
      unattended,
    )
    let gateway: AcpClient['gateway']
    try {
      const info = await connection.agent.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: useGateway ? { auth: { _meta: { gateway: true } } } : {},
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
      if (profile && useGateway) {
        if (!info.authMethods?.some((method) => method.id === 'gateway'))
          throw new Error('此 Antigravity CLI 不支持供应商模型网关，请更新 agy。')
        gateway = await startModelGateway(profile, models)
        await connection.agent.request(
          'authenticate',
          {
            methodId: 'gateway',
            _meta: { gateway: { baseUrl: gateway.baseUrl, headers: gateway.headers } },
          },
          deadline(),
        )
      } else if (profile?.apiKey) {
        if (!info.authMethods?.some((method) => method.id === 'gemini-api-key'))
          throw new Error('此 Antigravity CLI 不支持 Gemini API Key 登录，请更新 agy。')
        try {
          await connection.agent.request('authenticate', { methodId: 'gemini-api-key' }, deadline())
        } catch {
          throw new Error('Antigravity 无法使用已保存的 Gemini API Key，请在设置中检查密钥。')
        }
      }
      void connection.closed.then(() => {
        gateway?.close()
        for (const session of this.#opened.values()) {
          if (session.client.connection !== connection) continue
          if (session.history.live) this.#finish(session, 'failed', 'Antigravity CLI 已断开连接。')
          this.#opened.delete(session.summary.id)
        }
        if (!gateway) this.#models = []
      })
      return { connection, info, gateway, unattended }
    } catch (err) {
      gateway?.close()
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
    await Promise.all(
      Array.from(this.#clients.values(), async (pending) => {
        const client = await pending.catch(() => undefined)
        client?.connection.close()
        await client?.connection.closed
      }),
    )
    this.#permissionModes = undefined
  }

  async probe(): Promise<ProviderProbe> {
    const base = { id: this.id, displayName: this.displayName }
    try {
      const client = await this.#client()
      const { connection, info } = client
      const version = info.agentInfo?.version
      try {
        await connection.agent.request('session/list', { cwd: this.opts.workspaceRoots[0] }, deadline())
      } catch (err) {
        if (!authRequired(err)) throw err
        if (!this.#opened.size) connection.close() // Next probe picks up a login completed in a terminal.
        return { ...base, version, available: true, authenticated: false, detail: loginHint }
      }
      // ACP reports execution modes in session/new, not initialize. A closed
      // empty session has no history and does not appear in agy's session list.
      if (!this.#permissionModes && info.agentCapabilities?.sessionCapabilities?.close) {
        try {
          const result = await connection.agent.request(
            'session/new',
            { cwd: this.opts.workspaceRoots[0], mcpServers: [] },
            deadline(),
          )
          await connection.agent.request('session/close', { sessionId: result.sessionId }, deadline())
          this.#permissionModes = permissionModes(result, client)
        } catch {
          // Opening a real session can still discover supported modes later.
        }
      }
      return {
        ...base,
        version,
        available: true,
        authenticated: true,
        permissionModes: this.#permissionModes ?? ['on-request'],
      }
    } catch (err) {
      return { ...base, available: false, detail: (err as Error).message }
    }
  }

  async listModels() {
    const profile = this.opts.profile?.()
    const models = supplierModels(profile)
    if (models.length)
      return models.map((id) => ({ id, displayName: id, contextWindow: profile?.modelContextWindows?.[id] }))
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

  #remember(info: SessionInfo, client: AcpClient, created = false) {
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
        cwd: workspacePath(info.cwd),
        createdAt: time,
        updatedAt: time,
        needsAttention: false,
        status: 'idle',
        sandbox: prefs?.approvalPolicy === 'never' ? 'danger-full-access' : 'workspace-write',
        approvalPolicy: prefs?.approvalPolicy ?? 'on-request',
        canDelete: Boolean(client.info.agentCapabilities?.sessionCapabilities?.delete),
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
        const cwd = workspacePath(dir)
        if (!path.isAbsolute(cwd)) return false
        resolveInside(this.opts.workspaceRoots, cwd)
      }
      return true
    } catch {
      return false
    }
  }

  async #discover(cwd: string | undefined, visit: (summary: SessionSummary) => boolean) {
    const client = await this.#client()
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await client.connection.agent.request(
        'session/list',
        { ...(cwd ? { cwd } : {}), cursor },
        deadline(),
      )
      for (const info of page.sessions) {
        if (this.#allowed(info) && visit(this.#remember(info, client))) return
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

  #open(summary: SessionSummary, client: AcpClient) {
    const session: OpenSession = {
      client,
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
    if (data.configOptions) session.options = data.configOptions
    session.summary.permissionModes = permissionModes(
      { modes: session.mode, configOptions: session.options },
      session.client,
    )
    if (!session.client.unattended) this.#permissionModes = session.summary.permissionModes
    if (!data.configOptions) return
    const model = selectOption(session.options, 'model')
    const effort = selectOption(session.options, 'thought_level')
    if (model?.type === 'select') {
      const { gateway } = session.client
      session.summary.model = gateway ? gateway.byAcpId.get(model.currentValue) : model.currentValue
    }
    session.summary.reasoningEffort =
      !session.client.gateway && effort?.type === 'select' ? effort.currentValue : undefined
    if (session.client.gateway) return
    this.#models = values(model).map((v) => ({
      id: v.value,
      displayName: v.name,
      efforts: values(effort).map((e) => e.value),
    }))
  }

  async #configure(session: OpenSession, opts: TurnOptions) {
    const { connection, gateway } = session.client
    const modelId = opts.model && gateway ? acpModelId(opts.model) : opts.model
    for (const [category, value] of [
      ['model', modelId],
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
    if (gateway && opts.model && session.summary.model !== opts.model) {
      session.stale = true
      throw clientError('Antigravity CLI 未应用选定的供应商模型。', 502)
    }
  }

  async #configurePermission(session: OpenSession, policy: ApprovalPolicy) {
    const mode = nativeMode(policy)
    const option = selectOption(session.options, 'mode')
    const current = option?.type === 'select' ? option.currentValue : session.mode?.currentModeId
    if (policy !== 'on-request' && !session.summary.permissionModes?.includes(policy))
      throw clientError('当前 Antigravity CLI 不支持所选权限模式。', 400)
    if (session.client.unattended !== (policy === 'never')) throw new Error('Antigravity 权限与执行进程不一致。')
    if (current && current !== mode) {
      if (option?.type === 'select') {
        this.#controls(
          session,
          await session.client.connection.agent.request(
            'session/set_config_option',
            { sessionId: session.nativeId, configId: option.id, value: mode },
            deadline(),
          ),
        )
        const applied = selectOption(session.options, 'mode')
        if (applied?.type !== 'select' || applied.currentValue !== mode)
          throw clientError('Antigravity CLI 未应用选定的权限模式。', 502)
      } else {
        await session.client.connection.agent.request(
          'session/set_mode',
          { sessionId: session.nativeId, modeId: mode },
          deadline(),
        )
        if (session.mode) session.mode.currentModeId = mode
      }
    }
    session.summary.approvalPolicy = policy
    session.summary.sandbox = policy === 'never' ? 'danger-full-access' : 'workspace-write'
    this.#prefs.set(session.summary.id, {
      approvalPolicy: policy,
      sandbox: session.summary.sandbox,
      model: session.client.gateway ? (session.summary.model ?? undefined) : undefined,
    })
  }

  async createSession(opts: CreateSessionOptions) {
    const policy = permissionFor(opts)
    const cwd = await resolveDirectory(this.opts.workspaceRoots, opts.cwd)
    const model = opts.model || supplierModels(this.opts.profile?.())[0]
    const client = await this.#client(model, policy === 'never')
    let session: OpenSession | undefined
    try {
      const result = await client.connection.agent.request('session/new', { cwd, mcpServers: [] }, deadline(30_000))
      const summary = this.#remember({ sessionId: result.sessionId, cwd }, client, true)
      session = this.#open(summary, client)
      this.#controls(session, result)
      await this.#configure(session, { model })
      await this.#configurePermission(session, policy)
      this.#prune(session)
      return summary
    } catch (err) {
      if (session) {
        await this.#discard(session)
        this.#known.delete(session.summary.id)
      }
      if (authRequired(err)) throw clientError(loginHint, 409)
      throw err
    }
  }

  async #closeNative(session: OpenSession) {
    const { connection, info } = session.client
    if (info.agentCapabilities?.sessionCapabilities?.close && !connection.signal.aborted)
      await connection.agent.request('session/close', { sessionId: session.nativeId }, deadline())
  }

  #discard(session: OpenSession) {
    const id = session.summary.id
    if (this.#opened.get(id) !== session) return
    this.#opened.delete(id)
    const closing = this.#closeNative(session)
      .catch(() => {})
      .finally(() => this.#closing.delete(id))
    this.#closing.set(id, closing)
    return closing
  }

  async #attach(session: OpenSession, replay: boolean) {
    const { connection, info } = session.client
    const cwd = await resolveDirectory(this.opts.workspaceRoots, session.summary.cwd)
    const method = !replay && info.agentCapabilities?.sessionCapabilities?.resume ? 'session/resume' : 'session/load'
    const result = await connection.agent.request(
      method,
      { sessionId: session.nativeId, cwd, mcpServers: [] },
      deadline(120_000),
    )
    this.#controls(session, result)
  }

  async #load(id: string): Promise<OpenSession> {
    const closing = this.#closing.get(id)
    if (closing) await closing
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
    const models = supplierModels(this.opts.profile?.())
    const saved = this.#prefs.get(id)?.model
    const model = saved && models.includes(saved) ? saved : models[0]
    const client = await this.#client(model)
    // An idle CLI conversation can advance in another client between phone visits.
    if (existing) await this.#closeNative(existing)
    const session = this.#open(summary, client)
    try {
      await this.#attach(session, true)
      session.history.finish('completed')
      if (model) {
        await this.#configure(session, { model })
        this.#prefs.set(id, { model })
      }
      // Opening history reports the remembered selection. The next turn applies it.
      if (summary.approvalPolicy && !summary.permissionModes?.includes(summary.approvalPolicy)) {
        summary.approvalPolicy = 'on-request'
        summary.sandbox = 'workspace-write'
        this.#prefs.set(id, { approvalPolicy: 'on-request', sandbox: 'workspace-write' })
      }
      this.#prune(session)
      return session
    } catch (err) {
      await this.#discard(session)
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
      void this.#discard(session)
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
    if (open?.history.live || open?.starting || this.#loading.has(id) || this.#closing.has(id))
      throw clientError('此 Antigravity 会话正在使用。', 409)
    const { connection } = open?.client ?? (await this.#client())
    await connection.agent.request('session/delete', { sessionId: id.slice(4) }, deadline())
    this.#opened.delete(id)
    this.#known.delete(id)
    this.#revisions.delete(id)
    this.#prefs.forget(id)
  }

  #update({ sessionId, update }: SessionNotification, connection: ClientConnection) {
    const id = publicId(sessionId)
    const session = this.#opened.get(id)
    if (!session || session.client.connection !== connection) return
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

  async #selectForTurn(session: OpenSession, opts: TurnOptions) {
    const policy = permissionFor(opts)
    let model = opts.model || session.summary.model || undefined
    if (session.client.gateway && opts.effort) {
      // Older web clients sent the base model and effort separately.
      const variant = `${model}-${opts.effort}`
      if (supplierModels(this.opts.profile?.()).includes(variant)) model = variant
      else if (!model?.endsWith(`-${opts.effort}`)) throw clientError('请选择供应商提供的完整模型 ID。', 400)
    }
    const settings = session.client.gateway ? { model } : opts
    const unattended = policy === 'never'
    if (
      session.client.unattended === unattended &&
      (!session.client.gateway || !model || session.client.gateway.byAcpId.has(acpModelId(model)))
    ) {
      await this.#configure(session, settings)
      await this.#configurePermission(session, policy)
      return
    }
    if (!session.client.info.agentCapabilities?.sessionCapabilities?.close)
      throw clientError('当前 Antigravity CLI 不支持切换执行进程。', 400)
    const next = await this.#client(model, unattended)
    // Keep the native session ID and the transcript already displayed on the phone.
    const previous = session.summary.model
    try {
      await this.#closeNative(session)
      if (this.#opened.get(session.summary.id) !== session) throw new Error('Antigravity CLI 已断开连接。')
      session.client = next
      session.options = []
      session.mode = undefined
      await this.#attach(session, false)
      await this.#configure(session, { ...settings, model })
      await this.#configurePermission(session, policy)
    } catch (err) {
      if (this.#opened.get(session.summary.id) === session) {
        session.summary.model = previous
        await this.#discard(session)
      }
      throw err
    }
  }

  async startTurn(id: string, input: AgentInput[], opts: TurnOptions = {}) {
    permissionFor(opts)
    const session = await this.#load(id)
    if (session.starting || session.history.live) throw clientError('此 Antigravity 会话正在运行。', 409)
    session.starting = true
    try {
      const prompt = promptBlocks(input, Boolean(session.client.info.agentCapabilities?.promptCapabilities?.image))
      await this.#selectForTurn(session, opts)
      const { connection } = session.client
      if (this.#opened.get(id) !== session || connection.signal.aborted) throw new Error('Antigravity CLI 已断开连接。')
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
    if (!session?.history.live || session.history.turn?.id !== turnId || session.client.connection.signal.aborted)
      throw clientError('Antigravity 回合已结束。', 409)
    return { session, ...session.client }
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
