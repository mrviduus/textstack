import { authFetch } from '@textstack/shared'
import type { ReviewCardDto } from '@textstack/shared'

// The mobile Tutor ("Smart session") client.
// RN-free on purpose: the DTOs, the typed `authFetch` calls, and the pure helpers below are all unit-testable
// under Vitest (see agents.test.ts) without bundling React Native. Mirrors the web clients/hooks 1:1
// (apps/web/src/api/tutor.ts) plus the same hardening (clamp untrusted text, unknown-type fallback,
// re-plan cap).

// ---------------------------------------------------------------------------
// Tutor (AI-Agent-2) — types mirror Contracts/Agents/TutorDtos.cs (camelCase via the API)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pure helpers (RN-free, unit-tested) — shared between hooks/components
// ---------------------------------------------------------------------------

/** Pure client guard mirroring the backend: ≥2 trimmed chars, ≤500 chars. Returns true when worth an agent run. */

/**
 * Builds a classic-flashcard `ReviewCardDto` directly from an ENRICHED plan item. The backend already validated +
 * enriched every item, so there's no vocab fetch + join — the plan item is self-sufficient. Pure projection.
 */
export function buildPlanCard(item: TutorPlanItem): ReviewCardDto {
  return {
    wordId: item.wordId,
    word: item.word,
    translation: item.translation ?? null,
    definition: item.definition ?? null,
    reviewMode: 'context',
    blankSentence: null,
    originalSentence: item.sentence ?? null,
    bookTitle: item.bookTitle ?? null,
    hint: item.hint ?? null,
    explanation: null,
    isNew: false,
    options: null,
    correctOptionIndex: null,
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

const KNOWN_EXERCISE_TYPES = new Set(['recognition', 'recall', 'context'])

/**
 * Label for an exercise type. Known types resolve via i18n; anything unexpected from the model falls back to the
 * raw value (or a generic label) rather than leaking `tutor.exercise.<garbage>`.
 */
export function exerciseLabel(exerciseType: string, t: (key: string) => string): string {
  if (KNOWN_EXERCISE_TYPES.has(exerciseType)) return t(`tutor.exercise.${exerciseType}`)
  const raw = exerciseType?.trim()
  return raw ? raw : t('tutor.exercise.generic')
}

/** Known exercise types map to a themed accent color; unknown types get the neutral fallback. */
export function exerciseBadgeColor(
  exerciseType: string,
  palette: { recognition: string; recall: string; context: string; fallback: string },
): string {
  switch (exerciseType) {
    case 'recognition':
      return palette.recognition
    case 'recall':
      return palette.recall
    case 'context':
      return palette.context
    default:
      return palette.fallback
  }
}
