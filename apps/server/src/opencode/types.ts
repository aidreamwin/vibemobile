/**
 * The slice of opencode's v2 HTTP API this provider uses.
 *
 * Hand-written rather than generated: the API is explicitly experimental and
 * `packages/protocol/src/generated/` is already the home of a dead Codex
 * generator. Keeping only the fields the mapper reads makes a silent upstream
 * shape change show up as an ignored field (or a failing fixture) instead of a
 * type that lies.
 *
 * Every payload is treated as untrusted at the boundary: `client.ts` parses
 * JSON into `unknown`, and `mapEvents.ts` narrows it with the guards here.
 */

export type OpencodeResult = 'succeeded' | 'failed' | 'interrupted'

export interface OpencodeLocation {
  directory: string
}

export interface OpencodeModelRef {
  id: string
  providerID: string
  variant?: string
}

export interface OpencodeTokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface OpencodeSessionTime {
  created: number
  updated: number
  busy?: number
  idle?: number
  viewed?: number
  archived?: number
}

export type OpencodePermissionEffect = 'allow' | 'deny' | 'ask'

export interface OpencodePermissionRule {
  action: string
  resource: string
  effect: OpencodePermissionEffect
}

export interface OpencodeSessionInfo {
  id: string
  parentID?: string | null
  projectID: string
  agent?: string
  model?: OpencodeModelRef
  cost: number
  tokens: OpencodeTokenUsage
  outcome?: OpencodeResult
  time: OpencodeSessionTime
  title?: string
  subpath?: string
  metadata?: Record<string, unknown>
  permissions?: OpencodePermissionRule[]
  location: OpencodeLocation
}

export interface OpencodeSessionList {
  data: OpencodeSessionInfo[]
  cursor: { previous: string | null; next: string | null }
}

export interface OpencodeInboxUser {
  id: string
  sessionID: string
  time: { created: number }
  type: 'user'
  payload: { text: string; files?: OpencodeFileAttachment[]; metadata?: Record<string, unknown> }
  delivery: 'steer' | 'queue'
}

export interface OpencodeFileAttachment {
  uri?: string
  data?: string
  mime?: string
  name?: string
  description?: string
  source?: { type: 'inline' } | { type: 'uri'; uri: string }
}

export interface OpencodeToolTextContent {
  type: 'text'
  text: string
}

export interface OpencodeToolFileContent {
  type: 'file'
  uri: string
  mime: string
  name?: string | null
}

export type OpencodeToolContent = OpencodeToolTextContent | OpencodeToolFileContent

export type OpencodeToolState =
  | { status: 'streaming'; input: string }
  | { status: 'running'; input: Record<string, unknown>; metadata?: Record<string, unknown> }
  | {
      status: 'completed'
      input: Record<string, unknown>
      content: OpencodeToolContent[]
      metadata?: Record<string, unknown>
    }
  | {
      status: 'error'
      input: Record<string, unknown>
      error: OpencodeStructuredError
      content?: OpencodeToolContent[]
      metadata?: Record<string, unknown>
    }

export interface OpencodeStructuredError {
  type: string
  message: string
  status?: number
  response?: { body: string }
  retryAfterMs?: number
}

export interface OpencodeMessageBase {
  id: string
  time: { created: number; streamed?: number; completed?: number }
  metadata?: Record<string, unknown>
}

export interface OpencodeUserMessage extends OpencodeMessageBase {
  type: 'user'
  text: string
  files?: OpencodeFileAttachment[]
  agents?: { name: string }[]
  skills?: { id: string; name?: string }[]
}

export interface OpencodeTextPart {
  type: 'text'
  text: string
}

export interface OpencodeReasoningPart {
  type: 'reasoning'
  text: string
}

export interface OpencodeToolPart {
  type: 'tool'
  id: string
  name: string
  executed?: boolean
  state: OpencodeToolState
  time: { created: number; ran?: number; completed?: number }
}

export type OpencodeAssistantPart = OpencodeTextPart | OpencodeReasoningPart | OpencodeToolPart

export interface OpencodeAssistantMessage extends OpencodeMessageBase {
  type: 'assistant'
  agent: string
  model: OpencodeModelRef
  content: OpencodeAssistantPart[]
  finish?: string
  rawFinish?: string
  cost?: number
  tokens?: OpencodeTokenUsage
  error?: OpencodeStructuredError
  retry?: { attempt: number; at: number; error: OpencodeStructuredError }
}

export interface OpencodeIdleMessage extends OpencodeMessageBase {
  type: 'idle'
  outcome: OpencodeResult
  error?: OpencodeStructuredError
}

export interface OpencodeShellMessage extends OpencodeMessageBase {
  type: 'shell'
  shellID: string
  command: string
  status: 'running' | 'exited' | 'timeout' | 'killed'
  exit?: number
  output?: { output: string; cursor: number; size: number; truncated: boolean }
}

