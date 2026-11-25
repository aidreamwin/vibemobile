import { randomUUID } from 'node:crypto'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { AgentEvent, ApprovalDecision } from '@vibemobile/protocol'
import { UnknownApprovalError } from '../providers/types.js'
import { toolItemId } from './transcript.js'

const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }

export class AgyApprovals {
  #pending = new Map<
    string,
    {
      threadId: string
      choices: Map<ApprovalDecision, string>
      settle: (result: RequestPermissionResponse) => void
      cancelTurn: () => Promise<void>
    }
  >()

  constructor(
    private emit: (event: AgentEvent) => void,
    private status: (threadId: string) => void,
  ) {}

  has(threadId: string) {
    return [...this.#pending.values()].some((request) => request.threadId === threadId)
  }

  request(
    threadId: string,
    turnId: string,
    params: RequestPermissionRequest,
    signal: AbortSignal,
    cancelTurn: () => Promise<void>,
  ) {
    if (signal.aborted) return Promise.resolve(cancelled)
    const choices = new Map<ApprovalDecision, string>()
    for (const option of params.options) {
      // ACP's persistent allow rule may outlive this session. Only expose one-time decisions.
      if (option.kind === 'allow_once') choices.set('accept', option.optionId)
      if (option.kind === 'reject_once') choices.set('decline', option.optionId)
    }
    const requestId = `agy:${randomUUID()}`
    const tool = params.toolCall
    return new Promise<RequestPermissionResponse>((resolve) => {
      const abort = () => settle(cancelled)
      const settle = (result: RequestPermissionResponse) => {
        if (!this.#pending.delete(requestId)) return
        signal.removeEventListener('abort', abort)
        resolve(result)
        this.emit({ kind: 'approval.resolved', threadId, requestId })
        this.status(threadId)
      }
      this.#pending.set(requestId, { threadId, choices, settle, cancelTurn })
      signal.addEventListener('abort', abort, { once: true })
      this.emit({
        kind: 'approval.requested',
        approval: {
          threadId,
          turnId,
          requestId,
          itemId: toolItemId(turnId, tool.toolCallId),
          type: tool.kind === 'execute' ? 'command' : tool.kind === 'edit' ? 'fileChange' : 'permissions',
          title: tool.title ?? tool.name ?? 'Antigravity',
          detail: tool.rawInput == null ? undefined : JSON.stringify(tool.rawInput),
          availableDecisions: [...choices.keys(), 'cancel'],
        },
      })
      this.status(threadId)
    })
  }

  async answer(requestId: string, decision: ApprovalDecision) {
    const request = this.#pending.get(requestId)
    if (!request) throw new UnknownApprovalError(requestId)
    if (decision === 'cancel') {
      await request.cancelTurn()
      request.settle(cancelled)
      return
    }
    const optionId = request.choices.get(decision)
    if (!optionId) throw new Error('Antigravity 未提供此审批选项。')
    request.settle({ outcome: { outcome: 'selected', optionId } })
  }

  clear(threadId: string) {
    for (const request of this.#pending.values()) {
      if (request.threadId === threadId) request.settle(cancelled)
    }
  }
}
