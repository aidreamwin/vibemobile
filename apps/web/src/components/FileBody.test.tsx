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
    expect(isRenderable('D:/x/Page.tsx')).toBe(false)
    expect(isRenderable('D:/x/md')).toBe(false)
  })

  it('carries the server\u2019s truncation notice through', () => {
    const html = renderToStaticMarkup(
      <FileBody content={file('abc', { truncated: true, bytes: 4096 })} path="D:/x/a.ts" />,
    )
    expect(html).toContain('文件较大，仅显示前 0 KB（共 4 KB）')
  })
})
