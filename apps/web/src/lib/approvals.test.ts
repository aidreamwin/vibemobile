import type { AgentEvent, ApprovalRequest } from '@vibemobile/protocol'
import { beforeEach, expect, it } from 'vitest'
import { receiveApprovals, useApprovalStore } from './approvals'
import { loadTranscript, resyncTranscript, useChatStore } from './store'

const request = (id: string, threadId = 'agy:phone'): ApprovalRequest => ({
  threadId,
  turnId: 'turn',
  requestId: id,
  itemId: 'tool',
  type: 'command',
  title: 'echo hello',
  availableDecisions: ['accept', 'decline'],
})
const event = (event: AgentEvent) => receiveApprovals({ type: 'event', event })
const pending = () => useApprovalStore.getState().pending
beforeEach(() => useApprovalStore.setState({ pending: [] }))

it('restores a replay received on the list page, survives transcript loading, and resolves on all devices', () => {
  const approval = request('a')
  receiveApprovals({ type: 'hello', subscribed: [], pendingApprovalIds: ['a'] })
  event({ kind: 'approval.requested', approval })
  useChatStore.getState().reset(approval.threadId)
  loadTranscript(approval.threadId, [])
  resyncTranscript(approval.threadId, [])
  event({ kind: 'approval.requested', approval })
  expect(pending()).toEqual([approval])

  event({ kind: 'approval.resolved', threadId: approval.threadId, requestId: 'a' })
  expect(pending()).toEqual([])
})

it('reconciles decisions made while offline and retains the same still-pending form on replay', () => {
  const active = request('active')
  event({ kind: 'approval.requested', approval: active })
  event({ kind: 'approval.requested', approval: request('answered') })
  receiveApprovals({ type: 'hello', subscribed: [], pendingApprovalIds: [active.requestId] })
  event({ kind: 'approval.requested', approval: { ...active } })
  expect(pending()).toEqual([active])
  expect(pending()[0]).toBe(active)
  receiveApprovals({ type: 'hello', subscribed: [] }) // Older runner, full replay follows.
  event({ kind: 'approval.requested', approval: active })
  expect(pending()).toEqual([active])
})

it('prunes only the completed turn in its own session', () => {
  const first = request('a')
  const other = request('b', 'opencode:other')
  for (const approval of [first, other]) event({ kind: 'approval.requested', approval })
  const turn = { kind: 'turn.completed', threadId: first.threadId, turnId: first.turnId } as const
  event({ ...turn, status: 'inProgress' })
  expect(pending()).toEqual([first, other])
  event({ ...turn, status: 'completed' })
  expect(pending()).toEqual([other])
})
