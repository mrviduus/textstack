import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initApi } from './client'
import {
  startTutorSession,
  sendTutorFeedback,
  buildPlanCard,
  buildQueue,
  isSessionComplete,
  exerciseLabel,
  type TutorPlanItem,
} from './tutor'

// Web and mobile both run this module; its tests live here once (moved from web
// api/__tests__/tutor.test.ts + hooks/useTutorSession.test.ts and mobile lib/agents.test.ts).

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

describe('tutor api', () => {
  function mockOk(body: unknown) {
    return vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  }

  const SAMPLE = {
    sessionId: 's1',
    plan: [{ wordId: 'w1', word: 'foo', stage: 1, exerciseType: 'recognition', difficulty: 'easy', why: 'because' }],
    rationale: 'plan',
    readingNudge: 'read more',
    runId: 'r1',
  }

  beforeEach(() => {
    // Cookie mode, as web runs it.
    initApi({ baseUrl: 'http://api', getAccessToken: async () => null, onUnauthorized: async () => null, credentials: 'include' })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('startTutorSession POSTs maxItems and returns parsed response', async () => {
    const fetchMock = mockOk(SAMPLE)
    vi.stubGlobal('fetch', fetchMock)

    const res = await startTutorSession(7)

    expect(res.sessionId).toBe('s1')
    expect(res.plan).toHaveLength(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/me/tutor/session')
    expect(opts.method).toBe('POST')
    expect(opts.credentials).toBe('include')
    expect(JSON.parse(opts.body)).toEqual({ maxItems: 7 })
  })

  it('startTutorSession sends empty body when maxItems omitted', async () => {
    const fetchMock = mockOk(SAMPLE)
    vi.stubGlobal('fetch', fetchMock)

    await startTutorSession()

    const [, opts] = fetchMock.mock.calls[0]
    expect(JSON.parse(opts.body)).toEqual({})
  })

  it('sendTutorFeedback POSTs results to the session feedback URL', async () => {
    const fetchMock = mockOk({ ...SAMPLE, plan: [] })
    vi.stubGlobal('fetch', fetchMock)

    const results = [{ wordId: 'w1', correct: true, responseTimeMs: 1234 }]
    const res = await sendTutorFeedback('s1', results)

    expect(res.plan).toHaveLength(0)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/me/tutor/session/s1/feedback')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ results })
  })

  it('rejects on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: 'no tutor' }),
    }))

    await expect(startTutorSession()).rejects.toThrow('no tutor')
  })
})

describe('buildPlanCard', () => {
  it('projects an enriched plan item into a context-mode ReviewCardDto (flashcard when it carries no options)', () => {
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

  it('carries the options and the cloze the server built', () => {
    // exerciseType is calibrated server-side and used to be rendered as a badge over a card that
    // was identical for all three types. The options and the blanked sentence now come down with
    // the item, and this projection must not drop them — dropping them is exactly what it used to
    // do, with `options: null` hardcoded.
    const card = buildPlanCard(planItem({
      exerciseType: 'context',
      options: ['bar', 'foo', 'baz', 'qux'],
      correctOptionIndex: 1,
      blankSentence: 'a ____ sentence',
    }))

    expect(card.options).toEqual(['bar', 'foo', 'baz', 'qux'])
    expect(card.correctOptionIndex).toBe(1)
    expect(card.blankSentence).toBe('a ____ sentence')
  })

  it('ignores a correct index that arrives without options', () => {
    // An index into a list that is not there would index `undefined` in the card component. Better
    // to render the flashcard the payload actually supports.
    const card = buildPlanCard(planItem({ correctOptionIndex: 2 }))

    expect(card.options).toBeNull()
    expect(card.correctOptionIndex).toBeNull()
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
