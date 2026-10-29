import type { AgentItem } from '@vibemobile/protocol'

/** SDK stream-json uses api_retry/snake_case; persisted JSONL uses api_error/camelCase. */
export function retryDetails(msg: any): Extract<AgentItem, { kind: 'retry' }>['attempts'][number] | null {
  if (msg?.type !== 'system' || !['api_error', 'api_retry'].includes(msg.subtype)) return null
  const status = msg.error_status
  return {
    attempt: msg.attempt ?? msg.retryAttempt,
    maxRetries: msg.max_retries ?? msg.maxRetries,
    delayMs: msg.retry_delay_ms ?? msg.retryInMs,
    message:
      typeof msg.error === 'string'
        ? `${status ? `HTTP ${status} · ` : ''}${msg.error}`
        : String(msg.error?.formatted ?? msg.error?.message ?? 'API request failed'),
    ...(typeof msg.timestamp === 'string' ? { at: msg.timestamp } : {}),
  }
}
