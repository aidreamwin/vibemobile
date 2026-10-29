import type { AgentInput, AgentItem } from '@vibemobile/protocol'

/** Keep one prompt bubble across failed attempts that produced no reply or work. */
export function collapseUnansweredRetries(
  items: AgentItem[],
  streams: Readonly<Record<string, { text: string }>> = {},
): AgentItem[] {
  let prompt: Extract<AgentItem, { kind: 'message' }> | undefined
  let failed = false
  let answered = false
  return items.filter((item) => {
    if (item.kind === 'message' && item.role === 'user') {
      const reuse =
        prompt &&
        failed &&
        !answered &&
        item.text === prompt.text &&
        JSON.stringify(item.images ?? []) === JSON.stringify(prompt.images ?? [])
      prompt = item
      failed = false
      answered = false
      return !reuse
    }
    if (item.kind === 'error') failed = true
    else if (item.kind !== 'retry') {
      if (item.kind !== 'message' || item.text.trim() || streams[item.id]?.text.trim() || item.images?.length)
        answered = true
    }
    return true
  })
}

/** Rebuild only an explicit user message; never send the error text or an assistant reply. */
export async function retryInput(
  message: AgentItem,
  loadImage: (token: string) => Promise<string>,
): Promise<AgentInput[]> {
  if (message.kind !== 'message' || message.role !== 'user') throw new Error('没有可重试的用户指令。')
  const input: AgentInput[] = []
  for (const token of message.images ?? []) input.push({ type: 'image', url: await loadImage(token) })
  if (message.text.trim()) input.push({ type: 'text', text: message.text })
  if (!input.length) throw new Error('上一条指令为空，无法重试。')
  return input
}
