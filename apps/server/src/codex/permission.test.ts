import { describe, expect, it } from 'vitest'
import type { ApprovalPolicy, SandboxMode } from '@vibemobile/protocol'
import {
  APPROVAL_POLICIES,
  SANDBOXES,
  effectiveSandbox,
  isApprovalPolicy,
  isSandbox,
  isUnattended,
  mergePermission,
  permissionPairFrom,
  sandboxPolicyFor,
} from './permission.js'

describe('the accepted values', () => {
  /**
   * These two arrays are the only runtime check between a hand-written WS frame
   * and the store — `ws/hub.ts` validates neither field and the protocol package
   * is types-only, so nothing else would notice a drifting list. Pin them
   * against the protocol unions so a new enum member cannot arrive unnoticed.
   */
  it('matches the protocol enums', () => {
    const sandboxes: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
    const policies: ApprovalPolicy[] = ['untrusted', 'on-request', 'never']
    expect([...SANDBOXES]).toEqual(sandboxes)
    expect([...APPROVAL_POLICIES]).toEqual(policies)
  })

  /**
   * …except that the protocol's `ApprovalPolicy` is now WIDER than the list
   * above, on purpose: it also carries Claude's `'auto'`, which the app-server
   * has no meaning for. The two are supposed to differ, and this is the pair of
   * assertions that says so — `codex/permission.ts` is the gate that keeps the
   * extra member out of this provider's payload and out of the store, and
   * `CodexProvider` calls it at both places a client-supplied value arrives.
   */
  it('is narrower than the protocol, which also carries Claude’s auto', () => {
    const claudeOnly: ApprovalPolicy = 'auto'
    expect(isApprovalPolicy(claudeOnly)).toBe(false)
    expect(permissionPairFrom('workspace-write', claudeOnly)).toBeNull()
    expect(mergePermission(null, { approvalPolicy: claudeOnly })).toBeNull()
  })

  it('rejects anything that is not one of them', () => {
    expect(isSandbox('workspace-write')).toBe(true)
    expect(isApprovalPolicy('never')).toBe(true)
    for (const junk of [undefined, null, '', 'WORKSPACE-WRITE', 'workspace_write', 0, {}, ['never']]) {
      expect(isSandbox(junk)).toBe(false)
      expect(isApprovalPolicy(junk)).toBe(false)
    }
    // The two vocabularies must not accept each other's values.
    expect(isSandbox('never')).toBe(false)
    expect(isApprovalPolicy('read-only')).toBe(false)
  })
})

describe('permissionPairFrom', () => {
  /**
   * All nine, not the composer's three cards. The new-session sheet offers the
   * sandbox and the approval policy as two independent three-way choices
   * (`NewSessionSheet.tsx`), so `(workspace-write, never)` is a session the user
   * can really create. Remembering only the card pairs would drop those six and
   * bring the session back on the default — the failure this memory removes.
   */
  it('accepts every combination the new-session sheet can create', () => {
    for (const sandbox of SANDBOXES) {
      for (const approvalPolicy of APPROVAL_POLICIES) {
        expect(permissionPairFrom(sandbox, approvalPolicy)).toEqual({ sandbox, approvalPolicy })
      }
    }
  })

  /**
   * Half a pair cannot seed the picker, and the caller must fall back to its
   * default card rather than fill the gap with a guess.
   */
  it('gives nothing back when either half is missing or unknown', () => {
    expect(permissionPairFrom('read-only', undefined)).toBeNull()
    expect(permissionPairFrom(undefined, 'never')).toBeNull()
    expect(permissionPairFrom(undefined, undefined)).toBeNull()
    expect(permissionPairFrom('read-only', 'sometimes')).toBeNull()
    expect(permissionPairFrom('full-access', 'never')).toBeNull()
    expect(permissionPairFrom('', '')).toBeNull()
  })
})

