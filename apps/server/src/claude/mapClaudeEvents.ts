import { retryDetails } from './retry.js'
/**
 * Translation layer: Claude Agent SDK messages -> normalized AgentEvent.
 *
 * Everything Claude-specific about the event stream lives in this file. The
 * rest of the server (and the entire web client) only sees AgentEvent.
 *
 * Unlike the Codex mapper this cannot be a pure `(method, params) => event`
 * function, because turns, block ids and tool pairings are state that spans
 * messages. So it is split: pure helpers live in `mapUtils.ts` (unit-tested
 * against literal captured frames) and `ClaudeEventMapper` here is the stateful
 * class fed real frame sequences.
 *
 * Every shape and ordering claim in here was captured from a live run of
 * `scripts/capture-claude.ts` against claude-code 2.1.273 — see the notes on
 * each decision for what the wire actually did.
 */
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentItem } from '@vibemobile/protocol'
import {
  applyToolResult,
  mapResultUsage,
  mapTaskStatus,
  mapToolItem,
  planFromTodos,
  toolResultText,
} from './mapUtils.js'

// --------------------------------------------------------------- primitives

/**
 * Items the SDK delivers about its own machinery rather than the user's work.
 * `system:thinking_tokens` alone fires once per estimated thinking token (618
 * in a single captured turn), so mapping it would drown the socket.
 */
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'thinking_tokens',
  'status',
  'task_started',
  'task_updated',
  'task_notification',
  'task_progress',
])

interface BlockState {
  kind: 'text' | 'thinking' | 'tool_use'
  itemId: string
  text: string
  /** tool_use only */
  toolUseId?: string
  name?: string
  /** True once we have emitted the terminal event for this block. */
  emitted: boolean
}

interface TurnState {
  turnId: string
  /** The uuid WE assigned to the pushed user message, echoed back by the CLI. */
  commandUuid: string | null
}

export interface ClaudeMapperOptions {
  threadId: string
  emit: (event: AgentEvent) => void
  /** Injected for tests; defaults to crypto.randomUUID. */
  newId?: () => string
}

/**
 * Consumes SDK messages for one thread and produces AgentEvents.
 *
 * Turn boundaries are exact rather than inferred. A `result` frame carries
 * `user_message_uuid`, the uuid we stamped on the message we pushed, so a turn
 * is closed by identity instead of by counting results. Turns are serialized
 * by the CLI: a message pushed mid-turn queues and runs as its OWN turn
 * afterwards (captured: two pushes → two `result` frames, each `num_turns: 1`),
 * never folded into the running one.
 */
export class ClaudeEventMapper {
  readonly threadId: string
  #emit: (event: AgentEvent) => void
  #newId: () => string

  /** The turn currently producing frames, if any. */
  #turn: TurnState | null = null
  /** Turns pushed while another was running, awaiting their `result`. */
  #queued: TurnState[] = []
  /** commandUuid -> turnId, so a `result` closes the right turn. */
  #byCommand = new Map<string, string>()
  /** messageId -> (block index -> state). Keyed per assistant message. */
  #blocks = new Map<string, Map<number, BlockState>>()
  /** The message id currently streaming, since deltas omit it. */
  #currentMessageId: string | null = null
  /** toolUseId -> the item awaiting its result. */
  #pendingTools = new Map<string, AgentItem>()
  /** Every item we have emitted, for live replay and transcript synthesis. */
  #items = new Map<string, AgentItem>()
  /** itemId -> the turn that produced it. */
  #itemTurn = new Map<string, string>()
  /** Set once any lifecycle frame proves the CLI supports them. */
  #sawLifecycle = false
  /** Turns already closed, so `finish` can never double-emit. */
  #closedTurns = new Set<string>()
  /** Turns we asked to stop, so their `result` reports "interrupted". */
  #interruptedTurns = new Set<string>()

  constructor(opts: ClaudeMapperOptions) {
    this.threadId = opts.threadId
    this.#emit = opts.emit
    this.#newId = opts.newId ?? (() => randomUUID())
  }

