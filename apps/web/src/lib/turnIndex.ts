/** Transcript items and turn ids are scoped to one chat store. */
export function createTurnIndex() {
  const turnOfItem = new Map<string, string>()

  return {
    indexTurns(turns: { id: string; items: { id: string }[] }[]) {
      for (const turn of turns) for (const item of turn.items) turnOfItem.set(item.id, turn.id)
    },
    indexItem(itemId: string, turnId: string) {
      turnOfItem.set(itemId, turnId)
    },
    turnIdOfItem(itemId: string) {
      return turnOfItem.get(itemId)
    },
    clear() {
      turnOfItem.clear()
    },
  }
}
