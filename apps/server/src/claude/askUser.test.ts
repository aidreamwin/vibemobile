import { describe, expect, it } from 'vitest'
import { answersFor, questionsFrom } from './askUser.js'

/**
 * The inputs below are the frames the CLI actually sent, copied out of a probe
 * run on this machine rather than written from the SDK's type declarations —
 * the types are what the CLI is supposed to send, and the whole reason this
 * file exists is that the two are not always the same thing.
 */
const SINGLE = {
  questions: [
    {
      question: 'Which colour do you prefer?',
      header: 'Colour',
      options: [
        { label: 'Red', description: 'Red' },
        { label: 'Blue', description: 'Blue' },
      ],
      multiSelect: false,
    },
  ],
}

const MULTI = {
  questions: [
    {
      question: 'Which colours do you like?',
      header: 'Colours',
      options: [
        { label: 'Red', description: 'Red' },
        { label: 'Blue', description: 'Blue' },
        { label: 'Green', description: 'Green' },
      ],
      multiSelect: true,
    },
  ],
}

describe('questionsFrom', () => {
  it('reads a captured single-choice question', () => {
    expect(questionsFrom(SINGLE)).toEqual([
      {
        question: 'Which colour do you prefer?',
        header: 'Colour',
        multiSelect: undefined,
        options: [
          { label: 'Red', description: 'Red' },
          { label: 'Blue', description: 'Blue' },
        ],
      },
    ])
  })

  it('keeps multiSelect only when the CLI set it', () => {
    expect(questionsFrom(MULTI)?.[0].multiSelect).toBe(true)
    expect(questionsFrom(SINGLE)?.[0].multiSelect).toBeUndefined()
  })

  it('keeps several questions in order, since the answers line up positionally', () => {
    const two = { questions: [SINGLE.questions[0], { ...SINGLE.questions[0], question: 'And the second?' }] }
    expect(questionsFrom(two)?.map((q) => q.question)).toEqual(['Which colour do you prefer?', 'And the second?'])
  })

  it('drops a description the CLI left out rather than inventing one', () => {
    const bare = { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
    expect(questionsFrom(bare)?.[0].options).toEqual([
      { label: 'A', description: undefined },
      { label: 'B', description: undefined },
    ])
  })

  /**
   * The fallback matters: `undefined` sends the caller back to the ordinary
   * approval sheet, which shows the raw input. A form built from this would be
   * one the user cannot submit, which is a worse failure than not offering one.
   */
  it.each([
    ['not an object', 'AskUserQuestion'],
    ['no questions array', {}],
    ['an empty list', { questions: [] }],
    ['a question with no text', { questions: [{ options: [{ label: 'A' }, { label: 'B' }] }] }],
    ['a question with one option', { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] }],
    ['a question with no options', { questions: [{ question: 'Which?' }] }],
    ['options that are not labels', { questions: [{ question: 'Which?', options: [{}, {}] }] }],
  ])('refuses %s, so the generic sheet takes over', (_name, input) => {
    expect(questionsFrom(input)).toBeUndefined()
  })
})

describe('answersFor', () => {
  it('files one choice under its question text', () => {
    const questions = questionsFrom(SINGLE)!
    // Exactly the payload that made the CLI hand "Blue" to the model.
    expect(answersFor(questions, [['Blue']])).toEqual({ 'Which colour do you prefer?': 'Blue' })
  })

  it('joins a multi choice the way the SDK documents it', () => {
    const questions = questionsFrom(MULTI)!
    expect(answersFor(questions, [['Red', 'Blue']])).toEqual({
      'Which colours do you like?': 'Red, Blue',
    })
  })

  it('passes free text straight through', () => {
    const questions = questionsFrom(SINGLE)!
    expect(answersFor(questions, [['Purple, actually']])).toEqual({
      'Which colour do you prefer?': 'Purple, actually',
    })
  })

  it('answers every question, keyed by its own text', () => {
    const two = {
      questions: [SINGLE.questions[0], { question: 'Which size?', options: [{ label: 'S' }, { label: 'L' }] }],
    }
    const questions = questionsFrom(two)!
    expect(answersFor(questions, [['Blue'], ['L']])).toEqual({
      'Which colour do you prefer?': 'Blue',
      'Which size?': 'L',
    })
  })

  /**
   * Every `null` here is a path back to a decline on the server. Returning a
   * half-built object instead would put the turn right back in the state this
   * whole feature was written to fix: allowed, and the model told nothing.
   */
  it.each([
    ['nothing at all', undefined],
    ['fewer answers than questions', []],
    ['more answers than questions', [['Blue'], ['Red']]],
    ['an empty selection', [[]]],
    ['a blank label', [['   ']]],
    ['two choices on a single-choice question', [['Red', 'Blue']]],
  ])('refuses %s', (_name, answers) => {
    expect(answersFor(questionsFrom(SINGLE)!, answers)).toBeNull()
  })

  it('allows several choices only where the question asked for them', () => {
    expect(answersFor(questionsFrom(MULTI)!, [['Red', 'Blue']])).not.toBeNull()
    expect(answersFor(questionsFrom(SINGLE)!, [['Red', 'Blue']])).toBeNull()
  })
})
