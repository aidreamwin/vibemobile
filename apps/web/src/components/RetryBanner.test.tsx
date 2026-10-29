import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { RetryBanner } from './RetryBanner'
import ItemCard from './ItemCard'

it('shows the retry count, delay and upstream reason, without implying completion', () => {
  const html = renderToStaticMarkup(
    <RetryBanner
      notice={{
        kind: 'error',
        message: '503 unavailable',
        willRetry: true,
        retryAttempt: 2,
        maxRetries: 10,
        retryInMs: 1200,
      }}
    />,
  )
  expect(html).toContain('正在自动重试（2/10）')
  expect(html).toContain('约 2 秒后再次尝试')
  expect(html).toContain('503 unavailable')
  expect(html).toContain('role="status"')
  expect(renderToStaticMarkup(<RetryBanner notice={null} />)).toBe('')
})

it('shows a final error as an accessible alert and escapes upstream HTML', () => {
  const html = renderToStaticMarkup(
    <ItemCard item={{ kind: 'error', id: 'failure', message: '500 <script>bad()</script>' }} />,
  )
  expect(html).toContain('role="alert"')
  expect(html).toContain('500 &lt;script&gt;')
  expect(html).not.toContain('<script>')
})

it('keeps historical retries visible after a turn has finished', () => {
  const html = renderToStaticMarkup(
    <ItemCard
      item={{
        kind: 'retry',
        id: 'history',
        attempts: [{ attempt: 1, maxRetries: 10, delayMs: 1200, message: '503 unavailable' }],
      }}
    />,
  )
  expect(html).toContain('自动重试记录（1 次）')
  expect(html).toContain('等待 2 秒')
  expect(html).toContain('503 unavailable')
})
