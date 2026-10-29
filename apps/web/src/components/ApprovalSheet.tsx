import { useState } from 'react'
import type { ApprovalDecision, ApprovalQuestion, ApprovalRequest } from '@vibemobile/protocol'
import { Button } from './ui/button'
import { Input } from './ui/input'
import Sheet from './Sheet'
import { socket } from '../lib/ws'

/**
 * Labels carry the *consequence*, because the two reject options behave very
 * differently: `decline` refuses this one command and the agent keeps working,
 * while `cancel` refuses it and aborts the whole turn.
 *
 * `variant` picks the shadcn button style; the same three tones this used to
 * hand-roll as raw class strings.
 */
const DECISIONS: Record<
  ApprovalDecision,
  { label: string; hint: string; variant: 'default' | 'secondary' | 'destructive' }
> = {
  accept: { label: '允许', hint: '执行这一次', variant: 'default' },
  acceptForSession: { label: '本会话始终允许', hint: '之后同类请求不再询问', variant: 'secondary' },
  decline: { label: '拒绝', hint: '代理继续本轮，换别的方式', variant: 'secondary' },
  cancel: { label: '拒绝并中断', hint: '立即结束本轮任务', variant: 'destructive' },
}

/**
 * A question is not a permission. "允许 / 执行这一次" describes a consequence
 * that does not exist here — the agent is not about to do anything, it is
 * waiting to be told which of two things to do. Answering the verdict is what
 * used to make the CLI report back that the user had not answered, so the
 * labels have to be about the answer instead. `askUser.ts` on the server has
 * the measurement.
 */
const QUESTION_DECISIONS: Partial<typeof DECISIONS> = {
  accept: { label: '提交', hint: '把选择发给代理', variant: 'default' },
  decline: { label: '拒绝回答', hint: '代理自己拿主意，继续本轮', variant: 'secondary' },
  cancel: { label: '拒绝并中断', hint: '立即结束本轮任务', variant: 'destructive' },
}

/** What the user picked for one question. */
interface Pick {
  labels: string[]
  /** Free text, for the answer that is none of the options. */
  custom: string
}

/**
 * The answer for one question, in the wire's terms: a list of labels.
 *
 * Typing wins over tapping — the two clear each other on every edit, so this
 * never has to guess what the user meant by having done both.
 */
function answerFor(pick: Pick | undefined): string[] {
  const custom = pick?.custom.trim()
  return custom ? [custom] : (pick?.labels ?? [])
}

