import type { ApprovalPolicy, ProviderId, SandboxMode } from '@vibemobile/protocol'

/**
 * The permission cards, and the only place the front end defines them.
 *
 * Three screens share this table:
 *  - new Claude sessions use these cards and default to 自动判断;
 *  - the composer sends one card's worth of `(sandbox, approvalPolicy)` per turn;
 *  - the chat page has to reconstruct which card a session is ALREADY on from
 *    what the provider reports, or the picker starts every session on the safe
 *    default and silently downgrades the one the user just created.
 *
 * Keeping it here rather than inside `Composer.tsx` is what makes the second
 * possible. The server has its own copy of this ladder in
 * `apps/server/src/claude/permission.ts` (`permissionModeFor`), because a
 * provider must not depend on the web app; those two are the pair that has to
 * agree. Codex keeps the two fields apart instead of collapsing them
 * (`codex/permission.ts`), so adding or removing a level means touching this
 * table, that collapse, and the value lists there.
 *
 * `'auto'` — 自动判断 — is Claude-only and is filtered out for every other
 * provider by `permissionCardsFor` below. It is the one rung with no Codex
 * equivalent, and Codex cannot accept the value (`codex/permission.ts` rejects
 * it), so offering it there would be a card that silently does nothing.
 */
export type PermissionCard = 'ask' | 'readonly' | 'auto' | 'unattended'

export const PERMISSIONS: Record<
  PermissionCard,
  { label: string; approvalPolicy: ApprovalPolicy; sandbox: SandboxMode }
> = {
  ask: { label: '按需确认', approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  readonly: { label: '只读', approvalPolicy: 'untrusted', sandbox: 'read-only' },
  // Label is 自动判断 rather than 自动 because the effort picker in the same row
  // already shows 自动 in two places (`Composer.tsx`), and one word meaning two
  // things in one 390px control row is not worth the two characters saved.
  auto: { label: '自动判断', approvalPolicy: 'auto', sandbox: 'workspace-write' },
  // Id renamed from 'auto' to 'unattended' when the rung above arrived. The
  // behaviour did not change; this is the word the rest of the project already
  // uses for it (`isUnattended`, "unattended tool calls" in the server log).
  unattended: { label: '完全访问', approvalPolicy: 'never', sandbox: 'danger-full-access' },
}

/** Display order, safest first. 完全访问 stays last so it is never the default. */
export const PERMISSION_CARDS: PermissionCard[] = ['ask', 'readonly', 'auto', 'unattended']

/** The same list without the Claude-only rung. */
const CODEX_CARDS: PermissionCard[] = ['ask', 'readonly', 'unattended']

/**
 * The cards to offer for a session, by provider.
 *
 * An unknown provider — which today means "the summary has not loaded yet" —
 * gets the NARROW list, like every other unknown input in this codebase
 * (`permissionCardFor` → 按需确认, `asPermissionMode` → `default`,
 * `effectiveSandbox` → workspace-write). A provider id this build has never
 * heard of must not inherit a rung for a mode it may not have.
 *
 * Note what the narrow answer costs if it is ever wrong: a Claude session on
 * 自动判断 would open on 按需确认 and the first message would send that. It is
 * unreachable today because `Chat.tsx` returns early while loading and on a load
 * error, so the composer only exists once `SessionSummary.provider` is known
 * (it is a required field) — a property of that page, not of this type.
 */
export function permissionCardsFor(provider: ProviderId | undefined): PermissionCard[] {
  return provider === 'claude' ? PERMISSION_CARDS : CODEX_CARDS
}

/**
 * Which card a session is running, given what its provider reports.
 *
 * `undefined` is a real answer, not a bug, and lands on 按需确认, the default
 * card. Two things produce it: a session the server has no memory of, and a pair
 * outside the table, since new Codex sessions offer the sandbox and the
 * approval policy as two independent choices and can therefore create nine
 * combinations (six of which no card expresses).
 *
 * Those six are driven on 按需确认 until the first message re-asserts the card
 * on screen, and that is not uniformly a move toward safety: two of them come
 * out wider on one half (`(read-only, on-request)` loses the read-only sandbox,
 * `(workspace-write, untrusted)` stops asking about everything). What the
 * fallback does guarantee is that an unrecognized pair never lights up 完全访问,
 * and that what the machine gets is what is on screen.
 *
 * The value is what the server last SENT for that session, and the composer
 * sends the displayed card on the next turn — so this decides where the picker
 * starts, never what the session ends up doing. That is also why it is safe to
 * restore: the answer stays on screen, in a warning colour when it is 自动判断 or
 * 完全访问, for as long as the user could send a message.
 *
 * `cards` is required rather than defaulted to the full list. The caller is the
 * one that knows the provider, and a default would let a later call site opt out
 * of the guarantee by omission. What it guarantees is that the returned card is
 * always one the picker was given: Radix renders an EMPTY trigger for a value
 * with no matching item (`SelectValue` treats a non-empty value as "show the
 * selected item"), so a card that matched but was not offered would show the
 * user a blank 96px control that only opening the menu can explain. Both lists
 * above begin with `'ask'`, which is what the fallback returns.
 */
export function permissionCardFor(
  sandbox: SandboxMode | null | undefined,
  approvalPolicy: ApprovalPolicy | null | undefined,
  cards: PermissionCard[],
): PermissionCard {
  const found = cards.find(
    (card) => PERMISSIONS[card].sandbox === sandbox && PERMISSIONS[card].approvalPolicy === approvalPolicy,
  )
  return found ?? 'ask'
}
