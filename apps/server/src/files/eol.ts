/**
 * Line-ending preservation for file writes.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * A browser `<textarea>` normalizes every line ending it is given to `\n` and
 * nothing it does can put the `\r` back. So the text arriving here has already
 * lost the file's convention, whatever the round trip looked like from the
 * phone — and writing it back verbatim rewrites every line of a CRLF file.
 *
 * That failure is invisible in the worst way: the save succeeds, the content is
 * correct, and `git diff` shows the whole file changed. So the rule is
 * structural rather than a convention callers must remember:
 *
 *     the wire is always LF; the server restores the file's own convention
 *
 * The three functions below are pure and exported so the property can be
 * asserted directly (`eol.test.ts`) instead of through a filesystem round trip.
 */

/** The two conventions this app preserves. A lone `\r` is not one of them. */
export type Eol = '\r\n' | '\n'

/**
 * Which convention a file uses, judged from its bytes.
 *
 * `\r\n` wins if there is even one: it is never ambiguous — a file with any
 * CRLF in it was written by something that meant CRLF — whereas a lone `\n` is
 * what every editor produces *by accident* when it appends to a CRLF file. A
 * mixed file is therefore rewritten as CRLF, which keeps the majority of its
 * lines byte-identical rather than all of them.
 */
export function detectEol(bytes: Buffer): Eol {
  return bytes.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Normalize to the wire convention: LF only.
 *
 * The second replace is not redundant — an old-Mac `\r`-only file, or a stray
 * `\r` mid-line, would otherwise survive into `applyEol` and become `\r\r\n`.
 * Do not drop either step; `applyEol` is not idempotent, and this is the reason
 * it does not have to be.
 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Convert LF-only text to the file's own convention. */
export function applyEol(text: string, eol: Eol): string {
  return eol === '\n' ? text : text.replace(/\n/g, '\r\n')
}
