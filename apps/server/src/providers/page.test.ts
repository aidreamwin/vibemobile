import { describe, expect, it } from 'vitest'
import { pageTurnsByItems } from './page.js'

const turn = (items: number) => ({ items: Array.from({ length: items }, () => ({})) })

describe('pageTurnsByItems', () => {
  it('returns one turn when it alone fills the budget', () => {
    // The newest turn is the big one, so nothing older is needed.
    const turns = [turn(10), turn(5), turn(100)]
    expect(pageTurnsByItems(turns, 60, 0)).toEqual({ start: 2, end: 3, items: 100 })
  })

  it('keeps adding whole older turns until the budget is met', () => {
    const turns = [turn(30), turn(25), turn(20), turn(100)]
    // Newest first: 100 already exceeds 60, so only the last turn is returned.
    expect(pageTurnsByItems(turns, 60, 0)).toEqual({ start: 3, end: 4, items: 100 })
    expect(pageTurnsByItems([turn(30), turn(25), turn(20)], 60, 0)).toEqual({
      start: 0,
      end: 3,
      items: 75,
    })
  })

  it('skips turns already on screen and counts only this page', () => {
    const turns = [turn(20), turn(20), turn(20), turn(20)]
    expect(pageTurnsByItems(turns, 60, 1)).toEqual({ start: 0, end: 3, items: 60 })
    expect(pageTurnsByItems(turns, 30, 2)).toEqual({ start: 0, end: 2, items: 40 })
  })

  it('returns nothing when the cursor is past the end', () => {
    expect(pageTurnsByItems([turn(5)], 60, 3)).toEqual({ start: 0, end: 0, items: 0 })
  })

  it('never returns an empty page just because the newest turn has no items', () => {
    const turns = [turn(60), turn(0)]
    expect(pageTurnsByItems(turns, 60, 0)).toEqual({ start: 0, end: 2, items: 60 })
  })

  it('treats a non-positive budget as one item', () => {
    expect(pageTurnsByItems([turn(0), turn(1)], 0, 0)).toEqual({ start: 1, end: 2, items: 1 })
  })
})
