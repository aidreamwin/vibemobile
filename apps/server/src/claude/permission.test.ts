import { describe, expect, it } from 'vitest'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ApprovalPolicy, SandboxMode } from '@vibemobile/protocol'
import {
  PERMISSION_MODES,
  asPermissionMode,
  needsDangerousAck,
  permissionModeFor,
  permissionOptionsFor,
} from './permission.js'

/**
 * The composer's cards, spelled out here rather than imported from the web app
 * (a server module must not depend on one). `apps/web/src/lib/permission.ts` is
 * the other copy and the two have to agree; nothing checks that across the
 * boundary, so it is pinned where a maintainer changing the ladder will look.
 */
const CARDS: { label: string; sandbox: SandboxMode; approvalPolicy: ApprovalPolicy; mode: PermissionMode }[] = [
  { label: '按需确认', sandbox: 'workspace-write', approvalPolicy: 'on-request', mode: 'default' },
  { label: '只读', sandbox: 'read-only', approvalPolicy: 'untrusted', mode: 'plan' },
  { label: '自动判断', sandbox: 'workspace-write', approvalPolicy: 'auto', mode: 'auto' },
  { label: '完全访问', sandbox: 'danger-full-access', approvalPolicy: 'never', mode: 'bypassPermissions' },
]

describe('permissionModeFor', () => {
  it('gives each card its own mode', () => {
    for (const card of CARDS) {
      expect(permissionModeFor(card.sandbox, card.approvalPolicy)).toBe(card.mode)
    }
  })

  /**
   * The pair is not a level: it is what the new-session sheet's two independent
   * three-way choices can produce, and the composer re-sends one whole card per
   * turn. These are the collisions that follow from that, recorded so nobody
   * "fixes" them into a table without noticing they are load-bearing.
   */
  it('resolves the pairs that name two different levels', () => {
    // Either half alone is enough to remove the stopping point, so this is the
    // same level the 完全访问 card sends.
    expect(permissionModeFor('read-only', 'never')).toBe('bypassPermissions')
    expect(permissionModeFor('danger-full-access', 'on-request')).toBe('bypassPermissions')
    // A read-only sandbox with anything short of `never` is the 只读 card.
    expect(permissionModeFor('read-only', 'untrusted')).toBe('plan')
  })

  /**
   * `'auto'` is the first protocol value the Codex app-server cannot accept, so
   * it is also the first one a hand-written WS frame can attach to any sandbox.
   * The UI cannot produce these pairs — the composer sends one whole card, and
   * the card the front end sends for this rung is always workspace-write.
   */
  it('runs the classifier for any pair that names it', () => {
    for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as SandboxMode[]) {
      expect(permissionModeFor(sandbox, 'auto')).toBe('auto')
    }
    // The one that matters: `auto` must not be able to reach the mode that
    // exits(1) on a root deployment, whichever half is the wider one.
    expect(permissionModeFor('danger-full-access', 'auto')).not.toBe('bypassPermissions')
  })

  it('treats an unknown or missing half as the guarded default', () => {
    expect(permissionModeFor(undefined, undefined)).toBe('default')
    expect(permissionModeFor('workspace-write', undefined)).toBe('default')
    expect(permissionModeFor(undefined, 'on-request')).toBe('default')
    expect(permissionModeFor('read-only', 'sometimes' as ApprovalPolicy)).toBe('plan')
    expect(permissionModeFor('yolo' as SandboxMode, 'never')).toBe('bypassPermissions')
  })
})

describe('permissionOptionsFor', () => {
  /**
   * The way back, and the reason it exists: a session reports these two fields
   * so the composer can open on the card it is really on. Get this wrong and the
   * picker starts on 按需确认 no matter what the session was created with, its
   * first message sends that, and the session is downgraded — the bug this whole
   * pair of functions was added for.
   */
  it('round-trips every card through the pair the phone sees', () => {
    for (const card of CARDS) {
      expect(permissionOptionsFor(card.mode)).toEqual({
        sandbox: card.sandbox,
        approvalPolicy: card.approvalPolicy,
      })
    }
  })

  /**
   * Not a perfect inverse and it does not need to be, but where it is lossy it
   * must lose in one direction only: the mode it reports has to map back to the
   * same mode, or the next turn would change the level on its own.
   */
  it('reports a mode that maps back to itself', () => {
    for (const card of CARDS) {
      const { sandbox, approvalPolicy } = permissionOptionsFor(card.mode)
      expect(permissionModeFor(sandbox, approvalPolicy)).toBe(card.mode)
    }
  })

  it('falls back to the guarded pair for a mode with no card', () => {
    for (const mode of ['acceptEdits', 'dontAsk'] as PermissionMode[]) {
      expect(permissionOptionsFor(mode)).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
    }
  })

  /**
   * The other direction of the same rule, and the one a root deployment depends
   * on: whatever the session was driven with, the pair the phone is handed must
   * never be the one that maps to `bypassPermissions` unless the session really
   * is on 完全访问.
   */
  it('never reports the pair that needs the dangerous ack for another mode', () => {
    for (const mode of ['default', 'plan', 'auto', 'acceptEdits', 'dontAsk'] as PermissionMode[]) {
      const pair = permissionOptionsFor(mode)
      expect(needsDangerousAck(permissionModeFor(pair.sandbox, pair.approvalPolicy))).toBe(false)
    }
  })
})

describe('needsDangerousAck', () => {
  /**
   * `#spawnTurn` sets `allowDangerouslySkipPermissions` on exactly this, and the
   * SDK refuses `bypassPermissions` without it. It is also part of a hard check
   * inside the CLI — `permissionMode === 'bypassPermissions' || allowBypass` —
   * that kills the process when it runs as root outside a sandbox — so whatever
   * this returns true for is the set of modes that can fail that way.
   */
  it('is true only for the mode that hands over the machine', () => {
    expect(needsDangerousAck('bypassPermissions')).toBe(true)
    for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto'] as PermissionMode[]) {
      expect(needsDangerousAck(mode)).toBe(false)
    }
  })
})

describe('asPermissionMode', () => {
  /**
   * The prefs store hands back a plain string (it is shared with Codex), and the
   * value does not stop at being displayed: it is restored into the live session
   * and from there reaches the SDK's `Options` for the next subprocess. A
   * hand-edited file must not be able to put an unknown mode on that command
   * line, so the list is closed and anything outside it downgrades.
   */
  it('accepts every mode the prefs file can hold', () => {
    for (const mode of PERMISSION_MODES) expect(asPermissionMode(mode)).toBe(mode)
  })

  it('downgrades everything else', () => {
    for (const junk of [undefined, '', 'yolo', 'BYPASSPERMISSIONS', 'accept_edits']) {
      expect(asPermissionMode(junk)).toBe('default')
    }
  })
})

describe('PERMISSION_MODES', () => {
  /**
   * Pinned against the SDK's own union so a mode added by an upgrade is a
   * deliberate decision rather than a silent pass-through. `test-claude.ts` is
   * the only other place a bad mode would show up, and it costs a subprocess.
   */
  it('matches the SDK union', () => {
    const all: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']
    expect([...PERMISSION_MODES].sort()).toEqual([...all].sort())
  })
})
