import fs from 'node:fs'
import path from 'node:path'

/** VibeMobile-owned record of prompts whose native termination is unconfirmed. */
export class AgyTurnJournal {
  #ids: Set<string> | undefined

  constructor(private readonly file?: string) {}

  pending(): string[] {
    if (!this.#ids) {
      let ids: string[] = []
      if (this.file) {
        try {
          const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
          if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.startsWith('agy:')))
            throw new Error('Antigravity 回合恢复记录格式错误。')
          ids = value
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      this.#ids = new Set(ids)
    }
    return [...this.#ids]
  }

  mark(id: string) {
    const next = new Set(this.pending())
    next.add(id)
    this.#save(next)
  }

  clear(id: string) {
    const next = new Set(this.pending())
    if (next.delete(id)) this.#save(next)
  }

  #save(next: Set<string>) {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      fs.writeFileSync(temporary, JSON.stringify([...next]), { mode: 0o600 })
      fs.renameSync(temporary, this.file)
    }
    this.#ids = next
  }
}
