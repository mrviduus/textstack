import { authFetch } from './client'

// Learning Tutor agent (AI-Agent-2). The tutor PLANS what to study next over the learner's real SRS +
// reading state and hands off to the existing vocabulary-review flow. JSON (SSE deferred). The plan is held
// server-side in a session so the HITL re-plan turn survives across requests.

// --- Types (mirror Contracts/Agents/TutorDtos.cs, camelCase via the API) ---

/**
 * One planned study item. The backend ENRICHES each item with the full card payload, so the UI renders
 * cards straight from the plan — no separate vocab fetch + join. References a REAL vocab card by
 * `wordId`, with per-item `why` reasoning.
 *
 * The SHAPE of the exercise is decided server-side too: `options` / `correctOptionIndex` /
 * `blankSentence` follow `exerciseType`, built by the same option builder the review flow uses.
 * `recall` carries no options on purpose — it is a flashcard the learner grades themselves.
 */
export interface TutorPlanItem {
  wordId: string
  word: string
  stage: number
  exerciseType: string // recognition | recall | context
  difficulty: string // label string
  why: string // per-item reasoning
  translation?: string | null
  definition?: string | null
  sentence?: string | null
  bookTitle?: string | null
  hint?: string | null
  distractors: string[] // [] when none, never null
  /** Four shuffled choices. Null for `recall`, which has no options by design. */
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

// --- API Functions ---

/** Plan a new tutor session over the learner's current state. `maxItems` is optional (server-capped). */
export async function startTutorSession(maxItems?: number, signal?: AbortSignal): Promise<TutorSessionResponse> {
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
export async function sendTutorAnswer(
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
 * Submit the learner's results for the current session and get the re-planned remainder. An empty `plan` in
 * the response means the session is complete.
 */
export async function sendTutorFeedback(
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
