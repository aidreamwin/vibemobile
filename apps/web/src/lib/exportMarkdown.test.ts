import { describe, expect, it } from 'vitest'
import type { AgentItem, SessionSummary, TranscriptTurn } from '@vibemobile/protocol'
import { conversationText, markdownFilename, sessionMarkdown, turnMarkdown } from './exportMarkdown'

const session: SessionSummary = {
  id: 'session-1',
  provider: 'claude',
  title: '测试 会话',
  preview: '',
  cwd: 'D:\\projects\\demo',
  status: 'idle',
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: Date.UTC(2026, 0, 2),
  needsAttention: false,
}

const user: AgentItem = { kind: 'message', id: 'u1', role: 'user', text: '修一下构建' }
const assistant: AgentItem = { kind: 'message', id: 'a1', role: 'assistant', text: '好的。' }
const command: AgentItem = {
  kind: 'command',
  id: 'c1',
  command: 'npm test',
  status: 'done',
  output: 'all green',
  exitCode: 0,
}
const change: AgentItem = {
  kind: 'fileChange',
  id: 'f1',
  status: 'done',
  changes: [{ path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }],
}

const turns: TranscriptTurn[] = [
  { id: 't1', status: 'completed', items: [user, assistant, command] },
  { id: 't2', status: 'completed', items: [change] },
]

describe('Markdown export', () => {
  it('renders a session header, every turn, and the item bodies', () => {
    const text = sessionMarkdown(session, turns)
    expect(text).toContain('# 测试 会话')
    expect(text).toContain('- 代理：Claude Code')
    expect(text).toContain('- 会话 ID：`session-1`')
    expect(text).toContain('## 第 1 轮')
    expect(text).toContain('## 第 2 轮')
    expect(text).toContain('**用户**')
    expect(text).toContain('修一下构建')
    expect(text).toContain('```sh\nnpm test\n```')
    expect(text).toContain('all green')
    expect(text).toContain('```diff')
  })

  it('uses a longer fence when the content itself contains backticks', () => {
    const tricky: AgentItem = { kind: 'command', id: 'c2', command: 'echo ```', status: 'done', output: '' }
    const text = sessionMarkdown(session, [{ id: 't', status: 'completed', items: [tricky] }])
    expect(text).toContain('````sh\necho ```\n````')
  })

  it('exports a running turn using the stream buffer and its label', () => {
    const streaming: AgentItem = { kind: 'message', id: 'live', role: 'assistant', text: '' }
    const text = turnMarkdown(session, [streaming], '修一下构建', {
      live: { text: '正在处理…', channel: 'text' },
    })
    expect(text).toContain('# 测试 会话 · 修一下构建')
    expect(text).toContain('正在处理…')
  })

  it('can export only the dialogue of a session or a turn', () => {
    const conversation = sessionMarkdown(session, turns, 'conversation')
    expect(conversation).toContain('修一下构建')
    expect(conversation).toContain('好的。')
    expect(conversation).not.toContain('npm test')
    expect(conversation).not.toContain('```diff')

    const reasoning: AgentItem = { kind: 'reasoning', id: 'r1', summary: ['内部推理'], content: [] }
    const turn = turnMarkdown(session, [user, reasoning, assistant], '本轮', {}, 'conversation')
    expect(turn).toContain('修一下构建')
    expect(turn).not.toContain('内部推理')
  })

  it('copies only the dialogue, not reasoning or tool calls', () => {
    const reasoning: AgentItem = { kind: 'reasoning', id: 'r1', summary: ['内部推理'], content: [] }
    const text = conversationText([user, reasoning, assistant, command, change])
    expect(text).toContain('**用户**\n\n修一下构建')
    expect(text).toContain('**助手**\n\n好的。')
    expect(text).not.toContain('内部推理')
    expect(text).not.toContain('npm test')
    expect(text).not.toContain('@@ -1')
  })

  it('includes streamed assistant text while a turn is running', () => {
    const live: AgentItem = { kind: 'message', id: 'live', role: 'assistant', text: '' }
    expect(conversationText([live], { live: { text: '生成中', channel: 'text' } })).toBe('**助手**\n\n生成中\n')
  })

  it('builds a filesystem-safe filename', () => {
    expect(markdownFilename('a/b:c*d?', 'turn')).toMatch(/^a b c d-turn-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/)
    expect(markdownFilename('', 'turn')).toMatch(/^session-turn-/)
  })
})
