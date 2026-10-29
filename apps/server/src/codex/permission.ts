/**
 * The Codex permission pair: which `(sandbox, approvalPolicy)` combinations may
 * be remembered, and how one turn's overrides fold into what was remembered.
 *
 * Pure on purpose, like `codex/mapEvents.ts` and `claude/askUser.ts`: the
 * provider assembles, this decides. That split is what lets the rules below be
 * unit-tested without an app-server.
 *
 * ── Why validation is not paranoia ──────────────────────────────────────────
 * `ws/hub.ts` forwards `sandbox` and `approvalPolicy` from the client message
 * straight into `startTurn` with no check at all, and the protocol package is
 * types-only, so nothing at runtime rejects a junk value. Whatever comes back
 * from the app-server after that, we must not write it into the store as if the
 * user had chosen it and then hand it to the picker as their selection. Only
 * values in the two enums below are ever recorded or reported; anything else is
 * treated as "not known" (see `permissionPairFrom`), which the web app renders
 * as its default card.
 *
 * ── What "allowed" means here, and why it is 3×3 rather than 3 ──────────────
 * The composer's permission picker has four cards, each a fixed pair
 * (`apps/web/src/lib/permission.ts`): 按需确认, 只读, 自动判断, 完全访问 — but
 * only three of them exist for a Codex session, because 自动判断 is Claude's
 * `permissionMode: 'auto'` and the app-server has no such mode. So the picker the
 * web app builds for this provider is a three-card list, while this file's
 * vocabulary is the widest thing Codex can accept.
 *
 * The new-session sheet does NOT use cards: it offers the sandbox and the
 * approval policy as two independent three-way choices, so a session can
 * legitimately be created on any of the nine combinations —
 * `(workspace-write, never)` and `(read-only, on-request)` among them.
 *
 * Remembering only the three card pairs would silently drop those six, and the
 * session would come back on 按需确认 — the exact failure this memory exists to
 * remove ("I set it up this way, why is it back to the default"). So the rule is
 * the wider one: keep the pair whenever both halves are real values, and let the
 * picker's own exact-pair match fall back to its default card for the six it
 * cannot express.
 *
 * That fallback is NOT a "moves toward safety" guarantee, and it would be wrong
 * to write one here: when the next message re-asserts the card on screen, two of
 * the six come out wider on one half — `(read-only, on-request)` trades a
 * read-only sandbox for a writable workspace, and `(workspace-write, untrusted)`
 * goes from asking about nearly everything to asking on request. What it does
 * guarantee is narrower and still worth having: the fallback never lights up
 * 完全访问 (the one level that hands out unattended access), and the pair the
 * machine is given is always the pair on screen, which the user can see and
 * change before sending.
 *
 * Note this differs from Claude on purpose. `permissionModeFor`
 * (`claude/permission.ts`) collapses `approvalPolicy: 'never'` alone into
 * `bypassPermissions`, so a
 * `(read-only, never)` session reports as 完全访问 there. The app-server keeps
 * the two fields independent, so Codex reports them as they are; collapsing them
 * would claim a sandbox the thread is not in.
 */
import type { ApprovalPolicy, SandboxMode } from '@vibemobile/protocol'

export interface PermissionPair {
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
}

/**
 * The accepted values, spelled out here rather than derived from the protocol
 * types — types are erased at runtime, and these two arrays are the only thing
 * standing between a hand-written WS frame and the store.
 *
 * They cannot live in `packages/protocol`: that package is types-only on
 * purpose (the server imports no runtime JS from it, which is what keeps
 * `rootDir: src` building), and a runtime constant would break that.
 *
 * `APPROVAL_POLICIES` is deliberately NARROWER than the protocol's
 * `ApprovalPolicy`, which also carries Claude's `'auto'`. That difference is the
 * whole reason `CodexProvider` runs `isApprovalPolicy` over every
 * client-supplied value before it reaches the app-server (see the two call sites
 * there): the pair this file records must be the pair the machine is given, and
 * a value that passes through unmodified would break that in both directions at
 * once — sent to a backend with no meaning for it, and never remembered.
 */
