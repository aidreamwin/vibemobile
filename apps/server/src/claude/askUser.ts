/**
 * `AskUserQuestion` — the one Claude tool that asks a question instead of
 * asking permission, and the two conversions that go with it.
 *
 * ── Why this needed its own file ────────────────────────────────────────────
 * The tool arrives through the same `canUseTool` door as every other tool, so
 * for a while it was rendered by the same sheet: a title, the raw questions
 * JSON, and 允许 / 拒绝. Tapping 允许 resolved it as `{behavior:'allow'}` with
 * the input unchanged, and the CLI then told the model the user had not
 * answered — measured verbatim on this machine, not inferred:
 *
 *   tool_result: The user did not answer the questions.
 *
 * So the phone could not answer, only dismiss. Answering means sending the
 * choice back INSIDE the input (`updatedInput.answers`), which is the shape
 * this file builds: the SDK declares `answers?: {[questionText]: string}` as
 * "user answers collected by the permission component", and both a single and
 * a multi choice were driven end to end:
 *
 *   {"answers":{"Which colour do you prefer?":"Blue"}}      → COLOUR=Blue
 *   {"answers":{"Which colours do you like?":"Red, Blue"}}  → COLOURS=Red, Blue
 *
 * A question's sheet is therefore a form, and the verdict buttons are wrong for
 * it — which is why the provider advertises `userInput` instead of `other` and
 * `questions` alongside it, and why the web sheet switches shape on that field.
 *
 * ── Who owns what ───────────────────────────────────────────────────────────
 * The wire speaks positionally: `answers[i]` belongs to `questions[i]`, each a
 * list of chosen labels. Turning that into the provider's own vocabulary is
 * this file's job — the protocol stays free of any one agent's quirks, and this
 * pair of functions stays testable without spawning a CLI.
 */
import type { ApprovalQuestion } from '@vibemobile/protocol'

/** Both spellings are live for the subagent tool; this one has a single name. */
export const ASK_USER_TOOL = 'AskUserQuestion'

/**
 * Read the tool input into the protocol's question shape, or `undefined` when
 * there is nothing a form could render.
 *
 * Defensive because the input is model-authored JSON: anything malformed has to
 * fall back to the ordinary approval sheet (which shows the raw input) rather
 * than produce a form whose submit button can never be satisfied.
 */
export function questionsFrom(input: unknown): ApprovalQuestion[] | undefined {
  const raw = (input as { questions?: unknown } | null | undefined)?.questions
  if (!Array.isArray(raw) || raw.length === 0) return undefined

  const questions: ApprovalQuestion[] = []
  for (const item of raw) {
    const q = item as Record<string, unknown> | null
    const question = typeof q?.question === 'string' ? q.question.trim() : ''
    if (!question) return undefined

    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o: any) => ({
        label: typeof o?.label === 'string' ? o.label.trim() : '',
        description: typeof o?.description === 'string' ? o.description : undefined,
      }))
      .filter((o) => o.label)
    // The schema promises 2–4; one option is not a question, and zero is a
    // question with no way to answer it.
    if (options.length < 2) return undefined

    questions.push({
      question,
      header: typeof q?.header === 'string' && q.header.trim() ? q.header.trim() : undefined,
      multiSelect: q?.multiSelect === true ? true : undefined,
      options,
    })
  }
  return questions
}

/**
 * Encode the phone's choices for the SDK, or `null` when they do not line up.
 *
 * `null` is a refusal to guess: the caller turns it into a decline. Answering
 * `{behavior:'allow'}` with an input the SDK cannot read back is exactly the
 * bug this file exists to remove, so an answer that is incomplete, over-long,
 * or that picks several options on a single-choice question is treated as no
 * answer at all rather than as the first plausible thing in the list.
 */
export function answersFor(
  questions: ApprovalQuestion[],
  answers: string[][] | undefined,
): Record<string, string> | null {
  if (!Array.isArray(answers) || answers.length !== questions.length) return null

  const out: Record<string, string> = {}
  for (const [i, question] of questions.entries()) {
    const picked = (Array.isArray(answers[i]) ? answers[i] : [])
      .filter((label): label is string => typeof label === 'string')
      .map((label) => label.trim())
      .filter(Boolean)
    if (picked.length === 0) return null
    if (picked.length > 1 && !question.multiSelect) return null
    // Comma-joined, which is what the SDK documents for a multi choice and
    // what the CLI echoed back as the model's answer on the probe above.
    out[question.question] = picked.join(', ')
  }
  return out
}
