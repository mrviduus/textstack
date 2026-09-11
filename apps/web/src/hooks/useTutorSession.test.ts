import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../api/tutor', () => ({
  startTutorSession: vi.fn(),
  sendTutorAnswer: vi.fn(),
  sendTutorFeedback: vi.fn(),
}))
vi.mock('../lib/dataEvents', () => ({ emitDataChange: vi.fn() }))

import { startTutorSession, sendTutorAnswer, sendTutorFeedback, type TutorPlanItem } from '../api/tutor'
import { useTutorSession, buildPlanCard, buildQueue, isSessionComplete } from './useTutorSession'

const mockStart = startTutorSession as unknown as ReturnType<typeof vi.fn>
const mockFeedback = sendTutorFeedback as unknown as ReturnType<typeof vi.fn>
const mockAnswer = sendTutorAnswer as unknown as ReturnType<typeof vi.fn>

// Enriched plan item — self-sufficient, no vocab fetch needed.
const planItem = (id: string, word: string, over: Partial<TutorPlanItem> = {}): TutorPlanItem => ({
  wordId: id, word, stage: 1, exerciseType: 'recognition', difficulty: 'easy', why: `study ${word}`,
  translation: `${word}-tr`, definition: null, sentence: `a ${word} sentence`, bookTitle: 'Some Book',
  hint: null, distractors: [], ...over,
})

describe('tutor pure logic', () => {
  it('buildPlanCard projects an enriched plan item onto a flashcard when it carries no options', () => {
    const card = buildPlanCard(planItem('w1', 'foo'))
    expect(card).toMatchObject({
      wordId: 'w1', word: 'foo', translation: 'foo-tr',
      originalSentence: 'a foo sentence', bookTitle: 'Some Book',
    })
    expect(card.options).toBeNull()
  })

  it('buildPlanCard carries the options and the cloze the server built', () => {
    // The whole point of the change: exerciseType is calibrated server-side and used to be rendered
    // as a badge over a card that was identical for all three types. The options and the blanked
    // sentence now come down with the item, and this projection must not drop them — dropping them
    // is exactly what it used to do, with `options: null` hardcoded.
    const card = buildPlanCard(planItem('w1', 'foo', {
      exerciseType: 'context',
      options: ['bar', 'foo', 'baz', 'qux'],
      correctOptionIndex: 1,
      blankSentence: 'a ____ sentence',
    }))

    expect(card.options).toEqual(['bar', 'foo', 'baz', 'qux'])
    expect(card.correctOptionIndex).toBe(1)
    expect(card.blankSentence).toBe('a ____ sentence')
  })

  it('buildPlanCard ignores a correct index that arrives without options', () => {
    // An index into a list that is not there would index `undefined` in the card component. Better
    // to render the flashcard the payload actually supports.
    const card = buildPlanCard(planItem('w1', 'foo', { correctOptionIndex: 2 }))

    expect(card.options).toBeNull()
    expect(card.correctOptionIndex).toBeNull()
  })

  it('buildPlanCard tolerates missing optional fields (null, not undefined)', () => {
    const card = buildPlanCard(planItem('w1', 'foo', { translation: undefined, sentence: undefined, bookTitle: undefined, hint: undefined }))
    expect(card.translation).toBeNull()
    expect(card.originalSentence).toBeNull()
    expect(card.bookTitle).toBeNull()
    expect(card.hint).toBeNull()
  })

  it('buildQueue keeps every enriched item (no join, nothing dropped)', () => {
    const plan = [planItem('w1', 'a'), planItem('w2', 'b')]
    const queue = buildQueue(plan)
    expect(queue).toHaveLength(2)
    expect(queue.map(q => q.item.wordId)).toEqual(['w1', 'w2'])
    expect(queue[0].card.word).toBe('a')
  })

  it('isSessionComplete is true only for an empty plan', () => {
    expect(isSessionComplete([])).toBe(true)
    expect(isSessionComplete([planItem('w1', 'a')])).toBe(false)
  })
})

