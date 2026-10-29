/**
 * End-to-end check of ClaudeProvider, with no hub, no HTTP and no browser.
 *
 * This is the only thing that catches a mismatch between the mapper and the
 * provider that wraps it — the unit tests feed the mapper captured frames, and
 * the SDK smoke test (`smoke-claude.ts`) never touches our code at all. What
 * lives in between is exactly where the bugs have been.
 *
 *   npx tsx apps/server/scripts/test-claude.ts
 *
 * It runs real turns against the real CLI, so it costs tokens and takes about
 * a minute. Each phase prints PASS or FAIL and the process exits non-zero if
 * anything failed.
 *
 * ── Approvals need a write, not an `echo` ────────────────────────────────────
 * Claude Code runs its own classifier over tool calls and auto-approves the
 * safe ones, so a read-only command never reaches `canUseTool` and proves
 * nothing. Only a file write reliably produces an approval, and only in
 * `default` permission mode — `bypassPermissions` skips the callback entirely.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeProvider } from '../src/claude/ClaudeProvider.js'
import type { AgentEvent, ApprovalRequest, Transcript } from '@vibemobile/protocol'

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: string): void => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// A throwaway state directory, never the real one: that one holds the JWT
// signing secret and the login PIN, and a test has no business reading or
// rewriting it. Phase 7 needs it to prove the prefs survive a restart.
const prefsDir = mkdtempSync(path.join(os.tmpdir(), 'vibemobile-prefs-'))
const provider = new ClaudeProvider({ workspaceRoots: [process.cwd()], stateDir: prefsDir })
await provider.start()

const events: AgentEvent[] = []
provider.subscribe((e) => events.push(e))
const since = (mark: number): AgentEvent[] => events.slice(mark)
const of = <K extends AgentEvent['kind']>(list: AgentEvent[], kind: K): Extract<AgentEvent, { kind: K }>[] =>
  list.filter((e) => e.kind === kind) as Extract<AgentEvent, { kind: K }>[]

// ------------------------------------------------------------------ 1. probe

console.log('\n=== 1. probe / models / projects ===')
const info = await provider.probe()
console.log(`  ${info.displayName} ${info.version} auth=${info.authenticated} (${info.detail})`)
check('probe reports available', info.available)
check('probe reports authenticated', info.authenticated === true)
check('probe reports a real version, not a placeholder', /\d+\.\d+\.\d+/.test(info.version ?? ''), info.version)

const models = await provider.listModels()
for (const m of models) console.log(`  ${m.id.padEnd(10)} ${m.displayName}`)
check('models are listed', models.length > 0)
check(
  'model labels show what they resolve to',
  models.every((m) => m.id === 'default' || m.displayName.includes('deepseek')),
)

const projects = await provider.listProjects()
check('projects are listed with git facts', projects.length > 0 && typeof projects[0].isGitRepo === 'boolean')

// ------------------------------------------------- 2. a plain turn, then reload

console.log('\n=== 2. plain turn + reading the transcript mid-turn ===')
const slow = await provider.createSession({ cwd: process.cwd(), model: 'haiku' })
let mark = events.length
const slowTurn = await provider.startTurn(slow.id, [
  {
    type: 'text',
    text: 'Run this exact shell command with the Bash tool, then reply with the single word DONE:\n\n  sleep 20 && echo finished',
  },
])

await waitFor(() => of(since(mark), 'item.started').length > 0, 90_000, 'a tool card to start')
const mid = await provider.getTranscript(slow.id)
const midLive = mid?.turns.find((t) => t.status === 'inProgress')
const midReplayed = (mid?.turns ?? []).filter((t) => t.status !== 'inProgress')
console.log(`  live turn items: ${midLive?.items.length ?? 0}, replayed turns: ${midReplayed.length}`)
check('a reload mid-turn still sees the turn as inProgress', Boolean(midLive), midLive?.id)
check(
  'the running turn carries its user message and a tool card',
  (midLive?.items ?? []).some((i) => i.kind === 'message' && i.role === 'user') &&
    (midLive?.items ?? []).some((i) => i.kind === 'command'),
)
check('the inProgress turn id is the one startTurn returned', midLive?.id === slowTurn.turnId)

const liveIds = (midLive?.items ?? []).map((i) => i.id)
const replayIds = midReplayed.flatMap((t) => t.items.map((i) => i.id))
check(
  'no item id appears in both the live turn and the replayed history',
  liveIds.every((id) => !replayIds.includes(id)),
)

const liveTexts = textsOf(midLive?.items ?? [])
const replayTexts = midReplayed.flatMap((t) => textsOf(t.items))
check(
  'no text is rendered twice',
  liveTexts.every((t) => !replayTexts.includes(t)),
  JSON.stringify([...liveTexts, ...replayTexts]),
)

await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the turn to finish')
const done = of(since(mark), 'turn.completed')
check('exactly one turn.completed is emitted', done.length === 1, `${done.length}`)
check('the turn completed', done[0]?.status === 'completed', done[0]?.status)

// The CLI appends to the JSONL as it goes, so immediately after a turn the
// content may not be on disk yet. The transcript must still show it.
const justAfter = await provider.getTranscript(slow.id)
const newest = justAfter?.turns.at(-1)
check(
  'the newest turn survives a reload taken right after it ended',
  (newest?.items.length ?? 0) > 1,
  `${newest?.items.length} items, status ${newest?.status}`,
)
check('and it is no longer reported as inProgress', newest?.status === 'completed', newest?.status)

// ----------------------------------------------------------- 3. approval flow

console.log('\n=== 3. tool approval ===')
const scratch = path.join(process.cwd(), 'apps', 'server', 'scripts', '.approval-probe.txt')
rmSync(scratch, { force: true })

// `workspace-write` + `on-request` is the 按需确认 card: enough permission for
// the write to be attempted, not enough to skip the callback.
const guarded = await provider.createSession({
  cwd: process.cwd(),
  model: 'haiku',
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
})
mark = events.length
await provider.startTurn(guarded.id, [
  {
    type: 'text',
    text: `Use the Write tool to create the file at exactly this path: ${scratch}\nIts contents should be the single line: hello\nThen reply DONE.`,
  },
])

const asked = await waitFor(
  () => of(since(mark), 'approval.requested').length > 0,
  120_000,
  'an approval request',
  false,
)
const requests = of(since(mark), 'approval.requested')
const approval: ApprovalRequest | undefined = requests[0]?.approval
check('a write reaches canUseTool', Boolean(approval), approval ? `${approval.type} ${approval.title}` : 'no request')
if (approval) {
  check('the approval names the session', approval.threadId === guarded.id)
  check('the approval is typed as a file change', approval.type === 'fileChange', approval.type)
  check(
    'the approval offers the four decisions',
    approval.availableDecisions.length === 4,
    approval.availableDecisions.join(','),
  )
  check('the provider reports it as pending until answered', provider.pendingApprovalsFor(guarded.id).length === 1)

  await provider.answerApproval(approval.requestId, 'accept')
  check('answering clears it from the pending set', provider.pendingApprovalsFor(guarded.id).length === 0)
  check('an approval.resolved event is emitted', of(since(mark), 'approval.resolved').length === 1)

  await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the approved turn to finish')
  check('the turn finished after approval', of(since(mark), 'turn.completed')[0]?.status === 'completed')
  check('the approved write really happened', existsSync(scratch), readFileSync(scratch, 'utf8').trim().slice(0, 40))
  if (!asked) console.log('  note: the approval arrived later than expected but did arrive')
}

check(
  'answering an unknown request fails loudly',
  await rejects(() => provider.answerApproval('no-such-request', 'accept')),
)
rmSync(scratch, { force: true })

// --------------------------- 3b. the permission a session was created with

/**
 * The bug this phase exists for, reported from the phone: create a session with
 * 完全访问, send a message, and approval sheets keep appearing anyway.
 *
 * `permissionModeFor` (now `claude/permission.ts`) was never wrong. The PICKER
 * was: it held its own card,
 * defaulted to 按需确认, and had no way to learn the session's — so its first
 * message sent the guarded pair and `startTurn` obediently downgraded the
 * session the user had just configured. The fix is that a summary now reports
 * the level the session is running and the picker seeds from it; this phase
 * pins both ends of that round trip against the real CLI.
 *
 * The last check is the one that must not be forgotten: 完全访问 becoming
 * sticky must never make 按需确认 un-sticky.
 */
