import { describe, expect, it } from 'vitest'
import { applyEol, detectEol, toLf } from './eol.js'

describe('detectEol', () => {
  it('reports the convention a file was written with', () => {
    expect(detectEol(Buffer.from('a\r\nb\r\n'))).toBe('\r\n')
    expect(detectEol(Buffer.from('a\nb\n'))).toBe('\n')
  })

  it('prefers CRLF in a mixed file', () => {
    // The stray LF is what an editor that appended to a CRLF file leaves
    // behind; calling this file LF would rewrite all the other lines.
    expect(detectEol(Buffer.from('a\r\nb\nc\r\n'))).toBe('\r\n')
  })

  it('treats a file with no newline at all as LF', () => {
    expect(detectEol(Buffer.from('one line'))).toBe('\n')
  })
})

describe('toLf', () => {
  it('normalizes CRLF and a lone CR', () => {
    expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('is what makes applyEol safe to call', () => {
    // The whole reason both exist: `applyEol` on CRLF input would produce
    // `\r\r\n`. This is the assertion that pins the pair down.
    const crlf = 'a\r\nb\r\n'
    expect(applyEol(crlf, '\r\n')).toBe('a\r\r\nb\r\r\n')
    expect(applyEol(toLf(crlf), '\r\n')).toBe(crlf)
  })

  it('round-trips a file through the wire convention and back', () => {
    const crlf = 'one\r\ntwo\r\nthree\r\n'
    expect(applyEol(toLf(crlf), '\r\n')).toBe(crlf)
    const lf = 'one\ntwo\n'
    expect(applyEol(toLf(lf), '\n')).toBe(lf)
  })

  it('leaves LF text alone under either convention', () => {
    expect(applyEol('a\nb', '\n')).toBe('a\nb')
  })
})