export const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const

export function isSandbox(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOXES as readonly string[]).includes(value)
}

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === 'string' && (APPROVAL_POLICIES as readonly string[]).includes(value)
}

/**
 * The sandbox the app-server will actually apply for a requested one.
 *
 * Total on purpose: `startTurn` maps anything unrecognized onto workspace-write
 * (`turn/start` has no "leave it alone" spelling once the field is present), so
 * this is also what a junk value means on the wire. Building the payload and
 * recording the turn both go through it, which is what stops the remembered
 * pair from drifting away from the one the machine was actually given.
 */
export function effectiveSandbox(sandbox: SandboxMode | undefined): SandboxMode {
  if (sandbox === 'danger-full-access') return 'danger-full-access'
  if (sandbox === 'read-only') return 'read-only'
  return 'workspace-write'
}

/** The wire form of a sandbox. `turn/start` takes the object; `thread/start` takes the string. */
export function sandboxPolicyFor(sandbox: SandboxMode | undefined): {
  type: 'dangerFullAccess' | 'readOnly' | 'workspaceWrite'
} {
  const mode = effectiveSandbox(sandbox)
  return {
    type: mode === 'danger-full-access' ? 'dangerFullAccess' : mode === 'read-only' ? 'readOnly' : 'workspaceWrite',
  }
}

/**
 * A pair, or `null` when either half is missing or unknown.
 *
 * `null` is the honest answer to "what is this session running": half a pair
 * cannot seed a picker, and the caller must fall back to its default card rather
 * than fill the gap with a guess.
 */
export function permissionPairFrom(sandbox: unknown, approvalPolicy: unknown): PermissionPair | null {
  if (!isSandbox(sandbox) || !isApprovalPolicy(approvalPolicy)) return null
  return { sandbox, approvalPolicy }
}

/**
 * Fold one turn's overrides into what was remembered.
 *
 * Each half may arrive without the other: `startTurn` only puts a field in the
 * payload when it was given one, so a turn carrying a sandbox alone leaves the
 * thread's approval policy exactly as it was. The result is therefore the pair
 * the app-server ends up with, not `incoming` on its own — recording `incoming`
 * would store a combination the machine never received.
 *
 * An unrecognized value is never recorded. For `sandbox` that costs nothing,
 * because the wire form maps anything unknown onto workspace-write and
 * `effectiveSandbox` says so on both sides; for `approvalPolicy` it is the only
 * honest choice, since the raw value reaches the app-server unmodified and we
 * have no idea what it did with it.
 *
 * Returns `null` when the result would be incomplete — a half-pair is not worth
 * storing, and forgetting is safer than inventing.
 */
export function mergePermission(
  stored: PermissionPair | null,
  incoming: { sandbox?: SandboxMode; approvalPolicy?: ApprovalPolicy },
): PermissionPair | null {
  const sandbox = incoming.sandbox ? effectiveSandbox(incoming.sandbox) : stored?.sandbox
  const approvalPolicy = isApprovalPolicy(incoming.approvalPolicy) ? incoming.approvalPolicy : stored?.approvalPolicy
  return permissionPairFrom(sandbox, approvalPolicy)
}

/**
 * Whether a pair means the phone has handed the agent unattended access.
 *
 * Either half alone is enough: removing the sandbox or answering every approval
 * automatically both end the "the agent stops and asks" property that is the
 * whole reason a phone can supervise a desktop agent. Matches
 * `permissionModeFor`'s collapse on the Claude side (`claude/permission.ts`),
 * which is the behaviour the two providers have to agree on.
 */
export function isUnattended(pair: PermissionPair): boolean {
  return pair.sandbox === 'danger-full-access' || pair.approvalPolicy === 'never'
}