console.log('\n=== 3b. the permission a session was created with is the one it runs ===')
const openScratch = path.join(process.cwd(), 'apps', 'server', 'scripts', '.permission-probe.txt')
rmSync(openScratch, { force: true })

const opened = await provider.createSession({
  cwd: process.cwd(),
  model: 'haiku',
  sandbox: 'danger-full-access',
  approvalPolicy: 'never',
})
check(
  'a session created with 完全访问 reports 完全访问',
  opened.sandbox === 'danger-full-access' && opened.approvalPolicy === 'never',
  `${opened.sandbox}/${opened.approvalPolicy}`,
)

mark = events.length
await provider.startTurn(
  opened.id,
  [
    {
      type: 'text',
      text: `Use the Write tool to create the file at exactly this path: ${openScratch}\nIts contents should be the single line: hello\nThen reply DONE.`,
    },
  ],
  // What the composer sends after reading that summary back.
  { sandbox: opened.sandbox ?? undefined, approvalPolicy: opened.approvalPolicy ?? undefined },
)
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the unattended turn to finish')
const openApprovals = of(since(mark), 'approval.requested').length
check('a write under 完全访问 raises no approval sheet', openApprovals === 0, `${openApprovals} requests`)
check('and the turn completed', of(since(mark), 'turn.completed')[0]?.status === 'completed')
check('the write really happened', existsSync(openScratch))

