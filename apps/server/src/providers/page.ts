/**
 * Turn-aware paging for transcripts.
 *
 * `targetItems` is a budget in rendered items, not a number of turns: a turn
 * can be one message or several hundred tool cards, so a fixed turn count
 * makes pages wildly uneven on a phone. Turns are still the unit of the cut —
 * slicing one in half leaves tool cards without a user bubble and makes the
 * turn-based cursor unable to name where the next page begins.
 */

export interface ItemPage {
  /** Index of the first returned turn (inclusive). */
  start: number
  /** Index after the last returned turn (exclusive). */
  end: number
  /** Items in the returned turns. May exceed the target; never below it unless the page hit the start. */
  items: number
}

/**
 * Pick the newest whole turns that add up to `targetItems`, skipping the
 * `skip` newest turns already on screen.
 *
 * At least one turn is returned whenever any remain, even when its item count
 * is zero: a page that comes back empty would let the client conclude there is
 * nothing older.
 */
export function pageTurnsByItems<T extends { items: readonly unknown[] }>(
  turns: readonly T[],
  targetItems: number,
  skip: number,
): ItemPage {
  const end = Math.max(0, Math.min(turns.length, turns.length - skip))
  const target = targetItems > 0 ? targetItems : 1
  let start = end
  let items = 0
  while (start > 0) {
    start--
    items += turns[start].items.length
    if (items >= target) break
  }
  return { start, end, items }
}