  // ------------------------------------------------------------ public API

  get activeTurnId(): string | null {
    return this.#turn?.turnId ?? null
  }

  get hasPendingWork(): boolean {
    return this.#turn !== null || this.#queued.length > 0
  }

  /**
   * Every live item, in insertion order.
   *
   * This spans the whole session, which is what a reconnect needs (the client
   * may have no history at all and an item is better than a gap). It is the
   * WRONG list for a transcript, though: `getTranscript` appends the live turn
   * AFTER the replayed history, so handing it every item would render every
   * earlier turn a second time. Use `itemsForTurn` there.
   */
  get items(): AgentItem[] {
    return [...this.#items.values()]
  }

  /** The items belonging to one turn, in insertion order. */
  itemsForTurn(turnId: string): AgentItem[] {
    return [...this.#items.values()].filter((item) => this.#itemTurn.get(item.id) === turnId)
  }

  /**
   * Record an item and remember which turn owns it.
   *
   * Ownership is set on FIRST sighting only. A tool card is merged a second
   * time when its result lands, and by then `#turn` may already have been
   * promoted to the next queued turn — letting that re-file the card would
   * move a finished card into the following turn.
   */
  #track(item: AgentItem, turnId: string): void {
    this.#items.set(item.id, item)
    if (!this.#itemTurn.has(item.id)) this.#itemTurn.set(item.id, turnId)
  }

  /**
   * Record a user message we are about to push. Returns the turn id to use in
   * `turn.started`.
   *
   * The CLI echoes `commandUuid` back on the `result` frame, which is what lets
   * us close exactly this turn even when several are queued.
   */
  beginTurn(text: string, commandUuid: string | null, imageIds?: string[]): { turnId: string; started: boolean } {
    const turn: TurnState = { turnId: this.#newId(), commandUuid }
    if (commandUuid) this.#byCommand.set(commandUuid, turn.turnId)

    // The user's own bubble. Emitted here rather than from the SDK's `user`
    // frames, which are polluted: the CLI injects system-reminders and echoes
    // a subagent's prompt onto the main thread, so trusting them makes the
    // phone display the user "saying" things they never typed. The same is
    // true of the images — which is why their tokens arrive as an argument
    // rather than being read from those frames.
    const item: AgentItem = {
      kind: 'message',
      id: `claude:user:${commandUuid ?? turn.turnId}`,
      role: 'user',
      text,
      // Absent rather than empty for the usual no-image case; this item is
      // asserted exactly by `mapClaudeEvents.test.ts`.
      ...(imageIds?.length ? { images: imageIds } : {}),
      // Stamped here, at the moment the message was accepted, rather than
      // derived from the turn: a queued or steered prompt can enter the turn
      // minutes later and still must show when it was typed.
      at: Date.now(),
    }
    // Filed against ITS OWN turn, not the active one: a queued push arrives
    // while the previous turn is still running, and the bubble must travel
    // with the turn it will start.
    this.#track(item, turn.turnId)

    // A turn already running means this one queues. The CLI runs them strictly
    // in order, so it starts the moment the active one reports its `result`.
    if (this.#turn) {
      this.#queued.push(turn)
      return { turnId: turn.turnId, started: false }
    }

    this.#turn = turn
    this.#emit({ kind: 'item.completed', threadId: this.threadId, turnId: turn.turnId, item })
    this.#emit({ kind: 'turn.started', threadId: this.threadId, turnId: turn.turnId })
    this.#emit({ kind: 'session.status', threadId: this.threadId, status: 'working' })
    return { turnId: turn.turnId, started: true }
  }

  /**
   * Fold a message into the turn that is already running.
   *
   * The CLI keeps reading its input stream while a turn runs, and a message
   * that arrives then is delivered to the model at the next boundary INSIDE
   * that same turn: one `result`, one `turn.completed`. (Measured with a
   * running Bash call: the command was not cancelled; the reply came once the
   * tool returned.) That is the same shape as Codex's `turn/steer`, so the
   * bubble is filed against the active turn and `turn.started` is not emitted
   * again.
   *
   * `commandUuid` is deliberately NOT put into `#byCommand`: the result frame
   * echoes the uuid of the prompt that started the turn, not the folded one
   * (only synthetic/meta turns take the later echo over). Mapping it would
   * make the result unresolvable.
   *
   * With no active turn there is nothing to fold into; fall back to starting
   * one so a heartbeat that arrives a moment late is still delivered.
   */
  interject(text: string, commandUuid: string | null, imageIds?: string[]): { turnId: string; folded: boolean } {
    const turn = this.#turn
    if (!turn) return { ...this.beginTurn(text, commandUuid, imageIds), folded: false }

    const item: AgentItem = {
      kind: 'message',
      id: `claude:user:${commandUuid ?? turn.turnId}`,
      role: 'user',
      text,
      ...(imageIds?.length ? { images: imageIds } : {}),
      // Its own clock: this message was typed after the turn started.
      at: Date.now(),
    }
    this.#track(item, turn.turnId)
    this.#emit({ kind: 'item.completed', threadId: this.threadId, turnId: turn.turnId, item })
    return { turnId: turn.turnId, folded: true }
  }

  /** Feed one SDK message. Unknown message types are ignored by design. */
  retryNotice: Extract<AgentEvent, { kind: 'error' }> | null = null

  handle(msg: any): void {
    if (msg?.type === 'stream_event') this.retryNotice = null
    switch (msg?.type) {
      case 'system':
        this.#handleSystem(msg)
        return
      case 'stream_event':
        this.#handleStreamEvent(msg)
        return
      case 'assistant':
        this.#handleAssistant(msg)
        return
      case 'user':
        this.#handleUser(msg)
        return
      case 'result':
        this.#handleResult(msg)
        return
      default:
        // `command_lifecycle` is informational: turns are already serialized
        // correctly by beginTurn/handleResult. It is only used to learn that
        // the CLI supports queued turns at all.
        if (msg?.type === 'command_lifecycle') this.#sawLifecycle = true
        return
    }
  }

  /**
   * Close any open turn. Idempotent, and safe to call when nothing is running.
   *
   * This is the crash backstop: exactly one `turn.completed` per turn id, so a
   * client that only tracks `turnStatus` can never be stranded in "运行中"
   * after a subprocess dies.
   */
  finish(status: 'completed' | 'interrupted' | 'failed', error?: string, turnId?: string): void {
    // Flush blocks that were mid-stream: an interrupt means `content_block_stop`
    // never arrives, and dropping the buffer would erase the text the user was
    // already reading.
    this.#flushOpenBlocks()

    const target = turnId ?? this.#turn?.turnId ?? null
    if (!target || this.#closedTurns.has(target)) {
      if (!target) this.#emitStatusIdle()
      return
    }
    const failure = this.itemsForTurn(target).find((item) => item.kind === 'error')
    if (status !== 'interrupted' && failure?.kind === 'error') {
      status = 'failed'
      error ||= failure.message
    }
    if (status === 'failed' && !failure) {
      const item: AgentItem = {
        kind: 'error',
        id: `turn-error:${target}`,
        message: error || '代理执行失败，未返回具体原因。',
      }
      this.#track(item, target)
      this.#emit({ kind: 'item.completed', threadId: this.threadId, turnId: target, item })
    }
    this.retryNotice = null
    this.#closedTurns.add(target)
    this.#interruptedTurns.delete(target)
    this.#emit({
      kind: 'turn.completed',
      threadId: this.threadId,
      turnId: target,
      status,
      error: error ? { message: error } : null,
    })

    if (this.#turn?.turnId === target) this.#turn = null

    // The CLI has already begun the next queued turn by the time a result
    // lands, so promoting one here keeps `turn.started` ahead of its frames.
    const next = this.#queued.shift()
    if (next) {
      this.#turn = next
      this.#emit({ kind: 'turn.started', threadId: this.threadId, turnId: next.turnId })
      this.#emit({ kind: 'session.status', threadId: this.threadId, status: 'working' })
    } else {
      this.#emitStatusIdle()
    }

    // Drop what only history needs. A finished turn is replayed from disk, so
    // the mapper only has to answer for the turn just closed, the one in flight
    // and those queued behind it; retaining every card of a long session would
    // grow without bound to serve a question nobody asks. The closed turn is
    // kept on purpose — the CLI's transcript lags the turn it belongs to, so
    // the provider still needs these items to render it.
    const keep = new Set<string>([
      target,
      ...(this.#turn ? [this.#turn.turnId] : []),
      ...this.#queued.map((t) => t.turnId),
    ])
    for (const [itemId, turnId] of this.#itemTurn) {
      if (keep.has(turnId)) continue
      this.#itemTurn.delete(itemId)
      this.#items.delete(itemId)
    }
  }

  /**
   * Declare that we asked this turn to stop, so its `result` frame is filed as
   * "interrupted" rather than "completed" (see `#handleResult`).
   */
  markInterrupted(turnId: string): void {
    this.#interruptedTurns.add(turnId)
  }

  /** Note that an approval is blocking the current turn. */
  noteAwaitingApproval(): void {
    this.#emit({ kind: 'session.status', threadId: this.threadId, status: 'waitingApproval' })
  }

  /** Note that an approval was answered and work resumes. */
  noteApprovalResolved(): void {
    if (this.#turn) {
      this.#emit({ kind: 'session.status', threadId: this.threadId, status: 'working' })
    }
  }

  // ----------------------------------------------------------- system frames

  #handleSystem(msg: any): void {
    const subtype = msg?.subtype
    // `system:init` is deliberately not turned into an event. It is the only
    // proof the subprocess came up and authenticated, but that is a fact the
    // PROVIDER needs (for `probe()`), not something the phone should render.
    if (subtype === 'init') return
    const retry = retryDetails(msg)
    if (retry && this.#turn) {
      const previous = this.itemsForTurn(this.#turn.turnId).find((item) => item.kind === 'retry')
      const item: Extract<AgentItem, { kind: 'retry' }> = {
        kind: 'retry',
        id: previous?.id ?? `claude:retry:${msg.uuid ?? this.#turn.turnId}`,
        attempts: [...(previous?.kind === 'retry' ? previous.attempts : []), retry],
      }
      this.#track(item, this.#turn.turnId)
      this.#emit({ kind: 'item.updated', threadId: this.threadId, turnId: this.#turn.turnId, item })
      this.retryNotice = {
        kind: 'error',
        threadId: this.threadId,
        turnId: this.#turn.turnId,
        message: retry.message,
        willRetry: true,
        retryAttempt: retry.attempt,
        maxRetries: retry.maxRetries,
        retryInMs: retry.delayMs,
      }
      this.#emit(this.retryNotice)
      return
    }
    // Compaction, on the other hand, is exactly the kind of thing the phone has
    // to render: nothing else in the transcript marks it, so a session that has
    // just lost most of its context looks identical to one that has not.
    if (subtype === 'compact_boundary') {
      this.#noteCompaction(msg)
      return
    }
    if (IGNORED_SYSTEM_SUBTYPES.has(subtype)) {
      this.#handleTaskLifecycle(msg)
      return
    }
  }

  /**
   * A card for "older turns were replaced by a summary".
   *
   * Files against the turn that is running, because that is where the CLI
   * reports it (auto-compaction happens inside a turn) — and if no turn is
   * open there is nothing to attach it to, so it is dropped rather than
   * invented into a turn of its own.
   */
  #noteCompaction(msg: any): void {
    const turn = this.#turn
    if (!turn) return
    const meta = msg?.compact_metadata
    // The boundary's own uuid, when the frame carries one, is the same id the
    // replay derives from the JSONL entry. A boundary that is both written
    // before `sliceAt` and delivered live is then one item on the phone
    // instead of two. Frames without a uuid keep the opaque id.
    const id = typeof msg?.uuid === 'string' ? `claude:compaction:${msg.uuid}` : this.#newId()
    const trigger = meta?.trigger === 'manual' || meta?.trigger === 'auto' ? meta.trigger : undefined
    const item: AgentItem = {
      kind: 'compaction',
      id,
      status: 'done',
      // Omitted rather than defaulted: `post_tokens` is absent on some
      // compactions, and a 0 there would read as "everything was dropped".
      ...(trigger ? { trigger } : {}),
      ...(typeof meta?.pre_tokens === 'number' ? { preTokens: meta.pre_tokens } : {}),
      ...(typeof meta?.post_tokens === 'number' ? { postTokens: meta.post_tokens } : {}),
    }
    this.#track(item, turn.turnId)
    this.#emit({ kind: 'item.completed', threadId: this.threadId, turnId: turn.turnId, item })
  }

  /**
   * Subagent progress. `task_progress` carries `usage.tool_uses`, so the child
   * count is read rather than counted, and `tool_use_id` points straight at the
   * Task card it belongs to.
   */
  #handleTaskLifecycle(msg: any): void {
    const toolUseId = msg?.tool_use_id
    if (!toolUseId) return
    const item = this.#pendingTools.get(toolUseId)
    if (!item || item.kind !== 'tool') return

    if (msg.subtype === 'task_started') {
      this.#updateItem(item.id, {
        ...item,
        subagentType: item.subagentType ?? msg.subagent_type ?? null,
      })
      return
    }

