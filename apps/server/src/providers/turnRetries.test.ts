import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { TurnRetryStore } from './turnRetries.js'

it('restores Codex retry diagnostics across restart without modifying agent transcripts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-retries-'))
  const file = path.join(dir, 'retries.json')
  try {
    const store = new TurnRetryStore(file)
    store.add({ kind: 'error', threadId: 'thread', turnId: 'turn', message: '503', willRetry: true })
    store.add({ kind: 'error', threadId: 'other', turnId: 'turn', message: '500', willRetry: true })
    const restored = new TurnRetryStore(file)
    expect(restored.get('thread', 'turn')?.attempts.map((a) => a.message)).toEqual(['503'])
    expect(restored.get('other', 'turn')?.attempts.map((a) => a.message)).toEqual(['500'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
it('bounds repeated failures and tolerates an invalid diagnostics file', () => {
  const store = new TurnRetryStore()
  for (let i = 0; i < 105; i++) store.add({ kind: 'error', threadId: 'thread', turnId: 'turn', message: String(i) })
  expect(store.get('thread', 'turn')?.attempts).toHaveLength(100)
  expect(store.get('thread', 'turn')?.attempts[0].message).toBe('5')
})
