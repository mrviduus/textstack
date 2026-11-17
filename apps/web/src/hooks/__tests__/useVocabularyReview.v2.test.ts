import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const getReviewQueue = vi.fn()
const submitReview = vi.fn()
vi.mock('../../api/vocabulary', () => ({
  getReviewQueue: (...a: unknown[]) => getReviewQueue(...a),
  submitReview: (...a: unknown[]) => submitReview(...a),
}))

import { useVocabularyReview } from '../useVocabularyReview'

const cardRow = { wordId: 'w1', word: 'quiver', translation: null, definition: null, reviewMode: 'flashcard', blankSentence: null,
  originalSentence: null, bookTitle: null, hint: null, explanation: null, isNew: false, options: null, correctOptionIndex: null }

beforeEach(() => {
  getReviewQueue.mockReset().mockResolvedValue({ cards: [cardRow], totalDue: 1, weeklyProgress: null })
  submitReview.mockReset()
})

describe('useVocabularyReview', () => {
  it('retries a failed answer under the same operation id', async () => {
    submitReview.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      wordId: 'w1', previousStage: 0, newStage: 1, stageChanged: true, nextIntervalDays: 1, nextReviewAt: '', totalReviews: 0, correctReviews: 0,
    })
    const { result } = renderHook(() => useVocabularyReview())
    await act(() => result.current.startSession(10))

    await act(() => result.current.submitAnswer(true, 900))
    await act(() => result.current.submitAnswer(true, 900))

    const [first, second] = submitReview.mock.calls.map((c) => c[0] as { operationId: string; isCorrect: boolean; responseTimeMs: number })
    expect(first.operationId).toBeTruthy()
    expect(second.operationId).toBe(first.operationId)
    expect(second).toMatchObject({ isCorrect: true, responseTimeMs: 900 })
  })
})
