import { describe, expect, it } from 'vitest'
import { type EnterKey, isSendKey } from './composerKeys'

function key(overrides: Partial<EnterKey> = {}): EnterKey {
  return {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 13,
    ...overrides,
  }
}

describe('isSendKey', () => {
  it('lets plain Enter type a newline on every device', () => {
    expect(isSendKey(key())).toBe(false)
  })

  it('lets Shift+Enter type a newline too', () => {
    expect(isSendKey(key({ shiftKey: true }))).toBe(false)
  })

  it('sends on Ctrl+Enter and Cmd+Enter', () => {
    expect(isSendKey(key({ ctrlKey: true }))).toBe(true)
    expect(isSendKey(key({ metaKey: true }))).toBe(true)
  })

  // The first Enter of a Chinese input used to send the message instead of
  // confirming the candidate.
  it('never sends while an IME is composing', () => {
    expect(isSendKey(key({ isComposing: true }))).toBe(false)
    expect(isSendKey(key({ keyCode: 229 }))).toBe(false)
  })

  it('ignores other keys', () => {
    expect(isSendKey(key({ key: 'a' }))).toBe(false)
  })
})
