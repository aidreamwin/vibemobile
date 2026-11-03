import { describe, expect, it } from 'vitest'
import {
  answersToForm,
  cardFromPair,
  cardFromRuleset,
  InvalidFormAnswer,
  FORM_REQUEST_PREFIX,
  formToApproval,
  PERMISSION_REQUEST_PREFIX,
  permissionToApproval,
  pairFor,
  rulesetFor,
} from './permission.js'
import type { OpencodeForm, OpencodePermissionRequest } from './types.js'

const request: OpencodePermissionRequest = {
  id: 'per_1',
  sessionID: 'ses_1',
  action: 'shell',
  resources: ['cat .env'],
  source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
  message: 'needs shell',
}

describe('opencode permission cards', () => {
  it('maps the two cards to rulesets', () => {
    expect(rulesetFor('ask')).toEqual([{ action: '*', resource: '*', effect: 'ask' }])
    expect(rulesetFor('unattended')).toEqual([{ action: '*', resource: '*', effect: 'allow' }])
    expect(cardFromRuleset(rulesetFor('ask'))).toBe('ask')
    expect(cardFromRuleset(rulesetFor('unattended'))).toBe('unattended')
    expect(cardFromRuleset([])).toBeNull()
    expect(cardFromRuleset([{ action: 'read', resource: '*', effect: 'allow' }])).toBeNull()
  })

  it('round-trips the wire pair', () => {
    for (const card of ['ask', 'unattended'] as const) {
      const pair = pairFor(card)
      expect(cardFromPair(pair.sandbox, pair.approvalPolicy)).toBe(card)
    }
    // Anything unrecognised falls to the safe card.
    expect(cardFromPair('read-only', 'untrusted')).toBe('ask')
    expect(cardFromPair(undefined, undefined)).toBe('ask')
  })

  it('turns a permission request into a command sheet', () => {
    const approval = permissionToApproval(request, { turnId: 'oc:turn:msg_1', cwd: 'D:/w' })
    expect(approval).toMatchObject({
      requestId: `${PERMISSION_REQUEST_PREFIX}per_1`,
      threadId: 'ses_1',
      turnId: 'oc:turn:msg_1',
      itemId: 'oc:tool:call_1',
      type: 'command',
      title: 'needs shell',
      detail: 'cat .env',
      cwd: 'D:/w',
    })
    expect(approval.availableDecisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel'])
  })
})

function form(fields: OpencodeForm['fields']): OpencodeForm {
  return { id: 'frm_1', sessionID: 'ses_1', title: 'Questions', fields }
}

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value')
  return value
}

describe('opencode forms', () => {
  it('maps an option field and translates the label back to its value', () => {
    const plan = formToApproval(
      form([
        {
          key: 'q0',
          title: 'Colour',
          type: 'string',
          options: [
            { value: 'red', label: 'Red', description: 'warm' },
            { value: 'blue', label: 'Blue' },
          ],
        },
      ]),
      { turnId: 'oc:turn:msg_1' },
    )
    expect(plan?.approval.requestId).toBe(`${FORM_REQUEST_PREFIX}frm_1`)
    expect(plan?.approval.questions).toEqual([
      { question: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] },
    ])
    expect(answersToForm(must(plan).visible, must(plan).hidden, [['Blue']])).toEqual({ q0: 'blue' })
  })

  it('supports free text, numbers, booleans and multiselect', () => {
    const plan = formToApproval(
      form([
        { key: 'name', title: 'Name', type: 'string' },
        { key: 'count', title: 'Count', type: 'integer' },
        { key: 'ok', title: 'OK?', type: 'boolean' },
        {
          key: 'tags',
          title: 'Tags',
          type: 'multiselect',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      ]),
      { turnId: 'oc:turn:msg_1' },
    )
    expect(plan?.approval.questions).toHaveLength(4)
    expect(answersToForm(must(plan).visible, must(plan).hidden, [['Ada'], ['3'], ['是'], ['A', 'B']])).toEqual({
      name: 'Ada',
      count: 3,
      ok: true,
      tags: ['a', 'b'],
    })
  })

  it('submits hidden defaults without asking', () => {
    const plan = formToApproval(
      form([
        { key: 'q0', title: 'Q', type: 'string', options: [{ value: 'x', label: 'X' }] },
        { key: 'secret', type: 'string', hidden: true, default: 'preset' },
      ]),
      { turnId: 'oc:turn:msg_1' },
    )
    expect(plan?.approval.questions).toHaveLength(1)
    expect(answersToForm(must(plan).visible, must(plan).hidden, [['X']])).toEqual({ secret: 'preset', q0: 'x' })
  })

  it('refuses a form the phone cannot render', () => {
    const plan = formToApproval(form([{ key: 'auth', type: 'external', url: 'https://example.test' }]), {
      turnId: 'oc:turn:msg_1',
    })
    expect(plan).toBeNull()
  })

  it('rejects an invalid number and a missing required answer', () => {
    const plan = must(
      formToApproval(
        form([
          { key: 'count', title: 'Count', type: 'integer', required: true },
          { key: 'q0', title: 'Q', type: 'string', required: true },
        ]),
        { turnId: 'oc:turn:msg_1' },
      ),
    )
    expect(() => answersToForm(plan.visible, plan.hidden, [['abc'], ['x']])).toThrow(InvalidFormAnswer)
    expect(() => answersToForm(plan.visible, plan.hidden, [[], ['x']])).toThrow(InvalidFormAnswer)
  })
})