describe('effectiveSandbox', () => {
  /**
   * Total on purpose: once `turn/start` carries a `sandboxPolicy` there is no
   * "leave it alone" spelling, and `startTurn` maps anything unrecognized onto
   * workspace-write. The payload and the recorded value both go through here,
   * which is what keeps the memory from claiming a sandbox the machine was
   * never given.
   */
  it('falls back to workspace-write, which is what the wire carries too', () => {
    expect(effectiveSandbox('danger-full-access')).toBe('danger-full-access')
    expect(effectiveSandbox('read-only')).toBe('read-only')
    expect(effectiveSandbox('workspace-write')).toBe('workspace-write')
    expect(effectiveSandbox(undefined)).toBe('workspace-write')
  })

  it('names the three wire forms', () => {
    expect(sandboxPolicyFor('read-only')).toEqual({ type: 'readOnly' })
    expect(sandboxPolicyFor('workspace-write')).toEqual({ type: 'workspaceWrite' })
    expect(sandboxPolicyFor('danger-full-access')).toEqual({ type: 'dangerFullAccess' })
    expect(sandboxPolicyFor(undefined)).toEqual({ type: 'workspaceWrite' })
  })
})

describe('mergePermission', () => {
  const stored = { sandbox: 'workspace-write' as const, approvalPolicy: 'on-request' as const }

  it('records a whole pair on a turn that carries both', () => {
    expect(mergePermission(null, { sandbox: 'danger-full-access', approvalPolicy: 'never' })).toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
  })

  /**
   * The case that makes this a merge rather than an assignment: `startTurn` only
   * puts a field in the payload when it was given one, so the app-server keeps
   * the other half from last time. Recording `incoming` verbatim would store a
   * pair the thread was never in.
   */
  it('keeps the half a turn did not carry', () => {
    expect(mergePermission(stored, { sandbox: 'read-only' })).toEqual({
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    })
    expect(mergePermission(stored, { approvalPolicy: 'never' })).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
  })

  it('reports nothing when there is not a whole pair to report', () => {
    expect(mergePermission(null, {})).toBeNull()
    expect(mergePermission(null, { sandbox: 'read-only' })).toBeNull()
    expect(mergePermission(null, { approvalPolicy: 'never' })).toBeNull()
  })

  /**
   * Asymmetric on purpose, mirroring what the two halves do on the wire: an
   * unknown sandbox is harmless because the payload maps it to workspace-write
   * anyway, while an unknown approval policy reaches the app-server unmodified —
   * so it overwrites nothing and we keep reporting the last value we do know.
   */
  it('treats an unknown value the way the wire treats it', () => {
    // An unknown sandbox becomes workspace-write in the payload, so that is
    // what the machine is given and therefore what gets recorded — here
    // replacing a stored read-only, which is the honest outcome.
    expect(
      mergePermission({ sandbox: 'read-only', approvalPolicy: 'on-request' }, { sandbox: 'yolo' as SandboxMode }),
    ).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
    // An unknown approval policy reaches the app-server unmodified, so it
    // overwrites nothing and the last known value is what we keep reporting.
    expect(mergePermission(stored, { approvalPolicy: 'sometimes' as ApprovalPolicy })).toEqual(stored)
    // With nothing stored it is the unrecognized sandbox that completes the
    // pair, as workspace-write — which is what the thread is really given.
    expect(mergePermission(null, { sandbox: 'yolo' as SandboxMode, approvalPolicy: 'never' })).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
    // …whereas an unknown policy has no such mapping to fall back on, so a turn
    // that carries only that still leaves nothing worth storing.
    expect(mergePermission(null, { approvalPolicy: 'sometimes' as ApprovalPolicy })).toBeNull()
  })
})

describe('isUnattended', () => {
  /** Either half alone ends "the agent stops and asks", which is the whole
   * reason a phone can supervise a desktop agent. */
  it('is true when either half removes the stopping point', () => {
    expect(isUnattended({ sandbox: 'danger-full-access', approvalPolicy: 'on-request' })).toBe(true)
    expect(isUnattended({ sandbox: 'read-only', approvalPolicy: 'never' })).toBe(true)
    expect(isUnattended({ sandbox: 'danger-full-access', approvalPolicy: 'never' })).toBe(true)
  })

  it('is false for the pairs that still stop and ask', () => {
    expect(isUnattended({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })).toBe(false)
    expect(isUnattended({ sandbox: 'read-only', approvalPolicy: 'untrusted' })).toBe(false)
    expect(isUnattended({ sandbox: 'workspace-write', approvalPolicy: 'untrusted' })).toBe(false)
  })
})