// A turn that names no permission must keep the session's, not reset it to the
// guarded one: that is what a client sending only text relies on.
mark = events.length
await provider.startTurn(opened.id, [{ type: 'text', text: 'Reply with the single word DONE and nothing else.' }])
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the second turn to finish')
const kept = await provider.getSession(opened.id)
check(
  'a turn with no permission keeps the session on 完全访问',
  kept?.sandbox === 'danger-full-access' && kept?.approvalPolicy === 'never',
  `${kept?.sandbox}/${kept?.approvalPolicy}`,
)

// The downgrade direction still works.
mark = events.length
await provider.startTurn(
  opened.id,
  [
    {
      type: 'text',
      text: `Use the Write tool to create the file at exactly this path: ${openScratch}\nIts contents should be the single line: again\nThen reply DONE.`,
    },
  ],
  { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
)
const askedAgain = await waitFor(
  () => of(since(mark), 'approval.requested').length > 0,
  120_000,
  'the downgraded turn to ask',
  false,
)
const downgraded = of(since(mark), 'approval.requested')[0]?.approval
check('switching back to 按需确认 asks again', askedAgain)
check(
  'and the summary reports the downgrade',
  (await provider.getSession(opened.id))?.approvalPolicy === 'on-request',
  String((await provider.getSession(opened.id))?.approvalPolicy),
)
if (downgraded) await provider.answerApproval(downgraded.requestId, 'accept')
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the downgraded turn to finish', false)

// Back up to 完全访问, and left there on purpose: this session is what phase 7
// restarts a provider against, and what it must come back as. Toggling down and
// then up is also the honest shape of the thing — the remembered value has to
// follow the LATEST choice, so a "remember the first one" bug would pass every
// check above and still be wrong.
mark = events.length
await provider.startTurn(opened.id, [{ type: 'text', text: 'Reply with the single word DONE and nothing else.' }], {
  sandbox: 'danger-full-access',
  approvalPolicy: 'never',
})
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the re-granted turn to finish')
check(
  'the last choice wins, not the first',
  (await provider.getSession(opened.id))?.approvalPolicy === 'never',
  String((await provider.getSession(opened.id))?.approvalPolicy),
)

rmSync(openScratch, { force: true })

// ---------------------------------------------- 3c. the agent asks a question

/**
 * The bug this phase exists for, reported from the phone as "claude 确实 askuser
 * 问题": AskUserQuestion arrives through `canUseTool` like any other tool, and
 * the sheet offered 允许 / 拒绝. Allowing it resolved `{behavior:'allow'}` with
 * the input untouched, and the CLI then reported to the model, verbatim:
 *
 *   The user did not answer the questions.
 *
 * So the phone could dismiss the question but never answer it. The answer
 * travels inside the input (`updatedInput.answers`) — the only channel the tool
 * reads — which is what this phase proves against the real CLI: the model must
 * come back with the colour the test chose, not with a shrug.
 *
 * The sheet's own shape is pinned too, because it is what the phone switches on
 * to know it is looking at a form: type `userInput`, structured questions, and
 * no `acceptForSession` (there is no "always allow" for a question).
 */
console.log('\n=== 3c. the agent asks a question and the phone answers it ===')
const asking = await provider.createSession({
  cwd: process.cwd(),
  model: 'haiku',
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
})
mark = events.length
await provider.startTurn(asking.id, [
  {
    type: 'text',
    text:
      'Use the AskUserQuestion tool to ask me which of two colours I prefer, offering exactly ' +
      'the options Red and Blue in one single-choice question. Once you have my answer, reply ' +
      'with exactly one line: COLOUR=<the option I picked>. Do not use any other tool.',
  },
])

const askedQuestion = await waitFor(
  () => of(since(mark), 'approval.requested').length > 0,
  120_000,
  'a question to reach canUseTool',
  false,
)
const question: ApprovalRequest | undefined = of(since(mark), 'approval.requested')[0]?.approval
check('a question reaches the phone as an approval', Boolean(question), question?.title)
if (question) {
  check('and it is typed as a question, not as a permission', question.type === 'userInput', question.type)
  check(
    'the raw questions JSON is not also dumped as the detail',
    question.detail === undefined,
    String(question.detail).slice(0, 60),
  )
  check(
    'the options arrive structured, so the phone can render a form',
    question.questions?.[0]?.options.map((o) => o.label).join(',') === 'Red,Blue',
    JSON.stringify(question.questions?.[0]?.options.map((o) => o.label)),
  )
  check(
    'there is no "always allow" for a question',
    question.availableDecisions.join(',') === 'accept,decline,cancel',
    question.availableDecisions.join(','),
  )

  // Blue is options[1]: picking the SECOND option means a bug that answers with
  // options[0] — the obvious way to get this wrong — cannot pass.
  await provider.answerApproval(question.requestId, 'accept', [['Blue']])
  await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the answered turn to finish')

  const answerItems = of(since(mark), 'item.completed')
    .map((e: any) => e.item)
    .filter(Boolean)
  const answerEvent = textsOf(answerItems).join('\n')
  check(
    'the model receives the choice the user made',
    /COLOUR=Blue/.test(answerEvent),
    answerEvent.match(/COLOUR=[^\s]*/)?.[0] ?? answerEvent.slice(0, 120),
  )
  check(
    'and it does not report the question as unanswered',
    !/did not answer/i.test(answerEvent),
    answerEvent.slice(0, 120),
  )
}

// An answer that does not line up must not silently become an allow — that is
// the original bug wearing a different hat. Declining is visible to the model.
const incomplete = await provider.createSession({
  cwd: process.cwd(),
  model: 'haiku',
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
})
mark = events.length
await provider.startTurn(incomplete.id, [
  {
    type: 'text',
    text:
      'Use the AskUserQuestion tool to ask me which of two colours I prefer, offering exactly ' +
      'the options Red and Blue. Then reply with exactly one line: COLOUR=<the option I picked>.',
  },
])
const second = await waitFor(
  () => of(since(mark), 'approval.requested').length > 0,
  120_000,
  'a second question',
  false,
)
const secondQuestion: ApprovalRequest | undefined = of(since(mark), 'approval.requested')[0]?.approval
if (secondQuestion) {
  check('a question exists to answer badly', secondQuestion.questions?.[0]?.question !== undefined)
  // `accept` with nothing attached: exactly what the old sheet sent.
  await provider.answerApproval(secondQuestion.requestId, 'accept')
  await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the unanswered turn to finish', false)
  // Asserting on the tool result rather than on what the model says next: a
  // denied question leaves the model free to guess a colour out loud, and a
  // check that fails when it does would be reporting the wrong thing. Our own
  // decline message is the deterministic part.
  const answered = await provider.getTranscript(incomplete.id)
  const toolOutput = (answered?.turns ?? [])
    .flatMap((t) => t.items)
    .map((i: any) => (i.kind === 'tool' ? i.output : ''))
    .join('\n')
  check(
    'an accept with no answers is declined, not turned into a silent allow',
    /not answered from VibeMobile/.test(toolOutput),
    toolOutput.slice(0, 160) || '(no tool output)',
  )
} else if (!second) {
  check('a second question was asked', false, 'no approval.requested')
}

// ------------------------------------------------------- 3d. 自动判断 (auto)

/**
 * The fourth rung, and the only one with no equivalent in the other backend:
 * `approvalPolicy: 'auto'` is Claude's `permissionMode: 'auto'`, where the CLI
 * runs its own classifier and reaches the phone only when it cannot decide.
 *
 * What is pinned here was measured rather than documented — under auto,
 * `canUseTool` is not called for a workspace-internal write, the action just
 * happens. So the pair of checks that matter is "no sheet" AND "the file is
 * really there": auto also BLOCKS silently when the classifier fails, and that
 * leaves no file behind, so either check alone would pass on the wrong outcome.
 *
 * The last step is 3b's anti-stickiness check re-run on this rung. A rung that
 * becomes sticky in the wrong direction is the same class of bug as 完全访问
 * doing so — and this is the turn that goes through `options.resume`, which the
 * manual probes never exercised.
 */
console.log('\n=== 3d. 自动判断 runs the CLI classifier instead of asking the phone ===')
const autoScratch = path.join(process.cwd(), 'apps', 'server', 'scripts', '.auto-probe.txt')
rmSync(autoScratch, { force: true })

const auto = await provider.createSession({
  cwd: process.cwd(),
  model: 'haiku',
  sandbox: 'workspace-write',
  approvalPolicy: 'auto',
})
check(
  'a session created on 自动判断 reports 自动判断',
  auto.sandbox === 'workspace-write' && auto.approvalPolicy === 'auto',
  `${auto.sandbox}/${auto.approvalPolicy}`,
)

mark = events.length
await provider.startTurn(
  auto.id,
  [
    {
      type: 'text',
      text: `Use the Write tool to create the file at exactly this path: ${autoScratch}\nIts contents should be the single line: auto\nThen reply DONE.`,
    },
  ],
  { sandbox: auto.sandbox ?? undefined, approvalPolicy: auto.approvalPolicy ?? undefined },
)
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the auto turn to finish')
const autoApprovals = of(since(mark), 'approval.requested').length
check('自动判断 raises no approval sheet', autoApprovals === 0, `${autoApprovals} requests`)
check('and the turn completed', of(since(mark), 'turn.completed')[0]?.status === 'completed')
check('the write really happened, rather than being silently blocked', existsSync(autoScratch))

mark = events.length
await provider.startTurn(
  auto.id,
  [
    {
      type: 'text',
      text: `Use the Write tool to create the file at exactly this path: ${autoScratch}\nIts contents should be the single line: again\nThen reply DONE.`,
    },
  ],
  { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
)
const autoAskedBack = await waitFor(
  () => of(since(mark), 'approval.requested').length > 0,
  120_000,
  'the turn after 自动判断 to ask',
  false,
)
check('switching back to 按需确认 asks again', autoAskedBack)
check(
  'and the summary reports the downgrade',
  (await provider.getSession(auto.id))?.approvalPolicy === 'on-request',
  String((await provider.getSession(auto.id))?.approvalPolicy),
)
const autoBack = of(since(mark), 'approval.requested')[0]?.approval
if (autoBack) await provider.answerApproval(autoBack.requestId, 'accept')
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the post-auto turn to finish', false)

rmSync(autoScratch, { force: true })

// ------------------------- 3e. an approval its turn walked away from

/**
 * The stuck-sheet bug, as it was reported: a turn ends — interrupted, or its
 * child dies — while an approval is up. Nothing else ever settles that callback,
 * so the sheet stays on screen, comes back on every reload (the hub re-serves
 * its pending map to each new client), and cannot be dismissed, because a sheet
 * is deliberately not dismissable. The session also keeps reporting
 * `waitingApproval`, and so keeps the attention badge, for the rest of the
 * process's life.
 *
 * `#settleApprovals` is the fix, and it has three callers on purpose — the
 * abort signal, the frame loop's `finally`, and `stop()`. This phase drives the
 * first two at once, which is the realistic case: the user hits stop while the
 * sheet is still on screen.
 */
console.log('\n=== 3e. an approval its turn walked away from ===')
const abandoned = path.join(process.cwd(), 'apps', 'server', 'scripts', '.abandoned-probe.txt')
rmSync(abandoned, { force: true })

const teardown = await provider.createSession({
  cwd: process.cwd(),
  model: 'haiku',
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
})
mark = events.length
const teardownTurn = await provider.startTurn(teardown.id, [
  {
    type: 'text',
    text: `Use the Write tool to create the file at exactly this path: ${abandoned}\nIts contents should be the single line: never\nThen reply DONE.`,
  },
])
await waitFor(() => of(since(mark), 'approval.requested').length > 0, 120_000, 'an approval to abandon')

const abandonedRequest = of(since(mark), 'approval.requested')[0]?.approval
check('an approval is outstanding', Boolean(abandonedRequest), abandonedRequest?.title ?? 'none')
check(
  'the session reports itself as waiting on a human',
  (await provider.getSession(teardown.id))?.status === 'waitingApproval',
  String((await provider.getSession(teardown.id))?.status),
)

await provider.interrupt(teardown.id, teardownTurn.turnId)
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 60_000, 'the interrupted turn to close')

// The point of the phase: a RESOLVED event, not merely a dropped map entry.
// The hub's pending map — and the sheet on the phone — only clear on this
// event.
const settled = await waitFor(
  () => of(since(mark), 'approval.resolved').some((e) => e.requestId === abandonedRequest?.requestId),
  30_000,
  'the abandoned approval to be resolved',
  false,
)
check('the abandoned approval is resolved, not just dropped', settled)
check('it is gone from the pending set', provider.pendingApprovalsFor(teardown.id).length === 0)
check(
  'answering it afterwards fails loudly',
  await rejects(() => provider.answerApproval(abandonedRequest?.requestId ?? 'none', 'accept')),
)
check(
  'the session comes back to idle instead of staying in waitingApproval',
  (await provider.getSession(teardown.id))?.status === 'idle',
  String((await provider.getSession(teardown.id))?.status),
)
check('the write it was asking about never happened', !existsSync(abandoned), abandoned)
rmSync(abandoned, { force: true })

// ---------------------------------------------------------------- 4. interrupt

console.log('\n=== 4. interrupt ===')
mark = events.length
const longTurn = await provider.startTurn(slow.id, [
  { type: 'text', text: 'Run this exact shell command with the Bash tool:\n\n  sleep 120 && echo never' },
])
await waitFor(() => of(since(mark), 'item.started').length > 0, 90_000, 'the long tool to start')

const at = Date.now()
await provider.interrupt(slow.id, longTurn.turnId)
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 60_000, 'the interrupt to land')
const stopped = of(since(mark), 'turn.completed')[0]
check('the stopped turn is reported as interrupted, not completed', stopped?.status === 'interrupted', stopped?.status)
check('the interrupt landed quickly', Date.now() - at < 20_000, `${Date.now() - at}ms`)