export interface OpencodeCompactionMessage extends OpencodeMessageBase {
  type: 'compaction'
  status: 'running' | 'completed' | 'failed'
  reason: 'auto' | 'manual'
  summary?: string
  error?: OpencodeStructuredError
  tokens?: OpencodeTokenUsage
  cost?: number
}

export interface OpencodeOtherMessage extends OpencodeMessageBase {
  type: 'system' | 'synthetic' | 'skill' | 'agent-switched' | 'model-switched' | 'location-switched'
  [key: string]: unknown
}

export type OpencodeMessage =
  | OpencodeUserMessage
  | OpencodeAssistantMessage
  | OpencodeIdleMessage
  | OpencodeShellMessage
  | OpencodeCompactionMessage
  | OpencodeOtherMessage

export interface OpencodeMessageList {
  data: OpencodeMessage[]
  cursor: { previous: string | null; next: string | null }
}

export interface OpencodePermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: { type: 'tool'; messageID: string; id: string }
  message?: string
}

export interface OpencodeFormOption {
  value?: string
  label: string
  description?: string
}

export type OpencodeFormField =
  | {
      key: string
      title?: string
      description?: string
      required?: boolean
      hidden?: boolean
      type: 'string'
      format?: string
      options?: OpencodeFormOption[]
      custom?: boolean
      default?: string
      placeholder?: string
    }
  | {
      key: string
      title?: string
      description?: string
      required?: boolean
      hidden?: boolean
      type: 'number' | 'integer'
      default?: number
    }
  | {
      key: string
      title?: string
      description?: string
      required?: boolean
      hidden?: boolean
      type: 'boolean'
      default?: boolean
    }
  | {
      key: string
      title?: string
      description?: string
      required?: boolean
      hidden?: boolean
      type: 'multiselect'
      options: OpencodeFormOption[]
      minItems?: number
      maxItems?: number
      custom?: boolean
      default?: string[]
    }
  | {
      key: string
      title?: string
      description?: string
      required?: boolean
      hidden?: boolean
      type: 'external'
      url: string
    }

export interface OpencodeForm {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: OpencodeFormField[]
}

export interface OpencodeModelVariant {
  id: string
}

export interface OpencodeModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  type?: string
  enabled?: boolean
  variants?: OpencodeModelVariant[]
  capabilities?: { input?: string[]; output?: string[]; tools?: boolean }
  limit: { context: number; input?: number; output: number }
}

export interface OpencodeProjectInfo {
  id: string
  canonical: string
  name?: string
  vcs?: string
  time: { created: number; updated: number; active?: number }
}

export interface OpencodeInfo {
  version: string
  pid: number
  hostname?: string
  urls?: string[]
  capabilities?: Record<string, unknown>
}

export interface OpencodeAgentInfo {
  id: string
  name: string
  mode: string
  hidden?: boolean
  permissions?: OpencodePermissionRule[]
}

export interface OpencodeEventFrame {
  id: string
  created: number
  type: string
  data: Record<string, unknown>
  location?: OpencodeLocation
}

/** A successful JSON response, as returned by most v2 routes. */
export interface OpencodeData<T> {
  data: T
}

// ------------------------------------------------------------------ guards

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

export function asEventFrame(value: unknown): OpencodeEventFrame | null {
  const record = asRecord(value)
  if (!record) return null
  const id = asString(record.id)
  const type = asString(record.type)
  const created = asNumber(record.created)
  const data = asRecord(record.data)
  if (!id || !type || created === null || !data) return null
  return { id, type, created, data, location: asLocation(record.location) ?? undefined }
}

export function asLocation(value: unknown): OpencodeLocation | null {
  const record = asRecord(value)
  const directory = record ? asString(record.directory) : null
  return directory ? { directory } : null
}

export function asTokenUsage(value: unknown): OpencodeTokenUsage | null {
  const record = asRecord(value)
  if (!record) return null
  const cache = asRecord(record.cache)
  const input = asNumber(record.input)
  const output = asNumber(record.output)
  const reasoning = asNumber(record.reasoning)
  const read = asNumber(cache?.read)
  const write = asNumber(cache?.write)
  if (input === null || output === null || reasoning === null || read === null || write === null) return null
  return { input, output, reasoning, cache: { read, write } }
}

export function asStructuredError(value: unknown): OpencodeStructuredError | null {
  const record = asRecord(value)
  if (!record) return null
  const type = asString(record.type)
  const message = asString(record.message)
  if (type === null || message === null) return null
  const status = asNumber(record.status)
  return { type, message, ...(status === null ? {} : { status }) }
}

export function asModelRef(value: unknown): OpencodeModelRef | null {
  const record = asRecord(value)
  if (!record) return null
  const id = asString(record.id)
  const providerID = asString(record.providerID)
  if (!id || !providerID) return null
  const variant = asString(record.variant)
  return { id, providerID, ...(variant ? { variant } : {}) }
}