describe('useTutorSession flow', () => {
  beforeEach(() => {
    mockStart.mockReset()
    mockFeedback.mockReset()
    mockAnswer.mockReset()
    mockAnswer.mockResolvedValue({ applied: true })
  })

  it('start with an empty plan → empty phase (not an error), no vocab fetch', async () => {
    mockStart.mockResolvedValue({ sessionId: 's1', plan: [], rationale: 'r', readingNudge: 'read', runId: 'run1' })
    const { result } = renderHook(() => useTutorSession())

    await act(async () => { await result.current.start() })

    expect(result.current.phase).toBe('empty')
    expect(result.current.readingNudge).toBe('read')
  })

  it('start → plan phase, queue built straight from the enriched plan', async () => {
    mockStart.mockResolvedValue({
      sessionId: 's1', plan: [planItem('w1', 'a'), planItem('w2', 'b')],
      rationale: 'here is why', readingNudge: 'keep reading', runId: 'run1',
    })

    const { result } = renderHook(() => useTutorSession())
    await act(async () => { await result.current.start() })

    expect(result.current.phase).toBe('plan')
    expect(result.current.turn?.queue).toHaveLength(2)
    expect(result.current.turn?.queue[0].card.translation).toBe('a-tr')
    expect(result.current.turn?.rationale).toBe('here is why')
  })

  it('study → answers accumulate → empty re-plan ends in summary', async () => {
    mockStart.mockResolvedValue({
      sessionId: 's1', plan: [planItem('w1', 'a')],
      rationale: 'r', readingNudge: 'nudge', runId: 'run1',
    })
    mockFeedback.mockResolvedValue({ sessionId: 's1', plan: [], rationale: 'r2', readingNudge: 'final nudge', runId: 'run2' })

    const { result } = renderHook(() => useTutorSession())
    await act(async () => { await result.current.start() })

    act(() => { result.current.beginStudy() })
    expect(result.current.phase).toBe('study')

    await act(async () => { result.current.answer(true, 900) })

    await waitFor(() => expect(result.current.phase).toBe('summary'))
    expect(result.current.stats).toEqual({ studied: 1, correct: 1 })
    expect(result.current.readingNudge).toBe('final nudge')
    expect(mockFeedback).toHaveBeenCalledWith('s1', [{ wordId: 'w1', correct: true, responseTimeMs: 900 }], expect.anything())
  })

  it('non-empty re-plan continues with adjusted plan', async () => {
    mockStart.mockResolvedValue({
      sessionId: 's1', plan: [planItem('w1', 'a')], rationale: 'r1', readingNudge: 'n1', runId: 'run1',
    })
    mockFeedback.mockResolvedValue({
      sessionId: 's1', plan: [planItem('w2', 'b')], rationale: 'adjusted reasoning', readingNudge: 'n2', runId: 'run2',
    })

    const { result } = renderHook(() => useTutorSession())
    await act(async () => { await result.current.start() })
    act(() => { result.current.beginStudy() })
    await act(async () => { result.current.answer(false, 500) })

    await waitFor(() => expect(result.current.phase).toBe('plan'))
    expect(result.current.adjusted).toBe(true)
    expect(result.current.turn?.rationale).toBe('adjusted reasoning')
    expect(result.current.turn?.queue[0].item.wordId).toBe('w2')
  })

  it('client round cap: a server that never stops re-planning is forced to summary', async () => {
    mockStart.mockResolvedValue({
      sessionId: 's1', plan: [planItem('w1', 'a')], rationale: 'r', readingNudge: 'n', runId: 'run1',
    })
    // Always hand back one more item — would loop forever without the client backstop.
    mockFeedback.mockResolvedValue({
      sessionId: 's1', plan: [planItem('w1', 'a')], rationale: 'again', readingNudge: 'n', runId: 'run2',
    })

    const { result } = renderHook(() => useTutorSession())
    await act(async () => { await result.current.start() })

    // Drive enough rounds to exceed MAX_ROUNDS (8). Each round: study → answer → re-plan.
    for (let i = 0; i < 10; i++) {
      if (result.current.phase === 'summary') break
      act(() => { result.current.beginStudy() })
      await act(async () => { result.current.answer(true, 100) })
      await waitFor(() => expect(['plan', 'summary']).toContain(result.current.phase))
    }

    expect(result.current.phase).toBe('summary')
    expect(mockFeedback.mock.calls.length).toBeLessThanOrEqual(9)
  })

  it('start failure → error phase with planning origin', async () => {
    mockStart.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useTutorSession())
    await act(async () => { await result.current.start() })
    expect(result.current.phase).toBe('error')
    expect(result.current.error).toBe('boom')
    expect(result.current.errorOrigin).toBe('planning')
  })

  it('feedback failure → retry re-submits SAME session results (no new session)', async () => {
    mockStart.mockResolvedValue({
      sessionId: 's1', plan: [planItem('w1', 'a')], rationale: 'r', readingNudge: 'n', runId: 'run1',
    })
    mockFeedback.mockRejectedValueOnce(new Error('network'))

    const { result } = renderHook(() => useTutorSession())
    await act(async () => { await result.current.start() })
    act(() => { result.current.beginStudy() })
    await act(async () => { result.current.answer(true, 700) })

    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.errorOrigin).toBe('feedback')

    // Retry should re-POST feedback for the SAME session, not call startTutorSession again.
    mockFeedback.mockResolvedValueOnce({ sessionId: 's1', plan: [], rationale: 'r2', readingNudge: 'done', runId: 'run2' })
    await act(async () => { result.current.retry() })

    await waitFor(() => expect(result.current.phase).toBe('summary'))
    expect(mockStart).toHaveBeenCalledTimes(1) // only the initial plan
    expect(mockFeedback).toHaveBeenCalledTimes(2) // failed + retried
    expect(mockFeedback).toHaveBeenLastCalledWith('s1', [{ wordId: 'w1', correct: true, responseTimeMs: 700 }], expect.anything())
  })
})

