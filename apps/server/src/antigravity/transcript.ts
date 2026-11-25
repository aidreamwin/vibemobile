import type { ContentBlock, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { AgentEvent, AgentInput, AgentItem, TranscriptTurn, TurnStatus } from '@vibemobile/protocol'
import { capImages, type ImageStore } from '../images/store.js'

export function promptBlocks(input: AgentInput[], supportsImage: boolean): ContentBlock[] {
  return capImages(input).map((part) => {
    if (part.type === 'text') return part
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(part.url)
    if (!supportsImage || !match?.[1] || !match[2]) throw new Error('Antigravity 无法接收这张图片。')
    return { type: 'image', mimeType: match[1], data: match[2] }
  })
}

type ToolItem = Extract<AgentItem, { kind: 'tool' }>

export const toolItemId = (turnId: string, callId: string) => `${turnId}:tool:${callId}`

function toolOutput(update: ToolCallUpdate): string | undefined {
  const parts = update.content?.flatMap((block) => {
    if (block.type === 'content' && block.content.type === 'text') return [block.content.text]
    if (block.type === 'diff') return [`${block.path}\n${block.newText}`]
    return []
  })
  if (parts?.length) return parts.join('\n')
  if (update.rawOutput != null)
    return typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)
  return undefined
}

/** ACP replays the same update stream on load. Only an active prompt publishes it to the hub. */
export class AgyTranscript {
  readonly turns: TranscriptTurn[] = []
  live = false
  #lastMessage: { type: string; native?: string | null; item: AgentItem } | undefined
  #tools = new Map<string, ToolItem>()

  constructor(
    readonly threadId: string,
    private emit: (event: AgentEvent) => void,
    private images?: ImageStore,
  ) {}

  get turn() {
    return this.turns.at(-1)
  }

  begin() {
    this.finish('completed')
    const id = `${this.threadId}:turn:${this.turns.length}`
    this.turns.push({ id, items: [], status: 'inProgress', ...(this.live ? { startedAt: Date.now() } : {}) })
    this.#tools.clear()
    if (this.live) this.emit({ kind: 'turn.started', threadId: this.threadId, turnId: id })
    return id
  }

