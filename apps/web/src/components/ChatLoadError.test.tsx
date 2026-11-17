import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import ChatLoadError from './ChatLoadError'
import Composer from './Composer'

const noop = () => {}
const message = '此会话的 provider key 与当前配置不同，可查看历史，或创建副本后使用当前配置继续对话。'

it('offers a copy for provider mismatch without describing a desktop writer lock', () => {
  const html = renderToStaticMarkup(
    <ChatLoadError
      loadError={message}
      sessionInUse={false}
      providerMismatch
      forking={false}
      forkError={null}
      onFork={noop}
      onRetry={noop}
      onBack={noop}
    />,
  )
  expect(html).toContain(message)
  expect(html).toContain('创建副本继续')
  expect(html).not.toContain('电脑端')
  expect(html).not.toContain('两个客户端')
})

it('keeps desktop lock guidance and does not offer copying for unrelated failures', () => {
  const props = { loadError: 'offline', forking: false, forkError: null, onFork: noop, onRetry: noop, onBack: noop }
  expect(renderToStaticMarkup(<ChatLoadError {...props} sessionInUse />)).toContain('会话正在电脑端使用')
  expect(renderToStaticMarkup(<ChatLoadError {...props} sessionInUse={false} />)).not.toContain('创建副本继续')
})

it('shows history-only guidance and a labeled copy action instead of an input', () => {
  const html = renderToStaticMarkup(
    <Composer
      onSend={noop}
      onStop={noop}
      running={false}
      models={[]}
      model=""
      effort=""
      onModelChange={noop}
      onEffortChange={noop}
      permission="ask"
      onPermissionChange={noop}
      cards={[]}
      commands={[]}
      readOnly={{ message, forking: false, error: null, onFork: noop, onRetry: noop }}
    />,
  )
  expect(html).toContain(message)
  expect(html).toContain('创建副本继续')
  expect(html).not.toContain('<textarea')
  expect(html).not.toContain('电脑端')
})
