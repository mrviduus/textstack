import { useState, useCallback, useRef, useEffect } from 'react'
import {
  startTutorSession,
  sendTutorAnswer,
  sendTutorFeedback,
  type TutorPlanItem,
  type TutorSessionResponse,
  type TutorFeedbackResult,
} from '../api/tutor'
import { type ReviewCardDto } from '../api/vocabulary'
import { emitDataChange } from '../lib/dataEvents'

// Phase of the tutor flow the page renders.
export type TutorPhase = 'idle' | 'planning' | 'plan' | 'study' | 'summary' | 'empty' | 'error'

export interface TutorSessionStats {
  studied: number
  correct: number
}

// Origin of an error so the error view can retry the RIGHT thing:
//  - 'planning' → re-plan a fresh session via start()
//  - 'feedback' → re-submit the SAME session's pending results (don't lose progress)
export type TutorErrorOrigin = 'planning' | 'feedback'

const EMPTY_STATS: TutorSessionStats = { studied: 0, correct: 0 }

// Belt-and-suspenders cap on the re-plan loop. The server also caps turns, but never trust it to stop.
const MAX_ROUNDS = 8

/**
 * Projects an ENRICHED plan item into the card the learner is shown. Pure, unit-tested.
 *
 * <p>This used to hardcode `options: null` and `blankSentence: null` and hand everything to a
 * flashcard — so the exercise type the server had calibrated from the SRS stage reached the screen as
 * a coloured badge and changed nothing else. The options and the cloze are now built server-side, by
 * the same builder the review flow uses, and this is the projection that carries them.</p>
 *
 * <p>The component is chosen from `options`, never from `reviewMode` — that field is vestigial by
 * contract (see its comment in the shared DTO) and nothing may be built on it.</p>
 */
export function buildPlanCard(item: TutorPlanItem): ReviewCardDto {
  const options = item.options ?? null
  return {
    wordId: item.wordId,
    word: item.word,
    translation: item.translation ?? null,
    definition: item.definition ?? null,
    // Vestigial by contract — see the field's comment in packages/shared/src/types/api.ts. Nothing
    // reads it; the component is chosen from `options`. Kept truthful anyway rather than constant.
    reviewMode: options ? 'multiple_choice' : 'context',
    blankSentence: item.blankSentence ?? null,
    originalSentence: item.sentence ?? null,
    bookTitle: item.bookTitle ?? null,
    hint: item.hint ?? null,
    explanation: null,
    isNew: false,
    options,
    correctOptionIndex: options ? item.correctOptionIndex ?? null : null,
  }
}

/** Projects an enriched plan into renderable study entries — one card per item, nothing dropped. */
export function buildQueue(plan: TutorPlanItem[]): { item: TutorPlanItem; card: ReviewCardDto }[] {
  return plan.map(item => ({ item, card: buildPlanCard(item) }))
}

/** A re-plan with no items means the tutor decided the session is done. */
export function isSessionComplete(plan: TutorPlanItem[]): boolean {
  return plan.length === 0
}

export interface TutorTurn {
  rationale: string
  readingNudge: string
  plan: TutorPlanItem[]
  queue: { item: TutorPlanItem; card: ReviewCardDto }[]
}

