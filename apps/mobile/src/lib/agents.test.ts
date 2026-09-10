import { describe, it, expect } from 'vitest'
import {
  buildPlanCard,
  buildQueue,
  isSessionComplete,
  exerciseLabel,
  exerciseBadgeColor,
  type TutorPlanItem,
} from './agents'

function planItem(overrides: Partial<TutorPlanItem> = {}): TutorPlanItem {
  return {
    wordId: 'w1',
    word: 'ephemeral',
    stage: 2,
    exerciseType: 'recall',
    difficulty: 'Medium',
    why: 'You missed this last time.',
    translation: 'тимчасовий',
    definition: 'lasting a very short time',
    sentence: 'An ephemeral moment of joy.',
    bookTitle: 'Some Book',
    hint: 'starts with e',
    distractors: ['a', 'b'],
    ...overrides,
  }
}

describe('buildPlanCard', () => {
  it('projects an enriched plan item into a context-mode ReviewCardDto', () => {
    const card = buildPlanCard(planItem())
    expect(card).toMatchObject({
      wordId: 'w1',
      word: 'ephemeral',
      translation: 'тимчасовий',
      definition: 'lasting a very short time',
      reviewMode: 'context',
      originalSentence: 'An ephemeral moment of joy.',
      bookTitle: 'Some Book',
      hint: 'starts with e',
      isNew: false,
      blankSentence: null,
      explanation: null,
      options: null,
      correctOptionIndex: null,
    })
  })

  it('coerces missing optional fields to null (never undefined)', () => {
    const card = buildPlanCard(planItem({
      translation: undefined,
      definition: undefined,
      sentence: undefined,
      bookTitle: undefined,
      hint: undefined,
    }))
    expect(card.translation).toBeNull()
    expect(card.definition).toBeNull()
    expect(card.originalSentence).toBeNull()
    expect(card.bookTitle).toBeNull()
    expect(card.hint).toBeNull()
  })
})

describe('buildQueue', () => {
  it('produces one entry per plan item, preserving order, nothing dropped', () => {
    const plan = [planItem({ wordId: 'a' }), planItem({ wordId: 'b' }), planItem({ wordId: 'c' })]
    const queue = buildQueue(plan)
    expect(queue).toHaveLength(3)
    expect(queue.map(q => q.item.wordId)).toEqual(['a', 'b', 'c'])
    expect(queue.map(q => q.card.wordId)).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty queue for an empty plan', () => {
    expect(buildQueue([])).toEqual([])
  })
})

describe('isSessionComplete', () => {
  it('is true only when the re-plan is empty', () => {
    expect(isSessionComplete([])).toBe(true)
    expect(isSessionComplete([planItem()])).toBe(false)
  })
})

describe('exerciseLabel', () => {
  const t = (key: string) => `i18n:${key}`

  it('uses the i18n key for known exercise types', () => {
    expect(exerciseLabel('recognition', t)).toBe('i18n:tutor.exercise.recognition')
    expect(exerciseLabel('recall', t)).toBe('i18n:tutor.exercise.recall')
    expect(exerciseLabel('context', t)).toBe('i18n:tutor.exercise.context')
  })

  it('falls back to the raw value for an unknown model type (no leaked i18n key)', () => {
    expect(exerciseLabel('cloze_madness', t)).toBe('cloze_madness')
  })

  it('falls back to a generic label for blank/whitespace types', () => {
    expect(exerciseLabel('', t)).toBe('i18n:tutor.exercise.generic')
    expect(exerciseLabel('   ', t)).toBe('i18n:tutor.exercise.generic')
  })
})

describe('exerciseBadgeColor', () => {
  const palette = { recognition: '#a', recall: '#b', context: '#c', fallback: '#z' }

  it('maps known types to their accent', () => {
    expect(exerciseBadgeColor('recognition', palette)).toBe('#a')
    expect(exerciseBadgeColor('recall', palette)).toBe('#b')
    expect(exerciseBadgeColor('context', palette)).toBe('#c')
  })

  it('maps unknown types to the fallback', () => {
    expect(exerciseBadgeColor('???', palette)).toBe('#z')
  })
})
