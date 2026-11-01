/**
 * Enter types a newline everywhere; Ctrl/Cmd+Enter sends.
 *
 * Shift+Enter is also a newline, so the habit from every other editor keeps
 * working. The send button is the primary way out on a phone, where there is
 * no modifier to hold.
 *
 * Enter while an IME is composing belongs to the candidate list, never to the
 * message. `keyCode === 229` is the legacy spelling of the same state, still
 * emitted by some mobile keyboards.
 */
export interface EnterKey {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  isComposing: boolean
  keyCode: number
}

export function isSendKey(event: EnterKey): boolean {
  if (event.isComposing || event.keyCode === 229) return false
  if (event.key !== 'Enter' || event.shiftKey) return false
  return event.metaKey || event.ctrlKey
}
