import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from './Markdown'

/**
 * These render through the real react-markdown rather than asserting on the
 * link handler alone: its `urlTransform` decides whether a destination reaches
 * the renderer at all, and it is what silently emptied `D:/…` links
 * (`href=""` — no colon before the first slash is a protocol to it) before
 * this component overrode it.
 *
 * An intercepted link is recognised by what it does NOT have: `target="_blank"`
 * is only on the branch that hands the click back to the browser.
 */
const CWD = 'D:\\code\\aidlux\\playbook'

function render(text: string): string {
  return renderToStaticMarkup(<Markdown text={text} cwd={CWD} onOpenFile={() => {}} />)
}

describe('markdown links', () => {
  it('keeps a file reference in the app, href and all', () => {
    const html = render('见 [测试规范](/D:/code/aidlux/playbook/.ai/rules/testing.md:10)')
    expect(html).not.toContain('target="_blank"')
    expect(html).toContain('href="/D:/code/aidlux/playbook/.ai/rules/testing.md:10"')
  })

  it('keeps a schemeless drive path that react-markdown would have blanked', () => {
    const html = render('[CURRENT.md](D:/code/aidlux/playbook/CURRENT.md)')
    expect(html).not.toContain('target="_blank"')
    expect(html).toContain('href="D:/code/aidlux/playbook/CURRENT.md"')
  })

  it('keeps a relative reference in the app', () => {
    const html = render('[testing.md](rules/testing.md)')
    expect(html).not.toContain('target="_blank"')
    expect(html).toContain('href="rules/testing.md"')
  })

  it('still opens a real link in a new tab, and still drops a javascript: one', () => {
    expect(render('[官网](https://example.com/x)')).toContain('target="_blank"')
    const script = render('[点我](javascript:alert(1))')
    expect(script).not.toContain('javascript:')
    expect(script).toContain('target="_blank"')
  })

  it('leaves a schemeless web link alone', () => {
    expect(render('[docs](example.com/docs)')).toContain('target="_blank"')
  })
})
