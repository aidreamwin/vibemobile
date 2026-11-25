import type { ApprovalRequest, ServerMessage } from '@vibemobile/protocol'
import { create } from 'zustand'

/** Pending decisions belong to the runner connection and can arrive before Chat mounts. */
export const useApprovalStore = create<{ pending: ApprovalRequest[] }>(() => ({ pending: [] }))

export function receiveApprovals(message: ServerMessage) {
  const pending = useApprovalStore.getState().pending
  let next: ApprovalRequest[]
  if (message.type === 'hello') {
    // Keep an open form when possible. Older runners replay all requests after hello, too.
    next = pending.filter((request) => message.pendingApprovalIds?.includes(request.requestId))
  } else if (message.type === 'event') {
    const { event } = message
    switch (event.kind) {
      case 'approval.requested':
        if (pending.some((request) => request.requestId === event.approval.requestId)) return
        next = [...pending, event.approval]
        break
      case 'approval.resolved':
        next = pending.filter((request) => request.requestId !== event.requestId)
        break
      case 'turn.completed':
        if (event.status === 'inProgress') return
        next = pending.filter((request) => request.threadId !== event.threadId || request.turnId !== event.turnId)
        break
      default:
        return
    }
  } else return
  if (next.length !== pending.length) useApprovalStore.setState({ pending: next })
}
