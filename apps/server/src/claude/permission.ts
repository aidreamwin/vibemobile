/**
 * The Claude permission ladder: which card means which `PermissionMode`, and
 * which mode to report back to the phone.
 *
 * Pure on purpose, like `codex/permission.ts`, `codex/mapEvents.ts` and
 * `claude/askUser.ts`: the provider assembles, this decides. The split is what
 * lets the rules below be unit-tested without spawning the CLI — until this
 * file existed the only coverage was `test-claude.ts`, which pays a ~230 MB
 * subprocess per turn to check four lines of mapping.
 */
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ApprovalPolicy, SandboxMode } from '@vibemobile/protocol'

/**
 * The permission ladder, in ONE place.
 *
 * This is the only path in the entire project by which a phone can hand an
 * agent unrestricted access to the machine, so it is deliberately a single
 * readable table rather than logic spread across call sites.
 *
 * | card      | Claude                                   | Codex equivalent                |
 * |-----------|------------------------------------------|---------------------------------|
 * | 按需确认   | `default`                                | `on-request` + `workspace-write` |
 * | 只读      | `plan`                                   | `untrusted` + `read-only`        |
 * | 自动判断   | `auto`                                   | — (Claude only)                  |
 * | 完全访问   | `bypassPermissions` (+ dangerous ack)    | `never` + `danger-full-access`   |
 *
 * Three honest caveats, because the columns are not truly equivalent:
 *
 *  - "完全访问" is a real match. `allowDangerouslySkipPermissions` is the SDK's
 *    own acknowledgement switch and it refuses `bypassPermissions` without it.
 *    One tap on the phone and the agent runs unattended, exactly like Codex's
 *    `danger-full-access`.
 *  - "只读" is the closest available, NOT a sandbox. Codex enforces read-only
 *    at the OS level; Claude's `plan` mode is a behavioural mode that blocks
 *    edits but still lets the agent run commands. A user picking 只读 should
 *    not be told they have the same guarantee Codex gives.
 *  - "自动判断" has no Codex counterpart and is deliberately not offered there.
 *    What it does is measured, not documented, and it is NOT "pause and ask":
 *    across five probes the SDK's `canUseTool` was never called, including for
 *    an `rm -rf` of a directory outside the working directory; the CLI's own
 *    debug log explains the rest (`Skipping auto mode classifier for Bash:
 *    would be allowed in acceptEdits mode`), and the classifier it does run
 *    (`model=…-flash stage=xml_s1/xml_s2`) approved everything it was shown.
 *    So the phone sees nothing under this rung and the agent does not stop —
 *    which is why it is offered for a machine where 完全访问 is impossible
 *    (see below) and not as a safer alternative to it.
 *
 *    What makes that the intended answer on THIS project's Claude deployment:
 *    the CLI refuses `bypassPermissions` outright when it runs as root outside
 *    a sandbox (`… cannot be used with root/sudo privileges for security
 *    reasons`, then `process.exit(1)`), so on a container running as root the
 *    完全访问 card is not "wider" — it is broken, and `auto` is the one
 *    unattended rung left that starts at all.
 */
export function permissionModeFor(sandbox?: SandboxMode, approvalPolicy?: ApprovalPolicy): PermissionMode {
  // First, so a pair naming both `auto` and `danger-full-access` runs the
  // classifier rather than the ack. Not because it is the conservative branch —
  // for `(read-only, auto)` this is the WIDER of the two — but because it keeps
  // this function total over every pair the protocol can now express: whichever
  // other half a hand-written client attaches, the mode is still `auto`, and
  // the one mode that can kill the process on a root deployment is unreachable
  // through this field. The existing collapse below is the same rule: when the
  // halves disagree, the one that names a mode wins.
  if (approvalPolicy === 'auto') return 'auto'
  if (sandbox === 'danger-full-access' || approvalPolicy === 'never') return 'bypassPermissions'
  if (sandbox === 'read-only') return 'plan'
  return 'default'
}

/**
 * The way back: what to tell the phone a session is running.
 *
 * The composer's picker has three cards and no idea which one a session is on,
 * so the session has to say. Without this the picker starts on the safe card no
 * matter what the session was created with, its first message sends THAT, and
 * `startTurn` obediently downgrades — which is why a session set to 完全访问
 * popped approval sheets all the same.
 *
 * Not a perfect inverse of `permissionModeFor` and does not need to be: that
 * function collapses `never` and `danger-full-access` into the same mode, so
 * `{approvalPolicy: 'never'}` alone reports back as the 完全访问 card. Same
 * mode, same meaning, one card that can express it.
 */
export function permissionOptionsFor(mode: PermissionMode): {
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
} {
  if (mode === 'auto') return { sandbox: 'workspace-write', approvalPolicy: 'auto' }
  if (mode === 'bypassPermissions') return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
  if (mode === 'plan') return { sandbox: 'read-only', approvalPolicy: 'untrusted' }
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
}

/**
 * The SDK refuses `bypassPermissions` unless this is also set.
 *
 * It is also half of a hard check inside the CLI — the same condition, plus
 * "running as root and not in a sandbox", prints `--dangerously-skip-permissions
 * cannot be used with root/sudo privileges` and calls `process.exit(1)`. So
 * whatever this returns true for is exactly the set of modes that can end a
 * turn that way, and `auto` must never join it: setting the ack for the
 * classifier mode would reintroduce, on the deployment this rung exists for,
 * the very failure it was added to route around. Pinned in `permission.test.ts`.
 */
export function needsDangerousAck(mode: PermissionMode): boolean {
  return mode === 'bypassPermissions'
}

/**
 * Every mode the SDK accepts. Spelled out because the prefs store hands back a
 * plain `string` now — it is shared with Codex and can no longer import the
 * SDK's type (see `providers/sessionPrefs.ts`).
 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]

/**
 * Narrow what came out of the prefs file to a mode the CLI will accept.
 *
 * Checked rather than cast, because this value is not only shown: it is restored
 * into `LiveSession.permissionMode` and from there reaches the SDK's `Options`
 * for the next subprocess. A hand-edited or truncated file must not be able to
 * put an unknown mode on that command line. Everything else that reads the same
 * string is display-only and already falls back to the safe pair, so landing on
 * `'default'` here gives the same answer they do.
 *
 * The list is deliberately closed: a mode added by a future SDK release is
 * treated as unknown until someone adds it here, which downgrades rather than
 * guessing.
 */
export function asPermissionMode(value: string | undefined): PermissionMode {
  return PERMISSION_MODES.find((mode) => mode === value) ?? 'default'
}
