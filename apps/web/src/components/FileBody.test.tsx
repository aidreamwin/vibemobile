import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FileContent } from '@vibemobile/protocol'
import FileBody, { isRenderable } from './FileBody'

/**
 * Rendered through `renderToStaticMarkup`, so the `useEffect` that scrolls to
 * the linked line does not run — what is asserted here is the markup, which is
 * where the line numbers, the cap and the mode switch live. The scrolling side
 * was checked in a browser.
 */
function file(text: string, extra: Partial<FileContent> = {}): FileContent {
  return { path: '', text, bytes: text.length, truncated: false, ...extra } as FileContent
}

const rows = (html: string) => html.split('class="w-11').length - 1

describe('the rendered form of a file', () => {
  it('numbers every line, and marks the one a link pointed at', () => {
    const html = renderToStaticMarkup(<FileBody content={file('a\nbb\nccc')} path="D:/x/a.ts" line={2} />)
    expect(rows(html)).toBe(3)
    expect(html).toContain('>1</span>')
    expect(html).toContain('>3</span>')
    expect(html).toContain('bg-warning/20')
  })

  it('stops at MAX_ROWS and says how many lines it left out', () => {
    const html = renderToStaticMarkup(<FileBody content={file('x\n'.repeat(6000))} path="D:/x/big.ts" />)
    expect(rows(html)).toBe(5000)
    expect(html).toContain('仅显示前 5000 行（共 6001 行）')
  })

  it('keeps an empty line from collapsing', () => {
    const html = renderToStaticMarkup(<FileBody content={file('a\n\nb')} path="D:/x/a.ts" />)
    expect(rows(html)).toBe(3)
    expect(html).toContain('> </span>')
  })

  it('renders a document only when asked, and only when it is one', () => {
    const md = file('# 标题\n\n正文')
    const rendered = renderToStaticMarkup(<FileBody content={md} path="D:/x/a.md" preview />)
    expect(rendered).toContain('<h1>标题</h1>')
    expect(rows(rendered)).toBe(0)

    const source = renderToStaticMarkup(<FileBody content={md} path="D:/x/a.md" />)
    expect(source).not.toContain('<h1>')
    expect(rows(source)).toBe(3)

    // Preview asked for, but a `.ts` is not a document.
    const code = renderToStaticMarkup(<FileBody content={file('# not a title')} path="D:/x/a.ts" preview />)
    expect(code).not.toContain('<h1>')
    expect(rows(code)).toBe(1)
  })

  it('knows which files have a rendered form', () => {
    expect(isRenderable('D:/x/README.md')).toBe(true)
    expect(isRenderable('D:/x/notes.MARKDOWN')).toBe(true)
    expect(isRenderable('D:/x/diagram.SVG')).toBe(true)
    expect(isRenderable('D:/x/Page.tsx')).toBe(false)
    expect(isRenderable('D:/x/md')).toBe(false)
  })

  it('renders SVG in an isolated image context and preserves its source view', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const rendered = renderToStaticMarkup(<FileBody content={file(svg)} path="D:/x/diagram.svg" preview />)
    expect(rendered).toContain('<img')
    expect(rendered).toContain(`data:image/svg+xml,${encodeURIComponent(svg)}`)
    expect(rendered).not.toContain('<script>')

    const source = renderToStaticMarkup(<FileBody content={file(svg)} path="D:/x/diagram.svg" />)
    expect(source).not.toContain('<img')
    expect(source).toContain('>svg</span>')
    expect(source).not.toContain('<svg')

    const truncated = renderToStaticMarkup(
      <FileBody content={file(svg, { truncated: true })} path="D:/x/diagram.svg" preview />,
    )
    expect(truncated).not.toContain('<img')
    expect(truncated).toContain('文件较大')
  })

  it.each([
    ['settings.JSON', '{"name": "demo"}', 'hljs-attr'],
    ['script.py', 'def greet():\n    return "hi"', 'hljs-keyword'],
    ['main.c', '#include <stdio.h>', 'hljs-meta'],
    ['main.cpp', 'namespace demo {}', 'hljs-keyword'],
    ['app.js', 'const text = "hello"', 'hljs-keyword'],
  ])('highlights source in %s using its file extension', (name, source, tokenClass) => {
    const html = renderToStaticMarkup(<FileBody content={file(source)} path={`D:/x/${name}`} />)
    expect(html).toContain(tokenClass)
  })

  it('highlights both pieces of a multiline comment and keeps CRLF line targets', () => {
    const source = '/* first line\r\nstill a comment */\r\n\r\nconst value = 3'
    const html = renderToStaticMarkup(<FileBody content={file(source)} path="D:/x/app.js" line={2} />)
    expect(rows(html)).toBe(4)
    expect(html).toMatch(/class="[^"]*\bhljs-comment\b[^"]*">\/\* first line/)
    expect(html).toMatch(/class="[^"]*\bhljs-comment\b[^"]*">still a comment \*\//)
    expect(html).toContain('bg-warning/20')
    expect(html).not.toContain('\r')
  })

  it('escapes code containing HTML and uses plain source for unknown extensions', () => {
    const source = 'const text = "<em>literal</em>"'
    const highlighted = renderToStaticMarkup(<FileBody content={file(source)} path="D:/x/app.js" />)
    const plain = renderToStaticMarkup(<FileBody content={file(source)} path="D:/x/app.custom" />)
    expect(highlighted).toContain('hljs-string')
    expect(highlighted).not.toContain('<em>literal</em>')
    expect(highlighted).toContain('&lt;em&gt;literal&lt;/em&gt;')
    expect(plain).not.toContain('hljs-')
    expect(plain).toContain('&lt;em&gt;literal&lt;/em&gt;')
  })

  it('carries the server\u2019s truncation notice through', () => {
    const html = renderToStaticMarkup(
      <FileBody content={file('abc', { truncated: true, bytes: 4096 })} path="D:/x/a.ts" />,
    )
    expect(html).toContain('文件较大，仅显示前 0 KB（共 4 KB）')
  })
})