  #currentTurn() {
    const turn = this.turn
    if (!turn) throw new Error('Antigravity item received without a turn')
    return turn
  }

  #id() {
    const turn = this.#currentTurn()
    return `${turn.id}:${turn.items.length}`
  }

  #item(kind: 'item.started' | 'item.updated' | 'item.completed', item: AgentItem) {
    if (this.live) this.emit({ kind, threadId: this.threadId, turnId: this.#currentTurn().id, item })
  }

  #endMessage() {
    if (this.#lastMessage) this.#item('item.completed', this.#lastMessage.item)
    this.#lastMessage = undefined
  }

  #userBlock(item: Extract<AgentItem, { kind: 'message' }>, block: ContentBlock) {
    if (block.type === 'text') item.text += block.text
    if (block.type === 'image') {
      const token = this.images?.put(`data:${block.mimeType};base64,${block.data}`)
      if (token) {
        item.images ??= []
        item.images.push(token)
      }
    }
  }

  userInput(blocks: ContentBlock[]) {
    this.#endMessage()
    const item: AgentItem = { kind: 'message', role: 'user', id: this.#id(), text: '', at: Date.now() }
    for (const block of blocks) this.#userBlock(item, block)
    this.#currentTurn().items.push(item)
    this.#item('item.completed', item)
  }

  update(update: SessionUpdate) {
    const type = update.sessionUpdate
    if (type === 'user_message_chunk' || type === 'agent_thought_chunk' || type === 'agent_message_chunk') {
      if (this.live && type === 'user_message_chunk') return // Prompt and steer already inserted the user's input.
      let message = this.#lastMessage
      if (!message || message.type !== type || message.native !== update.messageId) {
        if (!this.turn || (type === 'user_message_chunk' && !this.live)) this.begin()
        this.#endMessage()
        const item: AgentItem =
          type === 'agent_thought_chunk'
            ? { kind: 'reasoning', id: this.#id(), summary: [], content: [] }
            : { kind: 'message', id: this.#id(), role: type === 'user_message_chunk' ? 'user' : 'assistant', text: '' }
        this.#currentTurn().items.push(item)
        message = { type, native: update.messageId, item }
        this.#lastMessage = message
        this.#item('item.started', item)
      }
      const item = message.item
      if (item.kind === 'message' && item.role === 'user') {
        this.#userBlock(item, update.content)
      } else if (update.content.type === 'text') {
        const text = update.content.text
        if (item.kind === 'message') item.text += text
        if (item.kind === 'reasoning') item.content[0] = (item.content[0] ?? '') + text
        if (this.live)
          this.emit({
            kind: 'delta',
            threadId: this.threadId,
            turnId: this.#currentTurn().id,
            itemId: item.id,
            channel: item.kind === 'reasoning' ? 'reasoning' : 'text',
            text,
          })
      }
      return
    }
    if (type !== 'tool_call' && type !== 'tool_call_update') return
    if (!this.turn) this.begin()
    this.#endMessage()
    const existing = this.#tools.get(update.toolCallId)
    const item: ToolItem = existing ?? {
      kind: 'tool',
      id: toolItemId(this.#currentTurn().id, update.toolCallId),
      name: update.kind ?? 'tool',
      title: '',
      status: 'running',
    }
    item.title = update.title ?? (item.title || item.name)
    item.name = update.name ?? update.kind ?? item.name
    if (update.status)
      item.status = update.status === 'completed' ? 'done' : update.status === 'failed' ? 'failed' : 'running'
    if (update.rawInput != null) item.input = update.rawInput
    item.output = toolOutput(update) ?? item.output
    if (!existing) {
      this.#currentTurn().items.push(item)
      this.#tools.set(update.toolCallId, item)
    }
    this.#item(item.status !== 'running' ? 'item.completed' : existing ? 'item.updated' : 'item.started', item)
  }

  finish(status: TurnStatus, error?: string) {
    const turn = this.turn
    if (turn?.status !== 'inProgress') return
    this.#endMessage()
    if (status === 'interrupted' || status === 'failed') {
      for (const tool of this.#tools.values()) {
        if (tool.status !== 'running') continue
        tool.status = status === 'interrupted' ? 'declined' : 'failed'
        this.#item('item.completed', tool)
      }
    }
    if (error) {
      const item: AgentItem = { kind: 'error', id: this.#id(), message: error }
      turn.items.push(item)
      this.#item('item.completed', item)
    }
    turn.status = status
    if (this.live) {
      turn.completedAt = Date.now()
      this.emit({
        kind: 'turn.completed',
        threadId: this.threadId,
        turnId: turn.id,
        status,
        at: turn.completedAt,
        ...(error ? { error: { message: error } } : {}),
      })
    }
  }

  page(opts: { targetItems?: number; limit?: number; cursor?: string }) {
    let t = this.turns.length - 1
    let end = this.turns[t]?.items.length ?? 0
    if (opts.cursor) {
      const match = /^(.+)\/(\d+)\/(\d+)$/.exec(opts.cursor)
      t = Number(match?.[2])
      end = Number(match?.[3])
      const anchor = this.turns[t]
      if (match?.[1] !== this.threadId || !anchor || !Number.isSafeInteger(end) || end > anchor.items.length)
        throw Object.assign(new Error('invalid Antigravity transcript cursor'), { statusCode: 400 })
    }
    const turns: TranscriptTurn[] = []
    let remaining = opts.targetItems ?? (opts.limit ? Infinity : 60)
    const maxTurns = opts.targetItems ? Infinity : (opts.limit ?? Infinity)
    let bytes = 0
    while (t >= 0 && remaining > 0 && turns.length < maxTurns) {
      const turn = this.turns[t]
      if (!turn) break
      let start = end
      while (start > 0 && remaining > 0) {
        const size = Buffer.byteLength(JSON.stringify(turn.items[start - 1])) + 1
        if (bytes && bytes + size > 512 * 1024) break
        bytes += size
        start--
        remaining--
      }
      if (start < end || !end)
        turns.unshift({ ...turn, items: turn.items.slice(start, end), ...(start ? { hasEarlierItems: true } : {}) })
      if (start) {
        end = start
        break
      }
      end = this.turns[--t]?.items.length ?? 0
    }
    return { turns, ...(t >= 0 ? { hasMore: true, nextCursor: `${this.threadId}/${t}/${end}` } : {}) }
  }
}
