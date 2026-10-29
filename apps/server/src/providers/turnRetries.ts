import fs from 'node:fs'
import path from 'node:path'
import type { AgentEvent, AgentItem } from '@vibemobile/protocol'

type RetryItem = Extract<AgentItem, { kind: 'retry' }>

/** Codex notifications are not included in thread/turns/list. Keep bounded diagnostics separately. */
export class TurnRetryStore {
  #file?: string
  #items: Record<string, RetryItem> = {}
  #log: (message: string) => void
  constructor(file?: string, log: (message: string) => void = () => {}) {
    this.#file = file
    this.#log = log
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          for (const [key, value] of Object.entries(data).slice(-500)) {
            const item = value as RetryItem
            if (item?.kind === 'retry' && typeof item.id === 'string' && Array.isArray(item.attempts)) {
              this.#items[key] = {
                ...item,
                attempts: item.attempts.filter((a) => a && typeof a.message === 'string').slice(-100),
              }
            }
          }
        }
      } catch (error) {
        log(`Cannot read retry diagnostics: ${(error as Error).message}`)
      }
    }
  }
  get(threadId: string, turnId: string): RetryItem | undefined {
    return this.#items[`${threadId}:${turnId}`]
  }
  add(event: Extract<AgentEvent, { kind: 'error' }> & { threadId: string; turnId: string }): RetryItem {
    const key = `${event.threadId}:${event.turnId}`
    const previous = this.#items[key]
    const item: RetryItem = {
      kind: 'retry',
      id: `codex:retry:${event.turnId}`,
      attempts: [
        ...(previous?.attempts ?? []),
        {
          message: event.message,
          attempt: event.retryAttempt,
          maxRetries: event.maxRetries,
          delayMs: event.retryInMs,
          at: new Date().toISOString(),
        },
      ].slice(-100),
    }
    delete this.#items[key]
    this.#items[key] = item
    const keys = Object.keys(this.#items)
    for (const old of keys.slice(0, Math.max(0, keys.length - 500))) delete this.#items[old]
    if (this.#file) {
      try {
        fs.mkdirSync(path.dirname(this.#file), { recursive: true })
        fs.writeFileSync(`${this.#file}.tmp`, JSON.stringify(this.#items), { mode: 0o600 })
        fs.renameSync(`${this.#file}.tmp`, this.#file)
      } catch (error) {
        this.#log(`Cannot save retry diagnostics: ${(error as Error).message}`)
      }
    }
    return item
  }
}