    if (msg.subtype === 'task_progress') {
      const count = msg?.usage?.tool_uses
      this.#updateItem(item.id, {
        ...item,
        childCount: typeof count === 'number' ? count : item.childCount,
      })
      return
    }

    if (msg.subtype === 'task_notification' || msg.subtype === 'task_updated') {
      const status = msg.subtype === 'task_notification' ? msg.status : msg?.patch?.status
      // The tool_result that follows carries the real output; this only makes
      // the card stop spinning if that result never arrives.
      if (status && status !== 'running') {
        this.#updateItem(item.id, { ...item, status: mapTaskStatus(status) })
      }
    }
  }

  // ----------------------------------------------------------- stream events

  #handleStreamEvent(msg: any): void {
    if (!this.#turn) return
    const ev = msg?.event
    if (!ev) return

    switch (ev.type) {
      case 'message_start': {
        this.#currentMessageId = ev.message?.id ?? null
        if (this.#currentMessageId && !this.#blocks.has(this.#currentMessageId)) {
          this.#blocks.set(this.#currentMessageId, new Map())
        }
        return
      }

      case 'content_block_start': {
        const messageId = this.#currentMessageId
        if (!messageId) return
        const index = ev.index ?? 0
        const cb = ev.content_block ?? {}

        if (cb.type === 'text' || cb.type === 'thinking') {
          this.#blocks.get(messageId)!.set(index, {
            kind: cb.type === 'thinking' ? 'thinking' : 'text',
            itemId: `claude:${cb.type === 'thinking' ? 'reasoning' : 'text'}:${messageId}:${index}`,
            text: '',
            emitted: false,
          })
          return
        }

        if (cb.type === 'tool_use') {
          // `content_block_start` already carries the full id and name, so the
          // card can appear the instant the model commits to the call rather
          // than after its arguments finish streaming. The INPUT is not here
          // yet; the assistant frame that follows completes it.
          this.#blocks.get(messageId)!.set(index, {
            kind: 'tool_use',
            itemId: `claude:tool:${cb.id}`,
            text: '',
            toolUseId: cb.id,
            name: cb.name,
            emitted: false,
          })
        }
        return
      }

      case 'content_block_delta': {
        const delta = ev.delta ?? {}
        const block = this.#blockAt(ev.index)
        if (!block) return

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text += delta.text
          this.#emit({
            kind: 'delta',
            threadId: this.threadId,
            turnId: this.#turn.turnId,
            itemId: block.itemId,
            channel: 'text',
            text: delta.text,
          })
          return
        }

        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.text += delta.thinking
          this.#emit({
            kind: 'delta',
            threadId: this.threadId,
            turnId: this.#turn.turnId,
            itemId: block.itemId,
            channel: 'reasoning',
            text: delta.thinking,
          })
          return
        }

        // `input_json_delta` and `signature_delta` are deliberately dropped:
        // the assistant frame carries the complete parsed tool input, so
        // reassembling JSON fragments here would only add a way to be wrong.
        return
      }

      case 'content_block_stop': {
        const block = this.#blockAt(ev.index)
        if (block) this.#completeBlock(block)
        return
      }

      default:
        return
    }
  }

  #blockAt(index: unknown): BlockState | null {
    if (!this.#currentMessageId) return null
    return this.#blocks.get(this.#currentMessageId)?.get(Number(index ?? 0)) ?? null
  }

  /**
   * Emit the authoritative item for a finished block.
   *
   * Text and reasoning are closed HERE, from the accumulated deltas, and the
   * `assistant` frame is ignored for them. Two reasons, both measured:
   *   - the assistant frame duplicates the text, and `Chat.tsx` renders both
   *     the card and the streaming tail, so the phone would show it twice;
   *   - a thinking block arrives in the assistant frame with EMPTY text (only
   *     its signature survives), so the deltas are the only copy that exists.
   */
  #completeBlock(block: BlockState): void {
    if (block.emitted || !this.#turn) return
    if (block.kind === 'tool_use') return // closed by the assistant frame / result

    block.emitted = true
    const item: AgentItem =
      block.kind === 'thinking'
        ? { kind: 'reasoning', id: block.itemId, summary: [], content: [block.text] }
        : { kind: 'message', id: block.itemId, role: 'assistant', text: block.text }

    this.#track(item, this.#turn.turnId)
    this.#emit({
      kind: 'item.completed',
      threadId: this.threadId,
      turnId: this.#turn.turnId,
      item,
    })
  }

  #flushOpenBlocks(): void {
    const turnId = this.#turn?.turnId
    if (!turnId) return
    for (const blocks of this.#blocks.values()) {
      for (const block of blocks.values()) {
        if (block.kind === 'tool_use' || block.emitted) continue
        block.emitted = true
        const item: AgentItem =
          block.kind === 'thinking'
            ? { kind: 'reasoning', id: block.itemId, summary: [], content: [block.text] }
            : { kind: 'message', id: block.itemId, role: 'assistant', text: block.text }
        this.#track(item, turnId)
        this.#emit({ kind: 'item.completed', threadId: this.threadId, turnId, item })
      }
    }
  }

  // -------------------------------------------------------- assistant frames

  #handleAssistant(msg: any): void {
    if (!this.#turn) return
    // Subagent traffic is intentionally not expanded: a 380px column cannot
    // hold a nested transcript. Its Task card shows a child count instead, fed
    // by `task_progress`.
    if (msg.parent_tool_use_id) return

    const content = msg?.message?.content
    if (!Array.isArray(content)) return
    // Synthetic API failures have no stream deltas. They must not go through
    // the normal assistant-text deduplication path below.
    if (msg.isApiErrorMessage || msg.error) {
      const message = content
        .filter((p: any) => p?.type === 'text')
        .map((p: any) => p.text)
        .join('\n')
      const item: AgentItem = {
        kind: 'error',
        id: `claude:error:${msg.uuid ?? msg.message?.id ?? this.#turn.turnId}`,
        message: message || 'API request failed',
      }
      this.#track(item, this.#turn.turnId)
      this.#emit({ kind: 'item.completed', threadId: this.threadId, turnId: this.#turn.turnId, item })
      return
    }
    const messageId = msg?.message?.id ?? this.#currentMessageId

    for (const part of content) {
      if (part?.type !== 'tool_use') continue

      // Match by tool id, NOT by position. Measured: the CLI emits one
      // assistant frame PER CONTENT BLOCK, so a frame's array position is
      // always 0 while the block's live index may be anything — `get(0)` would
      // name whichever block landed at index 0, not this one. In today's
      // captured ordering that mistake stays harmless (a block's own
      // `content_block_stop` always precedes the next block's assistant frame,
      // so text and reasoning are closed before any wrong marking could reach
      // them), which is exactly why it is worth replacing: correctness should
      // not rest on an unstated ordering invariant that nothing enforces.
      // Tool ids are unique, so this match is exact by construction.
      if (messageId) {
        for (const block of this.#blocks.get(messageId)?.values() ?? []) {
          if (block.kind === 'tool_use' && block.toolUseId === part.id) block.emitted = true
        }
      }

      const item = mapToolItem({
        toolUseId: part.id,
        name: String(part.name ?? ''),
        input: part.input,
        status: 'running',
      })
      this.#pendingTools.set(part.id, item)
      this.#track(item, this.#turn.turnId)
      this.#emit({
        kind: 'item.started',
        threadId: this.threadId,
        turnId: this.#turn.turnId,
        item,
      })

      // TODO items also drive the structured plan panel, which is separate
      // from the transcript card.
      if (part.name === 'TodoWrite') {
        this.#emit({
          kind: 'plan.updated',
          threadId: this.threadId,
          turnId: this.#turn.turnId,
          plan: planFromTodos(part.input),
        })
      }
    }
  }

  // ------------------------------------------------------------- tool results

  #handleUser(msg: any): void {
    if (!this.#turn) return

    // Text parts on `user` messages are ignored outright. The CLI injects
    // system-reminders and echoes a subagent's own prompt onto the main thread
    // (captured verbatim), so honouring them would put words in the user's
    // mouth. We already emitted the real user bubble in `beginTurn`.
    if (msg.parent_tool_use_id) return

    const content = msg?.message?.content
    if (!Array.isArray(content)) return

    for (const part of content) {
      if (part?.type !== 'tool_result') continue
      const toolUseId = part.tool_use_id
      const item = this.#pendingTools.get(toolUseId)
      if (!item) continue
      this.#pendingTools.delete(toolUseId)

      const text = toolResultText(part.content)
      const isError = Boolean(part.is_error)
      const merged = applyToolResult(item, msg?.tool_use_result, text, isError)
      this.#track(merged, this.#turn.turnId)
      this.#emit({
        kind: 'item.completed',
        threadId: this.threadId,
        turnId: this.#turn.turnId,
        item: merged,
      })
    }
  }

  // ------------------------------------------------------------- turn result

  #handleResult(msg: any): void {
    const commandUuid = msg?.user_message_uuid
    const turnId = commandUuid ? this.#byCommand.get(commandUuid) : undefined
    if (commandUuid) this.#byCommand.delete(commandUuid)

    if (msg?.usage) {
      const targetTurn = turnId ?? this.#turn?.turnId
      if (targetTurn) {
        this.#emit({
          kind: 'usage.updated',
          threadId: this.threadId,
          turnId: targetTurn,
          usage: mapResultUsage(msg.usage, msg.modelUsage),
        })
      }
    }

    // A captured interrupt produced `subtype: 'success'`,
    // `terminal_reason: 'completed'`, `is_error: false` — so the result frame
    // CANNOT classify the ending, and reading it naively would file every
    // stopped turn as a success. Only the party that called `interrupt()`
    // knows, which is why the status is carried in from `markInterrupted`.
    const interrupted = turnId ? this.#interruptedTurns.has(turnId) : false
    const status = interrupted ? 'interrupted' : msg?.is_error ? 'failed' : 'completed'
    const error =
      !interrupted && msg?.is_error
        ? String(msg?.result || msg?.errors?.join('\n') || '代理执行失败，未返回具体原因。')
        : undefined
    this.finish(status, error, turnId ?? undefined)
  }

  #emitStatusIdle(): void {
    this.#emit({ kind: 'session.status', threadId: this.threadId, status: 'idle' })
  }

  #updateItem(itemId: string, item: AgentItem): void {
    if (!this.#turn) return
    this.#track(item, this.#turn.turnId)
    this.#emit({ kind: 'item.updated', threadId: this.threadId, turnId: this.#turn.turnId, item })
  }
}

/** Tool results arrive as a string, an array of content blocks, or neither. */
