import { expect, it } from 'vitest'
import { collapseUnansweredRetries, retryInput } from './retry'
import type { AgentItem } from '@vibemobile/protocol'

const prompt: AgentItem = { kind: 'message', id: 'u1', role: 'user', text: 'task' }
const failure: AgentItem = { kind: 'error', id: 'e1', message: '500' }
const repeated: AgentItem = { ...prompt, id: 'u2' }
it('reuses one bubble across unanswered failed attempts and keeps failure diagnostics', () => {
  const items = [prompt, failure, repeated, { ...failure, id: 'e2' }, { ...repeated, id: 'u3' }]
  expect(collapseUnansweredRetries(items).map((i) => i.id)).toEqual(['u1', 'e1', 'e2'])
})
it('keeps a repeated prompt after a real or streamed reply', () => {
  const reply: AgentItem = { kind: 'message', id: 'a', role: 'assistant', text: 'partial reply' }
  expect(collapseUnansweredRetries([prompt, reply, failure, repeated])).toHaveLength(4)
  expect(
    collapseUnansweredRetries([prompt, { ...reply, text: '' }, failure, repeated], { a: { text: 'partial' } }),
  ).toHaveLength(4)
})
it('keeps changed text or images, and repeated prompts without a failure', () => {
  expect(collapseUnansweredRetries([prompt, repeated])).toHaveLength(2)
  expect(collapseUnansweredRetries([prompt, failure, { ...repeated, text: 'changed' }])).toHaveLength(3)
  expect(collapseUnansweredRetries([prompt, failure, { ...repeated, images: ['new.png'] }])).toHaveLength(3)
})

it('retries the user text and restores image bytes rather than sending store tokens', async () => {
  expect(
    await retryInput(
      { kind: 'message', id: 'u', role: 'user', text: 'task', images: ['token.png'] },
      async () => 'data:image/png;base64,a',
    ),
  ).toEqual([
    { type: 'image', url: 'data:image/png;base64,a' },
    { type: 'text', text: 'task' },
  ])
})
it('does not silently retry a partial prompt when an attachment cannot be read', async () => {
  await expect(
    retryInput({ kind: 'message', id: 'u', role: 'user', text: 'task', images: ['missing.png'] }, async () => {
      throw new Error('missing')
    }),
  ).rejects.toThrow('missing')
})
it('rejects assistant and error messages', async () => {
  await expect(retryInput({ kind: 'error', id: 'e', message: '500' }, async () => '')).rejects.toThrow()
  await expect(
    retryInput({ kind: 'message', id: 'a', role: 'assistant', text: 'reply' }, async () => ''),
  ).rejects.toThrow()
})
