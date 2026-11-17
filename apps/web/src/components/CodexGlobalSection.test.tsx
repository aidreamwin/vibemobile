import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import CodexGlobalSection from './CodexGlobalSection'

it('provides separate global rules, skills and memory entries with the runner scope visible', () => {
  const html = renderToStaticMarkup(<CodexGlobalSection />)
  expect(html).toContain('Codex 全局设置')
  expect(html).toContain('固定规则')
  expect(html).toContain('Skills')
  expect(html).toContain('记忆')
  expect(html).toContain('当前执行机')
  expect(html).toContain('浏览、编辑和新建全局技能')
})