const afterStop = await provider.getTranscript(slow.id)
const stoppedTurn = afterStop?.turns.at(-1)
check(
  'a reload shows the stopped turn as interrupted',
  stoppedTurn?.status === 'interrupted',
  `${stoppedTurn?.id} ${stoppedTurn?.status}`,
)
check(
  'the interrupted turn keeps what it had already produced',
  (stoppedTurn?.items.length ?? 0) > 1,
  `${stoppedTurn?.items.length} items`,
)

// ------------------------------------------------- 5. resume, list, lifecycle

console.log('\n=== 5. resume / list / lifecycle ===')
mark = events.length
await provider.startTurn(slow.id, [
  { type: 'text', text: 'Run this exact shell command with the Bash tool, then reply DONE:\n\n  sleep 15 && echo ok' },
])
await waitFor(() => of(since(mark), 'item.started').length > 0, 90_000, 'the turn to start')

mark = events.length
const resumed = await provider.resumeSession(slow.id)
const replay = since(mark)
check('resumeSession returns the session', resumed?.id === slow.id)
check('resuming mid-turn replays turn.started', of(replay, 'turn.started').length === 1)
check('resuming mid-turn replays a status', of(replay, 'session.status').length >= 1)
check(
  'resuming mid-turn replays the in-flight items',
  of(replay, 'item.completed').length > 0,
  `${of(replay, 'item.completed').length} items`,
)
check(
  'the replayed items belong to the live turn',
  of(replay, 'turn.started')[0]?.turnId === of(replay, 'item.completed')[0]?.turnId,
)

