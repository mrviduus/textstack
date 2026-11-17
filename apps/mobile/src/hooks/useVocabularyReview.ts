import { useState, useCallback, useEffect, useRef } from 'react'
import { vocabularyApi } from '../lib/vocabularyApi'
import type { ReviewCardDto, SubmitReviewResponse, SelfAssessment, ReviewMode, WeeklyProgressDto } from '@textstack/shared'

export type { ReviewMode }

interface SessionStats {
  total: number
  correct: number
  reviewed: number
}

const EMPTY_STATS: SessionStats = { total: 0, correct: 0, reviewed: 0 }

export function useVocabularyReview() {
  const [cards, setCards] = useState<ReviewCardDto[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalDue, setTotalDue] = useState(0)
  const [weeklyProgress, setWeeklyProgress] = useState<WeeklyProgressDto | null>(null)
  const [sessionStats, setSessionStats] = useState<SessionStats>(EMPTY_STATS)
  const [lastResult, setLastResult] = useState<SubmitReviewResponse | null>(null)
  const [lastAnswerCorrect, setLastAnswerCorrect] = useState(false)
  const [answerRevealed, setAnswerRevealed] = useState(false)
  const [reviewMode, setReviewMode] = useState<ReviewMode>('classic')
  const [showingNewWord, setShowingNewWord] = useState(false)
  const [isPractice, setIsPractice] = useState(false)

  // Guards against state updates after unmount. The two async calls below
  // (getReviewQueue, submitReview) can resolve after the user has navigated
  // away from the review screen — without this, React logs an "update on
  // unmounted component" warning and we could resurrect the review session in
  // memory. Cheap insurance.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const resetAnswerState = useCallback(() => {
    setLastResult(null)
    setLastAnswerCorrect(false)
    setAnswerRevealed(false)
    setShowingNewWord(false)
  }, [])

  const showNewWordIfNeeded = useCallback((cardsList: ReviewCardDto[], idx: number) => {
    if (idx < cardsList.length && cardsList[idx].isNew) {
      setShowingNewWord(true)
    }
  }, [])

  const startSession = useCallback(async (limit?: number, rMode?: ReviewMode, practice?: boolean) => {
    if (rMode) setReviewMode(rMode)
    const practiceFlag = practice === true
    setIsPractice(practiceFlag)
    setLoading(true)
    setError(null)
    setCurrentIndex(0)
    resetAnswerState()
    try {
      const queue = await vocabularyApi.getReviewQueue(limit, practiceFlag)
      if (!mountedRef.current) return
      setCards(queue.cards)
      setTotalDue(queue.totalDue)
      setWeeklyProgress(queue.weeklyProgress ?? null)
      setSessionStats({ ...EMPTY_STATS, total: queue.cards.length })
      showNewWordIfNeeded(queue.cards, 0)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load review')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [resetAnswerState, showNewWordIfNeeded])

  const dismissNewWord = useCallback(() => {
    setShowingNewWord(false)
  }, [])

  const submitAnswer = useCallback(async (
    isCorrect: boolean,
    responseTimeMs: number,
    selfAssessment?: SelfAssessment,
  ) => {
    const card = cards[currentIndex]
    if (!card || submitting) return

    setSubmitting(true)
    try {
      const result = await vocabularyApi.submitReview({
        wordId: card.wordId,
        isCorrect,
        responseTimeMs,
        isPractice,
      })
      if (!mountedRef.current) return
      setLastResult(result)
      setLastAnswerCorrect(isCorrect)
      setAnswerRevealed(true)
      setSessionStats(prev => ({
        ...prev,
        reviewed: prev.reviewed + 1,
        correct: prev.correct + (isCorrect ? 1 : 0),
      }))
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to submit')
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [cards, currentIndex, submitting, isPractice])

  const nextCard = useCallback(() => {
    const nextIdx = currentIndex + 1
    setCurrentIndex(nextIdx)
    resetAnswerState()
    showNewWordIfNeeded(cards, nextIdx)
  }, [currentIndex, cards, resetAnswerState, showNewWordIfNeeded])

  const currentCard = cards[currentIndex] || null
  const isSessionComplete = currentIndex >= cards.length && cards.length > 0
  const hasCards = cards.length > 0

  return {
    cards,
    currentCard,
    currentIndex,
    totalDue,
    weeklyProgress,
    loading,
    submitting,
    error,
    sessionStats,
    lastResult,
    lastAnswerCorrect,
    answerRevealed,
    isSessionComplete,
    hasCards,
    reviewMode,
    showingNewWord,
    isPractice,
    startSession,
    submitAnswer,
    nextCard,
    dismissNewWord,
    setReviewMode,
  }
}
