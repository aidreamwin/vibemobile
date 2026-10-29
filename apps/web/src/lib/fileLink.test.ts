import { describe, expect, it } from 'vitest'
import { parseFileRef } from './fileLink'

const CWD = 'D:\\code\\aidlux\\playbook'

/** Every href below was copied out of a real session transcript. */
describe('file references in agent markdown', () => {
  it('reads the absolute Windows link Claude Code writes, with its line number', () => {
    expect(parseFileRef('/D:/code/aidlux/playbook/.ai/rules/testing.md:10', CWD)).toEqual({
      path: 'D:/code/aidlux/playbook/.ai/rules/testing.md',
      line: 10,
    })
  })

  it('reads one without the leading slash, and one written with backslashes', () => {
    expect(parseFileRef('D:/code/aidlux/playbook/CURRENT.md', CWD)?.path).toBe('D:/code/aidlux/playbook/CURRENT.md')
    expect(parseFileRef('D:\\code\\aidlux\\playbook\\CURRENT.md', CWD)?.path).toBe('D:/code/aidlux/playbook/CURRENT.md')
  })

  it('resolves a relative link against the session cwd, not the page', () => {
    expect(parseFileRef('rules/testing.md', CWD)).toEqual({
      path: 'D:/code/aidlux/playbook/rules/testing.md',
      line: null,
    })
    expect(parseFileRef('../llamacpp-8625-85/SUMMARY.md', CWD)?.path).toBe('D:/code/aidlux/llamacpp-8625-85/SUMMARY.md')
    // `..` past the drive root stays there; it cannot climb above `D:/`.
    expect(parseFileRef('../../../outside.md', CWD)?.path).toBe('D:/outside.md')
    expect(parseFileRef('experiments/exp-20261010-001.md:12', CWD)).toEqual({
      path: 'D:/code/aidlux/playbook/experiments/exp-20261010-001.md',
      line: 12,
    })
  })

  it('takes the line from a GitHub-style anchor', () => {
    expect(parseFileRef('.ai/README.md#L37', CWD)).toEqual({
      path: 'D:/code/aidlux/playbook/.ai/README.md',
      line: 37,
    })
    expect(parseFileRef('D:/code/x/a.py#L12-L20', CWD)).toEqual({ path: 'D:/code/x/a.py', line: 12 })
  })

  it('decodes a percent-escaped path and unwraps an angle-bracketed one', () => {
    expect(parseFileRef('my%20file.md', CWD)?.path).toBe('D:/code/aidlux/playbook/my file.md')
    // A `%` that is not an escape sequence must survive untouched.
    expect(parseFileRef('100%25.md', CWD)?.path).toBe('D:/code/aidlux/playbook/100%.md')
    expect(parseFileRef('</abs/path/My Report.md:3>', CWD)).toEqual({
      path: '/abs/path/My Report.md',
      line: 3,
    })
  })

  it('handles a file:// link and a directory link', () => {
    expect(parseFileRef('file:///D:/code/x/a.md', CWD)?.path).toBe('D:/code/x/a.md')
    // Directories are readable links too — the viewer reports "not a file".
    expect(parseFileRef('performance-recovery-20261014/evidence/', CWD)?.path).toBe(
      'D:/code/aidlux/playbook/performance-recovery-20261014/evidence',
    )
  })

  it('leaves anything that is not a file to the browser', () => {
    for (const href of [
      'https://example.com/x.md',
      'http://127.0.0.1:3000/x',
      'mailto:someone@example.com',
      'app://{{connector_id}}',
      'context7:resolve-library-id',
      '#section',
      '//example.com/x.md',
      'example.com/docs',
    ]) {
      expect(parseFileRef(href, CWD)).toBeNull()
    }
  })

  it('does not mistake a bare filename for a hostname', () => {
    expect(parseFileRef('README.md', CWD)?.path).toBe('D:/code/aidlux/playbook/README.md')
    expect(parseFileRef('.ai/INDEX.md', CWD)?.path).toBe('D:/code/aidlux/playbook/.ai/INDEX.md')
  })

  it('needs a cwd for a relative link, but not for an absolute one', () => {
    expect(parseFileRef('rules/testing.md', '')).toBeNull()
    expect(parseFileRef('rules/testing.md', null)).toBeNull()
    expect(parseFileRef('/D:/code/x/a.md', null)?.path).toBe('D:/code/x/a.md')
  })

  it('rejects a link that resolves to nothing at all', () => {
    expect(parseFileRef('', CWD)).toBeNull()
    expect(parseFileRef('   ', CWD)).toBeNull()
    expect(parseFileRef('/', CWD)).toBeNull()
    expect(parseFileRef('D:/', CWD)).toBeNull()
  })
})