await provider.interrupt(slow.id, of(replay, 'turn.started')[0]?.turnId ?? '')
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 60_000, 'the second turn to stop', false)

const listed = await provider.listSessions({ cwd: process.cwd() })
check(
  'the session now appears in listSessions',
  listed.some((s) => s.id === slow.id),
  `${listed.length} sessions`,
)
const found = listed.find((s) => s.id === slow.id)
check('the listed session carries its provider', found?.provider === 'claude', found?.provider)
check('the listed session carries a title', Boolean(found?.title), found?.title)
check('getSession agrees with the list', (await provider.getSession(slow.id))?.id === slow.id)

// A session created but never messaged has no JSONL on disk. Deleting it must
// not surface a "file not found" to the user.
const empty = await provider.createSession({ cwd: process.cwd() })
await provider.deleteSession(empty.id)
check('deleting a never-used session does not fail', (await provider.getSession(empty.id)) === null)

const forked = await provider.forkSession(slow.id)
check('forking returns a different session', forked.id !== slow.id, forked.id)
check('the fork is a Claude session', forked.provider === 'claude')
check('the fork is listed by the SDK too', (await provider.getSession(forked.id)) !== null)

await provider.renameSession(forked.id, 'renamed by the test')
check('renaming sticks', (await provider.getSession(forked.id))?.title === 'renamed by the test')

