// Types for sessionTracker.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const SESSION_IDLE_MS: number
export const SESSION_END_IDLE_MS: number
export const SESSION_HEARTBEAT_MS: number
export const MIN_SESSION_SECONDS: number
export const MAX_SESSION_SECONDS: number
export const MAX_WPM: number

/** A finished session, the body of `PUT /me/v2/reading/sessions/{id}` but for `book` (the host's key) and the id. */
export interface EndedSession {
  book: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  wordsRead: number
  startPercent: number
  endPercent: number
}

export interface SessionTracker {
  open(now: number): EndedSession | null
  bind(key: string | null, now: number): EndedSession | null
  relocate(r: { fraction: number | null; words: number | null; moved: boolean; cause: Cause } | null, now: number): void
  activity(now: number): void
  tick(now: number): EndedSession | null
  end(now: number): EndedSession | null
}
/** The page's `relocate.cause` (#1313, planned page field). */
export type Cause = 'turn' | 'nav' | 'layout'
export function readCause(m: unknown): Cause
export function createSessionTracker(): SessionTracker