describe('useTutorSession — answers are recorded as they are given', () => {
  beforeEach(() => {
    mockStart.mockReset()
    mockFeedback.mockReset()
    mockAnswer.mockReset()
    mockAnswer.mockResolvedValue({ applied: true })
  })

  it('posts each answer immediately, not only at the end of the session', async () => {
    // Feedback fires on the last card, so before this a learner who left
    // mid-session lost the work they had already done — which became a real
    // loss once these answers started counting toward spaced repetition.
    mockStart.mockResolvedValue({
      sessionId: 's1', plan: [planItem('w1', 'a'), planItem('w2', 'b')],
      rationale: 'r', readingNudge: 'read', runId: 'run1',
    })

    const { result } = renderHook(() => useTutorSession())
    await act(async () => { await result.current.start() })
    act(() => { result.current.beginStudy() })
    await act(async () => { result.current.answer(true, 900) })

    // One of two cards answered — the session is not over, and the write has
    // already happened.
    await waitFor(() => expect(mockAnswer).toHaveBeenCalledTimes(1))
    expect(mockAnswer.mock.calls[0][1]).toMatchObject({ wordId: 'w1', correct: true })
    expect(mockFeedback).not.toHaveBeenCalled()
  })

  it('keeps going when the immediate write fails', async () => {
    // Fire-and-forget: the closing feedback call re-sends everything and the
    // server de-duplicates, so a failed write must not stall the card.
    mockAnswer.mockRejectedValue(new Error('offline'))
    mockStart.mockResolvedValue({
      sessionId: 's1', plan: [planItem('w1', 'a'), planItem('w2', 'b')],
      rationale: 'r', readingNudge: 'read', runId: 'run1',
    })

    const { result } = renderHook(() => useTutorSession())
    await act(async () => { await result.current.start() })
    act(() => { result.current.beginStudy() })
    await act(async () => { result.current.answer(false, 700) })

    expect(result.current.stats).toEqual({ studied: 1, correct: 0 })
    expect(result.current.phase).toBe('study')
  })
})
