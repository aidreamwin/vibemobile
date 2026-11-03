/**
 * opencode's permission model, reduced to the two cards this app offers.
 *
 * There is no OS sandbox on the other side: the `plan` agent still allows
 * `shell`, and the default `build` agent allows every tool except `.env` reads.
 * So a "read-only" card here would be a promise the backend cannot keep. The
 * two honest cards are:
 *
 *   按需确认   session ruleset `* /* -> ask`
 *   完全放行   session ruleset `* /* -> allow`
 *
 * The wire still carries the old Codex pair, because `SessionSummary` and the
 * composer only have `(sandbox, approvalPolicy)`. For opencode those are a
 * single opaque token, not two independent settings; both functions below are
 * the only place that translation lives.
 *
 * Pure functions, no HTTP: the provider decides when to PATCH, this decides
 * what the PATCH says and how an answer maps back.
 */
import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalQuestion,
  ApprovalRequest,
  SandboxMode,
} from '@vibemobile/protocol'
import type { OpencodeForm, OpencodeFormField, OpencodePermissionRequest } from './types.js'

export type OpencodeCard = 'ask' | 'unattended'

export const OPENCODE_CARDS: readonly OpencodeCard[] = ['ask', 'unattended']
export const OPENCODE_AGENT = 'build'

export const PERMISSION_REQUEST_PREFIX = 'opencode:permission:'
export const FORM_REQUEST_PREFIX = 'opencode:form:'

export interface OpencodeRule {
  action: string
  resource: string
  effect: 'allow' | 'deny' | 'ask'
}

export function rulesetFor(card: OpencodeCard): OpencodeRule[] {
  return [{ action: '*', resource: '*', effect: card === 'unattended' ? 'allow' : 'ask' }]
}

/** The card encoded by the pair the phone sends. Unknown pairs fall to ask. */
export function cardFromPair(sandbox?: SandboxMode | null, approvalPolicy?: ApprovalPolicy | null): OpencodeCard {
  return sandbox === 'danger-full-access' || approvalPolicy === 'never' ? 'unattended' : 'ask'
}

/** The pair reported to the phone for a card. */
export function pairFor(card: OpencodeCard): { sandbox: SandboxMode; approvalPolicy: ApprovalPolicy } {
  return card === 'unattended'
    ? { sandbox: 'danger-full-access', approvalPolicy: 'never' }
    : { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
}

/**
 * The card a session ruleset encodes, or null for anything else.
 *
 * Used by tests and by a future "read the session back" path; the provider
 * deliberately reports the card it last SENT (from prefs), not whatever a TUI
 * happens to have configured.
 */
export function cardFromRuleset(rules: readonly OpencodeRule[] | undefined): OpencodeCard | null {
  if (rules?.length !== 1) return null
  const [rule] = rules
  if (rule?.action !== '*' || rule.resource !== '*') return null
  if (rule.effect === 'allow') return 'unattended'
  if (rule.effect === 'ask') return 'ask'
  return null
}

function actionType(action: string): ApprovalRequest['type'] {
  const value = action.toLowerCase()
  if (/(bash|shell|exec|terminal|command)/.test(value)) return 'command'
  if (/(edit|write|patch|create|delete|move|rename)/.test(value)) return 'fileChange'
  if (/(permission|approval)/.test(value)) return 'permissions'
  if (/(question|ask|form)/.test(value)) return 'userInput'
  return 'other'
}

export function permissionToApproval(
  request: OpencodePermissionRequest,
  opts: { turnId: string; cwd?: string | null },
): ApprovalRequest {
  const detail = request.resources.length > 0 ? request.resources.join('\n') : undefined
  return {
    requestId: PERMISSION_REQUEST_PREFIX + request.id,
    threadId: request.sessionID,
    turnId: opts.turnId,
    itemId: request.source ? `oc:tool:${request.source.id}` : `oc:approval:${request.id}`,
    type: actionType(request.action),
    title: request.message ?? request.action,
    ...(detail ? { detail } : {}),
    cwd: opts.cwd ?? null,
    reason: request.message ?? null,
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
  }
}

export function decisionToReply(decision: ApprovalDecision): 'once' | 'always' | 'reject' {
  if (decision === 'accept') return 'once'
  if (decision === 'acceptForSession') return 'always'
  return 'reject'
}

/**
 * A form field as a question, when the phone can answer it.
 *
 * The sheet renders options plus one free-text row. A string field with no
 * options therefore works (the user types), a number is typed and parsed, and
 * a boolean becomes 是/否. `external` needs an OAuth-style round trip this
 * provider does not implement, so a form containing one is left to the opencode
 * client rather than rendered half-broken.
 */
function fieldToQuestion(field: OpencodeFormField): ApprovalQuestion | null {
  if (field.type === 'external') return null
  const question = field.title ?? field.key
  if (field.type === 'boolean') {
    return {
      question,
      options: [{ label: '是' }, { label: '否' }],
    }
  }
  if (field.type === 'number' || field.type === 'integer') {
    return { question, options: [] }
  }
  if (field.type !== 'string' && field.type !== 'multiselect') return null
  const options = (field.options ?? []).map((option) => ({
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }))
  return {
    question,
    multiSelect: field.type === 'multiselect',
    options,
  }
}

export interface FormPlan {
  approval: ApprovalRequest
  /** Fields in question order, for turning labels back into values. */
  visible: OpencodeFormField[]
  /** Hidden fields whose default can be submitted without asking. */
  hidden: { key: string; value: string | number | boolean | string[] }[]
}

/**
 * Build the sheet for a form, or null when it contains a field the phone
 * cannot answer.
 */
export function formToApproval(form: OpencodeForm, opts: { turnId: string; cwd?: string | null }): FormPlan | null {
  const visible: OpencodeFormField[] = []
  const questions: ApprovalQuestion[] = []
  const hidden: FormPlan['hidden'] = []
  for (const field of form.fields) {
    if (field.hidden) {
      if ('default' in field && field.default !== undefined) {
        hidden.push({ key: field.key, value: field.default })
      }
      continue
    }
    const question = fieldToQuestion(field)
    if (!question) return null
    visible.push(field)
    questions.push(question)
  }
  if (questions.length === 0) return null
  return {
    approval: {
      requestId: FORM_REQUEST_PREFIX + form.id,
      threadId: form.sessionID,
      turnId: opts.turnId,
      itemId: `oc:form:${form.id}`,
      type: 'userInput',
      title: form.title,
      availableDecisions: ['accept', 'cancel'],
      questions,
      cwd: opts.cwd ?? null,
    },
    visible,
    hidden,
  }
}

/** Raised when the phone's answers cannot be expressed as this form's answer. */
export class InvalidFormAnswer extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidFormAnswer'
  }
}

