/**
 * Retry queue for reading sessions whose submit failed — pure logic, storage is the caller's.
 *
 * Web keeps it in localStorage, mobile in AsyncStorage. Retries are safe because the server acks a
 * second submit of the same (user, book, startedAt) without inserting (ReadingSessionService).
 */
export interface PendingSession {
  editionId?: string | null
  userBookId?: string | null
  startedAt: string
  endedAt: string
  durationSeconds: number
  wordsRead: number
  startPercent: number
  endPercent: number
}

export const MAX_PENDING_SESSIONS = 50
/** Server rejects sessions older than 7 days — drop at 6 to give a safety margin. */
export const MAX_PENDING_SESSION_AGE_MS = 6 * 24 * 60 * 60 * 1000

/** Appends, dropping the oldest beyond the cap. */
export function appendPendingSession(queue: PendingSession[], session: PendingSession): PendingSession[] {
  return [...queue, session].slice(-MAX_PENDING_SESSIONS)
}

/**
 * A rejection that resending the same bytes can never fix: 400 (bad payload), 404 (book deleted /
 * re-uploaded), and any other 4xx except 401 (token refresh may fix it), 408 and 429. Network
 * failures (status 0) and 5xx stay queued.
 */
export function isPermanentSessionRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status !== 'number') return false
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
}

/**
 * Submits each queued session in order and returns the ones to keep for the next attempt. Expired
 * sessions are dropped unsent; a duration longer than the session's own span (sessions queued
 * before clients clamped it) is clamped, since the server 400s it.
 */
export async function drainPendingSessions(
  queue: PendingSession[],
  submit: (s: PendingSession) => Promise<unknown>,
  now: number = Date.now(),
): Promise<PendingSession[]> {
  const kept: PendingSession[] = []
  for (const s of queue) {
    const startedAt = Date.parse(s.startedAt)
    if (!Number.isFinite(startedAt) || now - startedAt >= MAX_PENDING_SESSION_AGE_MS) continue
    const span = Math.floor((Date.parse(s.endedAt) - startedAt) / 1000)
    try {
      await submit(span >= 0 ? { ...s, durationSeconds: Math.min(s.durationSeconds, span) } : s)
    } catch (err) {
      if (!isPermanentSessionRejection(err)) kept.push(s)
    }
  }
  return kept
}
