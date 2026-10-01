import { authFetch } from './client'
import type { ReviewCardDto } from '../types/api'

// Learning Tutor (AI-Agent-2) — one client for web and mobile. The tutor PLANS what to study next over
// the learner's real SRS + reading state; the plan is held server-side in a session so the re-plan turn
// survives across requests. Types mirror Contracts/Agents/TutorDtos.cs (camelCase via the API).

/**
 * One planned study item. The backend ENRICHES each item with the full card payload (translation, definition,
 * sentence, bookTitle, hint, distractors), so the UI renders the study card straight from the plan — no separate
 * vocab fetch + join. References a REAL vocab card by `wordId`, with per-item `why` reasoning.
 */
export interface TutorPlanItem {
  wordId: string
  word: string
  stage: number
  exerciseType: string // recognition | recall | context (untrusted — model may emit anything)
  difficulty: string // label string
  why: string // per-item reasoning
  translation?: string | null
  definition?: string | null
  sentence?: string | null
  bookTitle?: string | null
  hint?: string | null
  distractors: string[] // [] when none, never null
  /** Four shuffled choices, built server-side. Null for `recall`, which has no options by design. */
  options?: string[] | null
  correctOptionIndex?: number | null
  /** The saved sentence with the word removed — `context` only. */
  blankSentence?: string | null
}

/** The tutor's response: the persisted session, the ordered plan, and the surfaced reasoning. */
export interface TutorSessionResponse {
  sessionId: string
  plan: TutorPlanItem[]
  rationale: string // overall session reasoning
  readingNudge: string // ties back to reading (the thesis)
  runId: string
}

/** One learner result fed back to the tutor for re-planning. */
export interface TutorFeedbackResult {
  wordId: string
  correct: boolean
  responseTimeMs: number
}

/** Plan a new tutor session over the learner's current state. `maxItems` is optional (server-capped). */
export function startTutorSession(maxItems?: number, signal?: AbortSignal): Promise<TutorSessionResponse> {
  return authFetch<TutorSessionResponse>('/me/tutor/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(maxItems != null ? { maxItems } : {}),
    signal,
  })
}

/**
 * Record one answer as it is given.
 *
 * Fire-and-forget by design: the card has already moved on, and a failed write is recovered by the
 * closing feedback call, which sends every result again and is de-duplicated server-side.
 */
export function sendTutorAnswer(
  sessionId: string,
  result: TutorFeedbackResult,
  signal?: AbortSignal,
): Promise<{ applied: boolean }> {
  return authFetch<{ applied: boolean }>(`/me/tutor/session/${sessionId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
    signal,
  })
}

/**
 * Submit the learner's results for the current session and get the re-planned remainder. An empty `plan` in the
 * response means the session is complete.
 */
export function sendTutorFeedback(
  sessionId: string,
  results: TutorFeedbackResult[],
  signal?: AbortSignal,
): Promise<TutorSessionResponse> {
  return authFetch<TutorSessionResponse>(`/me/tutor/session/${sessionId}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results }),
    signal,
  })
}

// --- Pure helpers (unit-tested in apps/mobile/src/lib/agents.test.ts, apps/web useTutorSession.test.ts) ---

/**
 * Builds a classic-flashcard `ReviewCardDto` directly from an ENRICHED plan item. The backend already validated +
 * enriched every item, so there's no vocab fetch + join — the plan item is self-sufficient. Pure projection.
 */
export function buildPlanCard(item: TutorPlanItem): ReviewCardDto {
  const options = item.options ?? null
  return {
    wordId: item.wordId,
    word: item.word,
    translation: item.translation ?? null,
    definition: item.definition ?? null,
    // Vestigial by contract — see the field's comment in packages/shared/src/types/api.ts. The
    // component is chosen from `options`, never from this.
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

export const KNOWN_EXERCISE_TYPES = new Set(['recognition', 'recall', 'context'])

/**
 * Label for an exercise type. Known types resolve via i18n; anything unexpected from the model falls back to the
 * raw value (or a generic label) rather than leaking `tutor.exercise.<garbage>`.
 */
export function exerciseLabel(exerciseType: string, t: (key: string) => string): string {
  if (KNOWN_EXERCISE_TYPES.has(exerciseType)) return t(`tutor.exercise.${exerciseType}`)
  const raw = exerciseType?.trim()
  return raw ? raw : t('tutor.exercise.generic')
}