function optionValue(field: OpencodeFormField, label: string): string {
  if ('options' in field && Array.isArray(field.options)) {
    const found = field.options.find((option) => option.label === label)
    if (found) return found.value ?? found.label
  }
  return label
}

function answerField(field: OpencodeFormField, labels: string[]): string | number | boolean | string[] {
  if (labels.length === 0) {
    if (field.required) throw new InvalidFormAnswer(`${field.key} is required`)
    return field.type === 'multiselect' ? [] : ''
  }
  if (field.type === 'multiselect') {
    return labels.map((label) => optionValue(field, label))
  }
  const first = labels[0]
  if (first === undefined) throw new InvalidFormAnswer(`${field.key} is required`)
  if (field.type === 'number' || field.type === 'integer') {
    const value = Number(first)
    if (!Number.isFinite(value)) throw new InvalidFormAnswer(`${field.key} must be a number`)
    if (field.type === 'integer' && !Number.isInteger(value))
      throw new InvalidFormAnswer(`${field.key} must be an integer`)
    return value
  }
  if (field.type === 'boolean') {
    const lower = first.toLowerCase()
    if (['是', 'true', 'yes', '1'].includes(lower)) return true
    if (['否', 'false', 'no', '0'].includes(lower)) return false
    throw new InvalidFormAnswer(`${field.key} must be yes or no`)
  }
  return optionValue(field, first)
}

/**
 * Turn the phone's positional answers into opencode's keyed answer object.
 *
 * `answers` is one array per question in the order the sheet rendered them.
 * Throws `InvalidFormAnswer` on a value the form cannot accept; the caller
 * keeps the sheet up in that case.
 */
export function answersToForm(
  visible: readonly OpencodeFormField[],
  hidden: readonly { key: string; value: string | number | boolean | string[] }[],
  answers: readonly string[][] | undefined,
): Record<string, string | number | boolean | string[]> {
  const result: Record<string, string | number | boolean | string[]> = {}
  for (const item of hidden) result[item.key] = item.value
  for (const [index, field] of visible.entries()) {
    result[field.key] = answerField(field, answers?.[index] ?? [])
  }
  return result
}