export default function ApprovalSheet({ approval }: { approval: ApprovalRequest }) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null)
  const [error, setError] = useState<string | null>(null)

  const questions = approval.questions ?? []
  const isQuestion = questions.length > 0
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => ({ labels: [], custom: '' })))

  // The server can withhold this list (it is experimental-gated); fall back to
  // the full set rather than showing no buttons at all.
  const decisions: ApprovalDecision[] =
    approval.availableDecisions.length > 0
      ? (approval.availableDecisions as ApprovalDecision[])
      : isQuestion
        ? ['accept', 'decline', 'cancel']
        : ['accept', 'acceptForSession', 'decline', 'cancel']

  const answered = picks.every((pick) => answerFor(pick).length > 0)

  function choose(index: number, label: string, multi: boolean): void {
    setPicks((prev) =>
      prev.map((pick, i) => {
        if (i !== index) return pick
        if (!multi) return { labels: pick.labels[0] === label ? [] : [label], custom: '' }
        return {
          labels: pick.labels.includes(label) ? pick.labels.filter((l) => l !== label) : [...pick.labels, label],
          custom: '',
        }
      }),
    )
  }

  function type(index: number, custom: string): void {
    setPicks((prev) => prev.map((pick, i) => (i === index ? { labels: [], custom } : pick)))
  }

  async function answer(decision: ApprovalDecision) {
    if (busy) return
    setBusy(decision)
    setError(null)
    try {
      // Only a submitted answer needs the choices. A refusal is a refusal
      // whatever the form says, and sending a half-filled form with it would
      // only invite the server to interpret something the user did not mean.
      const answers = isQuestion && decision === 'accept' ? picks.map(answerFor) : undefined
      await socket.answerApproval(approval.requestId, decision, answers)
    } catch (err) {
      setError((err as Error).message)
      setBusy(null)
    }
  }

  const isCommand = approval.type === 'command'

  // Not dismissable: a turn is blocked until this is answered, so a stray tap
  // outside must not make the question disappear.
  return (
    <Sheet label={isQuestion ? '等待你的回答' : '等待你的授权'} onClose={() => {}} dismissable={false}>
      <div className="scroll-y max-h-[50dvh] px-5 pt-2 pb-2">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-warning" />
          <span className="text-xs font-semibold tracking-wide text-warning">
            {isQuestion ? '代理在问你' : '等待你的授权'}
          </span>
        </div>

        {/* For a question, the first question is the header and the form below
            repeats it — showing it twice reads as two questions. */}
        {!isQuestion && <h2 className="mb-3 text-base font-semibold leading-snug text-foreground">{approval.title}</h2>}

        {isQuestion && (
          <div className="space-y-4">
            {questions.map((question, index) => (
              <QuestionForm
                key={`${index}:${question.question}`}
                question={question}
                pick={picks[index]}
                onChoose={(label) => choose(index, label, question.multiSelect === true)}
                onType={(text) => type(index, text)}
              />
            ))}
          </div>
        )}

        {approval.detail && (
          <div className="mb-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {isCommand ? '即将执行的命令' : '详情'}
            </div>
            <pre className="scroll-x rounded-xl border border-border bg-secondary px-3.5 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground">
              {approval.detail}
            </pre>
          </div>
        )}

        {approval.cwd && (
          <div className="mb-2.5 truncate font-mono text-xs text-muted-foreground">工作目录：{approval.cwd}</div>
        )}

        {approval.reason && (
          <div className="mb-2.5 text-xs leading-relaxed text-foreground/90">原因：{approval.reason}</div>
        )}

        {error && <div className="mb-2 text-xs text-destructive">{error}</div>}
      </div>

      <div className="grid grid-cols-2 gap-2.5 px-4 pt-1 pb-2">
        {decisions.map((decision) => {
          const meta = (isQuestion ? QUESTION_DECISIONS : DECISIONS)[decision]
          if (!meta) return null
          // Submitting the form is the one button that must not look like the
          // others: it is the only one that sends the answers.
          const wide = isQuestion && decision === 'accept'
          return (
            <Button
              key={decision}
              type="button"
              variant={meta.variant}
              disabled={busy !== null || (wide && !answered)}
              onClick={() => answer(decision)}
              /* Two lines of text, so the base's single-line sizing has to go:
                 whitespace-nowrap would clip, and h-9 is too short. */
              className={`tap h-auto flex-col gap-0.5 rounded-2xl px-3 py-3 whitespace-normal ${
                wide ? 'col-span-2' : ''
              }`}
            >
              <span className="text-[14px] font-semibold leading-tight">
                {busy === decision ? '处理中…' : meta.label}
              </span>
              <span className="text-[11px] opacity-75">{wide && !answered ? '先给每个问题选一个答案' : meta.hint}</span>
            </Button>
          )
        })}
      </div>
    </Sheet>
  )
}

/**
 * One question: its options, and a line for the answer that is none of them.
 *
 * The free-text row is not a nicety. The agent picks the options, and the case
 * where the user wants something else entirely is the case this tool exists
 * for; without it the phone would be back to forcing a choice between two
 * things the user does not mean. It is the same affordance the CLI's own
 * terminal prompt offers.
 */
function QuestionForm({
  question,
  pick,
  onChoose,
  onType,
}: {
  question: ApprovalQuestion
  pick: Pick | undefined
  onChoose: (label: string) => void
  onType: (text: string) => void
}) {
  const multi = question.multiSelect === true
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-1.5">
        {question.header && (
          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
            {question.header}
          </span>
        )}
        <span className="text-[14px] font-medium leading-snug text-foreground">{question.question}</span>
        {multi && <span className="text-[11px] text-muted-foreground">可多选</span>}
      </div>

      <div className="space-y-1.5">
        {question.options.map((option) => {
          const on = pick?.labels.includes(option.label) ?? false
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => onChoose(option.label)}
              aria-pressed={on}
              className={`tap flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left ${
                on ? 'border-primary bg-primary/5' : 'border-border bg-transparent'
              }`}
            >
              {/* Decorative: the accessible name should be the label, not "○ Red". */}
              <span
                aria-hidden="true"
                className={`mt-0.5 text-[12px] ${on ? 'text-primary' : 'text-muted-foreground'}`}
              >
                {multi ? (on ? '☑' : '☐') : on ? '●' : '○'}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">{option.label}</span>
                {option.description && (
                  <span className="block text-[11px] leading-snug text-muted-foreground">{option.description}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <span className="shrink-0 text-[11px] text-muted-foreground">其他</span>
        <Input
          value={pick?.custom ?? ''}
          onChange={(e) => onType(e.target.value)}
          placeholder="自己输入…"
          className="h-8 text-[12px]"
        />
      </div>
    </div>
  )
}
