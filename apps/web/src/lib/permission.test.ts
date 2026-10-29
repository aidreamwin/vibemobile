import { describe, expect, it } from 'vitest'
import { PERMISSIONS, PERMISSION_CARDS, permissionCardFor, permissionCardsFor } from './permission'

const ALL = PERMISSION_CARDS
const WITHOUT_AUTO = permissionCardsFor('codex')

describe('permission cards', () => {
  it('round-trips every card through the pair the server reports', () => {
    for (const card of ALL) {
      const { sandbox, approvalPolicy } = PERMISSIONS[card]
      expect(permissionCardFor(sandbox, approvalPolicy, ALL)).toBe(card)
    }
  })

  // The failure this guards is not cosmetic: falling back to the LAST card
  // instead of the safe one means a phone runs unattended because a session
  // happened to be on 完全访问 earlier. `undefined` is what the server reports
  // for any session it has no memory of, so it is a real input, not a
  // malformed one.
  it('falls back to 按需确认 when the provider does not know', () => {
    expect(permissionCardFor(undefined, undefined, ALL)).toBe('ask')
    expect(permissionCardFor(null, null, ALL)).toBe('ask')
  })

  it('does not match on half a pair', () => {
    expect(permissionCardFor('danger-full-access', undefined, ALL)).toBe('ask')
    expect(permissionCardFor(undefined, 'never', ALL)).toBe('ask')
    expect(permissionCardFor('danger-full-access', 'on-request', ALL)).toBe('ask')
  })

  /**
   * The six combinations the new-session sheet can create that this table
   * cannot express. They are remembered and reported faithfully, and they land
   * here — on the default card — until the next message sends the card on
   * screen. Note the fallback is not a guarantee of "never more access": of
   * these six, two come out wider on one half once that message goes (the first
   * and the last below). What it does guarantee is that an unrecognized pair
   * never lights up 完全访问 and never silently becomes the level shown.
   */
  it('falls back to 按需确认 for pairs no card can express', () => {
    expect(permissionCardFor('workspace-write', 'never', ALL)).toBe('ask')
    expect(permissionCardFor('read-only', 'on-request', ALL)).toBe('ask')
    expect(permissionCardFor('read-only', 'never', ALL)).toBe('ask')
    expect(permissionCardFor('danger-full-access', 'untrusted', ALL)).toBe('ask')
  })

  it('keeps 完全访问 as the last card, so it is never the default', () => {
    expect(ALL.at(-1)).toBe('unattended')
  })
})

describe('permissionCardsFor', () => {
  /**
   * The rung with no Codex equivalent, and the value Codex cannot accept
   * (`codex/permission.ts` refuses it, so a Codex turn carrying it records
   * nothing). Offering it there would be a card that does nothing.
   */
  it('offers 自动判断 only for Claude', () => {
    expect(permissionCardsFor('claude')).toContain('auto')
    expect(permissionCardsFor('codex')).not.toContain('auto')
  })

  it('gives an unknown or missing provider the narrow list', () => {
    expect(permissionCardsFor(undefined)).toEqual(WITHOUT_AUTO)
    expect(permissionCardsFor('some-future-agent')).toEqual(WITHOUT_AUTO)
  })

  it('keeps the order and the safe card in every list', () => {
    for (const list of [ALL, WITHOUT_AUTO]) {
      expect(list[0]).toBe('ask')
      expect(list.at(-1)).toBe('unattended')
      expect([...list]).toEqual(ALL.filter((card) => list.includes(card)))
    }
  })

  /**
   * The invariant that makes the required `cards` argument worth its cost: the
   * picker renders one `SelectItem` per card it was handed and Radix paints an
   * EMPTY trigger when `value` has no matching item — so a selected card that
   * is not in the list is a blank control, not a visible mistake.
   */
  it('never selects a card the list does not contain', () => {
    const pairs: readonly (readonly [
      Parameters<typeof permissionCardFor>[0],
      Parameters<typeof permissionCardFor>[1],
    ])[] = [
      ...ALL.map((card) => [PERMISSIONS[card].sandbox, PERMISSIONS[card].approvalPolicy] as const),
      [undefined, undefined],
      ['workspace-write', 'never'],
    ]
    for (const list of [ALL, WITHOUT_AUTO]) {
      for (const [sandbox, approvalPolicy] of pairs) {
        expect(list).toContain(permissionCardFor(sandbox, approvalPolicy, list))
      }
    }
  })

  /**
   * The case that motivated the filter, stated as behaviour: a Claude session on
   * 自动判断 opened by a caller that forgot to pass the provider. It reports the
   * safe card rather than 'auto', which is the only card that would be missing
   * from the list it was given.
   */
  it('reports 按需确认 for auto on a list that cannot express it', () => {
    expect(permissionCardFor('workspace-write', 'auto', WITHOUT_AUTO)).toBe('ask')
    expect(permissionCardFor('workspace-write', 'auto', ALL)).toBe('auto')
  })
})
