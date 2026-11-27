import { useState, useCallback, useRef } from 'react'
import type { ReviewCardDto, SelfAssessment, SubmitReviewResponse } from '../api/vocabulary'
import { platform } from '../platform'
import type { ReviewMode } from '@textstack/shared'

/** Sessions run as flashcards: multiple choice needs server-made distractors, which V2 has none of. */
const REVIEW_MODE: ReviewMode = 'classic'

interface SessionStats {
  total: number
  correct: number
  reviewed: number
}

const EMPTY_STATS: SessionStats = { total: 0, correct: 0, reviewed: 0 }

export function useVocabularyReview() {
  const [cards, setCards] = useState<ReviewCardDto[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalDue, setTotalDue] = useState(0)
  const [sessionStats, setSessionStats] = useState<SessionStats>(EMPTY_STATS)
  const [lastResult, setLastResult] = useState<SubmitReviewResponse | null>(null)
  const [lastAnswerCorrect, setLastAnswerCorrect] = useState(false)
  const [answerRevealed, setAnswerRevealed] = useState(false)
  const [showingNewWord, setShowingNewWord] = useState(false)
  const [wrongCards, setWrongCards] = useState<ReviewCardDto[]>([])
  const [isPractice, setIsPractice] = useState(false)

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

  const startSession = useCallback(async (limit?: number, practice?: boolean) => {
    const practiceFlag = practice === true
    setIsPractice(practiceFlag)
    setLoading(true)
    setError(null)
    setCurrentIndex(0)
    setWrongCards([])
    resetAnswerState()
    try {
      const queue = await platform.vocabulary.getReviewQueue(limit, true)
      setCards(queue.cards)
      setTotalDue(queue.totalDue)
      setSessionStats({ ...EMPTY_STATS, total: queue.cards.length })
      showNewWordIfNeeded(queue.cards, 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load review')
    } finally {
      setLoading(false)
    }
  }, [resetAnswerState, showNewWordIfNeeded])

  const dismissNewWord = useCallback(() => {
    setShowingNewWord(false)
  }, [])

  // The answer's operation id (V2): minted once per card shown, reused if the submit is retried.
  const answerOpRef = useRef<{ key: string; id: string } | null>(null)

  const submitAnswer = useCallback(async (
    isCorrect: boolean,
    responseTimeMs: number,
    selfAssessment?: SelfAssessment,
  ) => {
    const card = cards[currentIndex]
    if (!card || submitting) return

    setSubmitting(true)
    const key = `${currentIndex}:${card.wordId}:${cards.length}`
    if (answerOpRef.current?.key !== key) answerOpRef.current = { key, id: crypto.randomUUID() }
    try {
      const result = await platform.vocabulary.submitReview({
        operationId: answerOpRef.current.id,
        wordId: card.wordId,
        isCorrect,
        responseTimeMs,
        selfAssessment,
        isPractice,
        reviewMode: REVIEW_MODE,
      })
      setLastResult(result)
      setLastAnswerCorrect(isCorrect)
      setAnswerRevealed(true)
      setSessionStats(prev => ({
        ...prev,
        reviewed: prev.reviewed + 1,
        correct: prev.correct + (isCorrect ? 1 : 0),
      }))
      if (!isCorrect) {
        setWrongCards(prev => {
          if (prev.some(c => c.wordId === card.wordId)) return prev
          return [...prev, card]
        })
      }
      window.dispatchEvent(new Event('vocab-review-submitted'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }, [cards, currentIndex, submitting, isPractice])

  const nextCard = useCallback(() => {
    const nextIdx = currentIndex + 1
    setCurrentIndex(nextIdx)
    resetAnswerState()
    showNewWordIfNeeded(cards, nextIdx)
  }, [currentIndex, cards, resetAnswerState, showNewWordIfNeeded])

  const retryWrong = useCallback(() => {
    if (wrongCards.length === 0) return
    const retryCards = wrongCards.map(c => ({ ...c, isNew: false }))
    setCards(retryCards)
    setCurrentIndex(0)
    setWrongCards([])
    setSessionStats(prev => ({ ...prev, total: prev.total + retryCards.length }))
    resetAnswerState()
    showNewWordIfNeeded(retryCards, 0)
  }, [wrongCards, resetAnswerState, showNewWordIfNeeded])

  const currentCard = cards[currentIndex] || null
  const isSessionComplete = currentIndex >= cards.length && cards.length > 0
  const hasCards = cards.length > 0

  return {
    cards,
    currentCard,
    currentIndex,
    totalDue,
    loading,
    submitting,
    error,
    sessionStats,
    lastResult,
    lastAnswerCorrect,
    answerRevealed,
    isSessionComplete,
    hasCards,
    showingNewWord,
    wrongCards,
    isPractice,
    startSession,
    submitAnswer,
    nextCard,
    dismissNewWord,
    retryWrong,
  }
}
