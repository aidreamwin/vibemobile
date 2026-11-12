import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from './frontmatter'

describe('splitFrontmatter', () => {
  it('splits scalars, lists and the body', () => {
    const doc = splitFrontmatter('---\nname: demo\ntags:\n  - a\n  - b\n---\n# 标题\n\n正文')
    expect(doc?.meta).toEqual([
      { key: 'name', value: 'demo' },
      { key: 'tags', value: ['a', 'b'] },
    ])
    expect(doc?.body).toBe('# 标题\n\n正文')
  })

  it('accepts CRLF, a BOM and the `...` closing fence', () => {
    const doc = splitFrontmatter('﻿---\r\ntitle: 测试\r\n...\r\n正文')
    expect(doc?.meta).toEqual([{ key: 'title', value: '测试' }])
    expect(doc?.body).toBe('正文')
  })

  it('keeps a block scalar as one value', () => {
    const doc = splitFrontmatter('---\ndescription: |\n  第一行\n  第二行\nkey: v\n---\nbody')
    expect(doc?.meta).toEqual([
      { key: 'description', value: '第一行\n第二行\n' },
      { key: 'key', value: 'v' },
    ])
  })

  it('keeps quoted and Unicode keys before and after plain keys', () => {
    const doc = splitFrontmatter('---\n"title": "Hello"\nname: demo\n标题: 示例\n---\n# Body')
    expect(doc?.meta).toEqual([
      { key: 'title', value: 'Hello' },
      { key: 'name', value: 'demo' },
      { key: '标题', value: '示例' },
    ])
    expect(splitFrontmatter('---\n"title": "Hello"\n---\nbody')?.meta).toEqual([{ key: 'title', value: 'Hello' }])
  })

  it('preserves the structure of nested YAML and resolves flat flow lists', () => {
    const doc = splitFrontmatter('---\nconfig:\n  owner: demo\n  enabled: true\ntags: [a, b]\n---\nbody')
    expect(doc?.meta).toEqual([
      { key: 'config', value: 'owner: demo\nenabled: true' },
      { key: 'tags', value: ['a', 'b'] },
    ])
  })

  it('shows invalid mappings verbatim instead of keeping only valid fields', () => {
    for (const raw of ['"title: Hello\nname: demo', 'name: demo\ntags: [a, b', 'name: first\nname: second']) {
      expect(splitFrontmatter(`---\n${raw}\n---\n# Body`)).toEqual({ meta: null, raw, body: '# Body' })
    }
  })

  it('keeps aliases as source without expanding them', () => {
    const doc = splitFrontmatter('---\nbase: &base [a, b]\ncopy: *base\n---\nbody')
    expect(doc?.meta).toEqual([
      { key: 'base', value: ['a', 'b'] },
      { key: 'copy', value: '*base' },
    ])
  })

  it('preserves headers with complex keys verbatim', () => {
    const raw = '? [first, second]\n: value\nname: demo'
    expect(splitFrontmatter(`---\n${raw}\n---\nbody`)).toEqual({ meta: null, raw, body: 'body' })
  })

  it('returns null for an unterminated opening fence', () => {
    expect(splitFrontmatter('---\njust text')).toBeNull()
    expect(splitFrontmatter('# 没有头')).toBeNull()
  })

  it('does not eat a document that only looks like one', () => {
    // A `---` rule around prose has no `key: value`, so nothing parses and the
    // text must survive intact.
    const text = '---\n一段说明\n---\n正文'
    expect(splitFrontmatter(text)).toBeNull()
  })

  it('does not treat `----` or an embedded fence as the opener', () => {
    expect(splitFrontmatter('----\na: b\n----')).toBeNull()
    expect(splitFrontmatter('\n---\na: b\n---')).toBeNull()
  })
})
