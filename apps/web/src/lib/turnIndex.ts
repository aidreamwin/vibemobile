/**
 * Which turn each rendered item belongs to.
 *
 * The store flattens turns into one item list for rendering and streaming, so
 * the page loses the boundaries that "download this turn" needs. This tiny
 * side index is rebuilt from every transcript page and extended by live
 * `item.*` events; it is keyed by the open thread because item ids are only
 * unique within a conversation.
 */
let thread = ''
const turnOfItem = new Map<string, string>()

function bind(threadId: string): void {
  if (thread === threadId) return
  thread = threadId
  turnOfItem.clear()
}

export function indexTurns(threadId: string, turns: { id: string; items: { id: string }[] }[]): void {
  bind(threadId)
  for (const turn of turns) for (const item of turn.items) turnOfItem.set(item.id, turn.id)
}

export function indexItemTurn(threadId: string, itemId: string, turnId: string): void {
  bind(threadId)
  turnOfItem.set(itemId, turnId)
}

export function turnIdOfItem(threadId: string, itemId: string): string | undefined {
  return thread === threadId ? turnOfItem.get(itemId) : undefined
}