await provider.deleteSession(forked.id)
check('the fork can be deleted', (await provider.getSession(forked.id)) === null)

await provider.stop()

// ------------------------------------- 6. an unconfigured box must say so

/**
 * The failure this phase exists for, reported from a real deployment: on a
 * Linux server the provider showed the CLI's official model catalogue instead
 * of the configured proxy's models, and every turn died without a reply — while
 * `/api/providers` reported it as available AND authenticated.
 *
 * The cause was `Boolean(account.tokenSource)`: an unauthenticated CLI reports
 * the STRING `'none'`, which is truthy. A clean config dir plus no `ANTHROPIC_*`
 * in the environment reproduces exactly that state, so it is worth pinning:
 * `available` stays true (the CLI does answer), `authenticated` must be false,
 * and the reason has to reach `detail` — that string is what the phone shows.
 *
 * The order of the two halves is the point, and it is easy to get backwards.
 * Stripping the environment does NOT unauthorize the CLI: the CLI reads
 * `~/.claude/settings.json`'s `env` block itself. Only the config directory
 * decides. So when a deployment reports "no credentials", the config dir is the
 * finding — which is why that path is in the message, and why it is asserted
 * here rather than taken on faith.
 */
console.log('\n=== 6. a CLI with no credentials reports itself unauthenticated ===')
const envBefore = { ...process.env }
const cleanConfig = mkdtempSync(path.join(os.tmpdir(), 'vibemobile-noconfig-'))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ANTHROPIC_')) delete process.env[key]
}
// So "half one" really is the default config dir, whatever the caller's shell
// happened to export.
delete process.env.CLAUDE_CONFIG_DIR

