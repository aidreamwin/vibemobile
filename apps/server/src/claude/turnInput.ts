import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentInput } from '@vibemobile/protocol'

export class TurnInput {
  #queue: SDKUserMessage[] = []
  #waiters: ((msg: SDKUserMessage | null) => void)[] = []
  #closed = false

  push(uuid: string, input: AgentInput[]): void {
    const msg = {
      type: 'user',
      uuid,
      message: { role: 'user', content: input.map(toSdkContent) },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage
    const waiter = this.#waiters.shift()
    if (waiter) waiter(msg)
    else this.#queue.push(msg)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter(null)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.#closed) {
      const queued = this.#queue.shift()
      if (queued) {
        yield queued
        continue
      }
      const next = await new Promise<SDKUserMessage | null>((resolve) => {
        this.#waiters.push(resolve)
        if (this.#closed) resolve(null)
      })
      if (next) yield next
    }
  }
}

export function toSdkContent(input: AgentInput): unknown {
  if (input.type === 'text') return { type: 'text', text: input.text }
  // The SDK takes base64 image sources; a data: URL is the only shape the
  // client can produce, since a phone has no way to hand us a local file.
  const match = /^data:([^;]+);base64,(.*)$/s.exec(input.url)
  if (!match) return { type: 'text', text: `[image omitted: unsupported URL]` }
  return {
    type: 'image',
    source: { type: 'base64', media_type: match[1], data: match[2] },
  }
}