export function useTutorSession() {
  const [phase, setPhase] = useState<TutorPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [errorOrigin, setErrorOrigin] = useState<TutorErrorOrigin | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [turn, setTurn] = useState<TutorTurn | null>(null)
  const [adjusted, setAdjusted] = useState(false) // true once the tutor has re-planned at least once
  const [currentIndex, setCurrentIndex] = useState(0)
  const [stats, setStats] = useState<TutorSessionStats>(EMPTY_STATS)
  const [readingNudge, setReadingNudge] = useState('')

  // Results accumulated for the current turn's queue, fed back on completion. Kept on a ref (not state) so a
  // feedback retry after an error can re-send the SAME pending results without losing the learner's progress.
  const resultsRef = useRef<TutorFeedbackResult[]>([])
  // Re-plan round counter — client backstop against a server that keeps returning items.
  const roundsRef = useRef(0)
  // Mounted guard + in-flight abort so no setState fires after unmount when navigating away mid-plan.
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  // Replace any in-flight request's controller and hand back a fresh signal.
  const newSignal = useCallback(() => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    return ctrl.signal
  }, [])

  const loadTurn = useCallback((res: TutorSessionResponse, isReplan: boolean) => {
    if (!mountedRef.current) return
    setSessionId(res.sessionId)
    setReadingNudge(res.readingNudge)
    if (isSessionComplete(res.plan)) {
      setPhase(isReplan ? 'summary' : 'empty')
      return
    }
    // Stop runaway loops: if the tutor keeps handing back work past the cap, end the session.
    if (isReplan && roundsRef.current >= MAX_ROUNDS) {
      setPhase('summary')
      return
    }
    const queue = buildQueue(res.plan)
    resultsRef.current = []
    setCurrentIndex(0)
    setTurn({ rationale: res.rationale, readingNudge: res.readingNudge, plan: res.plan, queue })
    if (isReplan) setAdjusted(true)
    setPhase('plan')
  }, [])

  const start = useCallback(async (maxItems?: number) => {
    setPhase('planning')
    setError(null)
    setErrorOrigin(null)
    setAdjusted(false)
    setStats(EMPTY_STATS)
    roundsRef.current = 0
    resultsRef.current = []
    const signal = newSignal()
    try {
      const res = await startTutorSession(maxItems, signal)
      if (!mountedRef.current) return
      loadTurn(res, false)
    } catch (err) {
      if (!mountedRef.current || signal.aborted) return
      setError(err instanceof Error ? err.message : 'Failed to plan session')
      setErrorOrigin('planning')
      setPhase('error')
    }
  }, [loadTurn, newSignal])

  const beginStudy = useCallback(() => {
    setPhase('study')
    setCurrentIndex(0)
  }, [])

  // Submit the feedback turn → either continue with the re-planned items or finish. On failure, keep the
  // SAME session + pending results so retry re-submits (doesn't start a brand-new session).
  const submitFeedback = useCallback(async () => {
    if (!sessionId) return
    setPhase('planning')
    roundsRef.current += 1
    const signal = newSignal()
    try {
      const res = await sendTutorFeedback(sessionId, resultsRef.current, signal)
      if (!mountedRef.current) return
      emitDataChange('vocabulary')
      loadTurn(res, true)
    } catch (err) {
      if (!mountedRef.current || signal.aborted) return
      setError(err instanceof Error ? err.message : 'Failed to update plan')
      setErrorOrigin('feedback')
      setPhase('error')
    }
  }, [sessionId, loadTurn, newSignal])

  // Retry after an error: re-plan a fresh session, or re-submit the same session's pending feedback.
  const retry = useCallback(() => {
    if (errorOrigin === 'feedback') {
      setError(null)
      setErrorOrigin(null)
      void submitFeedback()
    } else {
      void start()
    }
  }, [errorOrigin, submitFeedback, start])

  // Record a result for the current card and advance; on the last card, trigger the feedback re-plan.
  const answer = useCallback((correct: boolean, responseTimeMs: number) => {
    const queue = turn?.queue
    if (!queue) return
    const entry = queue[currentIndex]
    if (!entry) return
    const result = { wordId: entry.item.wordId, correct, responseTimeMs }
    resultsRef.current = [...resultsRef.current, result]

    // Record it now, not at the end of the session — see the mobile hook, which
    // carries the same change and the same reasoning: feedback fires only on the
    // last card, so leaving mid-session discarded work that now counts.
    if (sessionId) {
      sendTutorAnswer(sessionId, result).catch(() => {})
    }

    setStats(prev => ({ studied: prev.studied + 1, correct: prev.correct + (correct ? 1 : 0) }))
    const nextIdx = currentIndex + 1
    if (nextIdx >= queue.length) {
      void submitFeedback()
    } else {
      setCurrentIndex(nextIdx)
    }
  }, [turn, currentIndex, submitFeedback, sessionId])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setPhase('idle')
    setError(null)
    setErrorOrigin(null)
    setSessionId(null)
    setTurn(null)
    setAdjusted(false)
    setCurrentIndex(0)
    setStats(EMPTY_STATS)
    resultsRef.current = []
    roundsRef.current = 0
  }, [])

  const currentEntry = turn?.queue[currentIndex] ?? null

  return {
    phase,
    error,
    errorOrigin,
    turn,
    adjusted,
    currentIndex,
    currentEntry,
    stats,
    readingNudge,
    start,
    beginStudy,
    answer,
    retry,
    reset,
  }
}