// Half one: the real config dir, an empty environment. Relies on the same
// assumption phase 1 does — this machine's proxy renames the models.
const inherited = new ClaudeProvider({ workspaceRoots: [process.cwd()] })
const inheritedProbe = await inherited.probe()
const inheritedModels = await inherited.listModels()
check(
  'emptying the environment does NOT unauthorize the CLI',
  inheritedProbe.authenticated === true,
  inheritedProbe.detail,
)
check(
  'because the CLI reads the config file itself, not the environment',
  inheritedModels.some((m) => m.displayName.includes('deepseek')),
  inheritedModels.map((m) => m.id).join(','),
)

// Half two: the same empty environment, but pointing the CLI at a config dir
// that has nothing in it.
process.env.CLAUDE_CONFIG_DIR = cleanConfig
const unconfigured = new ClaudeProvider({ workspaceRoots: [process.cwd()] })
const cleanProbe = await unconfigured.probe()
check('an unconfigured CLI is still "available"', cleanProbe.available === true)
check(
  'but it is NOT authenticated (tokenSource "none" is a truthy string)',
  cleanProbe.authenticated === false,
  String(cleanProbe.authenticated),
)
check('and the reason reaches the phone', /tokenSource: none/.test(cleanProbe.detail ?? ''), cleanProbe.detail)
check(
  'the reason names the config dir the CLI actually read',
  (cleanProbe.detail ?? '').includes(cleanConfig),
  cleanProbe.detail,
)
check(
  'it still serves a model list, which is why this failure is invisible',
  (await unconfigured.listModels()).length > 0,
  (await unconfigured.listModels()).map((m) => m.id).join(','),
)

for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key]
Object.assign(process.env, envBefore)
rmSync(cleanConfig, { recursive: true, force: true })
check('the environment is restored for the phases below', Boolean(process.env.ANTHROPIC_BASE_URL))

// ------------------------------------------- 7. model and effort are remembered

/**
 * The bug this phase exists for: pick a model and an effort, leave the session,
 * come back, and both controls were back at their defaults. Three separate
 * causes, so three separate things to assert:
 *
 *  1. the effort was persisted nowhere at all (`reasoningEffort: null` was
 *     hardcoded into both summary builders);
 *  2. the model lived only in the provider's memory, so a restart lost it;
 *  3. the effort never reached the CLI even when the picker showed it —
 *     `startTurn` accepted `opts.effort` and read it nowhere.
 *
 * (3) is the one that needs evidence from outside our own code, and there is
 * exactly one place to get it: the CLI stamps the effort it actually applied
 * onto its own session JSONL (`"effort":"…"` next to `perTurnEffort`), which is
 * the CLI's record, not ours. A capture made with no effort passed recorded
 * `"effort":"high"` — the value `DEFAULT_EFFORT` assumes.
 */
console.log('\n=== 7. model + effort survive a reload, and reach the CLI ===')
mark = events.length
const tuned = await provider.startTurn(
  slow.id,
  [{ type: 'text', text: 'Reply with the single word DONE and nothing else.' }],
  { model: 'haiku', effort: 'low' },
)
await waitFor(() => of(since(mark), 'turn.completed').length > 0, 180_000, 'the tuned turn to finish')

const tunedSummary = await provider.getSession(slow.id)
check('the live session reports the chosen model', tunedSummary?.model === 'haiku', String(tunedSummary?.model))
check(
  'the live session reports the chosen effort',
  tunedSummary?.reasoningEffort === 'low',
  String(tunedSummary?.reasoningEffort),
)

const stamped = effortStamps(slow.id)
check(
  'the CLI received the effort (its own JSONL stamp)',
  stamped.includes('low'),
  stamped.join(',') || 'no stamp found',
)

// The restart case: a brand-new provider, sharing only the state directory.
const notices: string[] = []
const restarted = new ClaudeProvider({
  workspaceRoots: [process.cwd()],
  stateDir: prefsDir,
  // Restoring a bypass-level mode has to be visible to the operator as well as
  // to the phone. It arrives on the notice channel: the deployment routes that
  // one to `warn`, while the ordinary log channel goes to `debug` and would be
  // invisible in the service log at the default level.
  onNotice: (line) => notices.push(line),
})
await restarted.start()
const restored = await restarted.resumeSession(slow.id)
check('a restarted provider restores the model', restored?.model === 'haiku', String(restored?.model))
check(
  'a restarted provider restores the effort',
  restored?.reasoningEffort === 'low',
  String(restored?.reasoningEffort),
)
const restoredList = (await restarted.listSessions({ cwd: process.cwd() })).find((s) => s.id === slow.id)
check('the session list shows the model too', restoredList?.model === 'haiku', String(restoredList?.model))

// The permission mode rides the same file, and the bug that put it there was
// reported from the phone: "I set 完全访问, why do the authorisation windows
// keep popping up". Restoring it is the point — the user should not have to
// re-pick — and `restarted` above is a genuinely new provider sharing nothing
// but the state directory, which is exactly what a service restart produces.
const restoredPerm = await restarted.resumeSession(opened.id)
if (restoredPerm) {
  check(
    'a restarted provider restores 完全访问',
    restoredPerm.sandbox === 'danger-full-access' && restoredPerm.approvalPolicy === 'never',
    `${restoredPerm.sandbox}/${restoredPerm.approvalPolicy}`,
  )
  const listedOpen = (await restarted.listSessions({ cwd: process.cwd() })).find((s) => s.id === opened.id)
  check(
    'and the session list reports it too, not just the reopen path',
    listedOpen?.sandbox === 'danger-full-access',
    String(listedOpen?.sandbox),
  )
  // The phone shows the restored level for as long as the session is on it, and
  // this is the other half: the operator's log records the moment it attached.
  check(
    'reopening it says so on the notice channel, not just to the phone',
    notices.some((l) => l.includes('unattended tool calls') && l.includes('bypassPermissions')),
    notices.join(' | ') || 'no notice',
  )
} else {
  check('a restarted provider can reopen the 完全访问 session', false, 'resumeSession returned null')
}
await restarted.deleteSession(opened.id)

const modelsWithDefault = await restarted.listModels()
check(
  'every model advertises a default effort instead of leaving the UI to pick the cheapest',
  modelsWithDefault.every((m) => !m.efforts?.length || m.defaultEffort === 'high'),
  modelsWithDefault.map((m) => `${m.id}:${m.defaultEffort ?? '-'}`).join(' '),
)

// A fork is a copy of the conversation, so it should not start on defaults.
const forkTuned = await restarted.forkSession(slow.id)
check('a fork inherits the model', forkTuned.model === 'haiku', String(forkTuned.model))
check('a fork inherits the effort', forkTuned.reasoningEffort === 'low', String(forkTuned.reasoningEffort))
await restarted.deleteSession(forkTuned.id)
await restarted.stop()

check('the turn id came back', Boolean(tuned.turnId))

rmSync(prefsDir, { recursive: true, force: true })

// ------------------------------------------------------------------ summary

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}

// ------------------------------------------------------------------ helpers

function textsOf(items: { kind: string; [k: string]: unknown }[]): string[] {
  return items
    .filter((i) => i.kind === 'message' && (i as any).role === 'assistant')
    .map((i) => String((i as any).text))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * The efforts the CLI recorded for a session, straight out of its own JSONL.
 *
 * The transcript lives under a directory name the CLI derives from the cwd, so
 * the file is found by id rather than by path. Deliberately reads the CLI's
 * file and not `getSessionMessages()`: the point is a record we did not write.
 */
function effortStamps(sessionId: string): string[] {
  const root = path.join(os.homedir(), '.claude', 'projects')
  const found: string[] = []
  for (const dir of readdirSync(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`)
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /"effort":"([a-z]+)"/.exec(line)
      if (match) found.push(match[1])
    }
  }
  return found
}

/** Returns whether the predicate held; `fatal` decides if a timeout is a failure. */
async function waitFor(pred: () => boolean, ms: number, what: string, fatal = true): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(250)
  }
  if (fatal) check(`timed out waiting for ${what}`, false, `${ms}ms`)
  return false
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}
