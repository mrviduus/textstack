/**
 * The arithmetic of `useReadingSession`, pulled out so it can be tested.
 */

/** A heartbeat never credits more than this, however long it was since the last one. */
export const MAX_TICK_SECONDS = 60

/**
 * Seconds of reading to credit since the last tick.
 *
 * Used by the heartbeat AND by every path that ends a session (L2): ending one
 * used to drop everything since the last 30s heartbeat, so a session cut by the
 * app going to the background lost up to half a minute — and one shorter than a
 * single heartbeat lost everything, falling under the 10s minimum.
 *
 * Wall-clock deltas are clamped to [0, MAX_TICK_SECONDS] (L5): a clock set back
 * mid-session used to produce a negative tick that SUBTRACTED reading time, and
 * one set forward credited a minute for nothing. Same posture as the server's
 * ProgressClock: never trust a client clock past a bound.
 */
export function tickSeconds(o: { now: number; lastTick: number; lastActivity: number; idleMs: number }): number {
  const sinceActivity = o.now - o.lastActivity
  if (sinceActivity >= o.idleMs) return 0
  const elapsed = Math.round((o.now - o.lastTick) / 1000)
  return Math.max(0, Math.min(elapsed, MAX_TICK_SECONDS))
}

/**
 * The session's start/end book percent after a progress report (M8).
 *
 * The baseline is the FIRST settled report, flagged explicitly. It used to be
 * "the first report while both are 0", and the first report of a reopened book
 * is the load event's — the top of the chapter, before the saved position is
 * restored. The restore then counted as reading: reopen at 45% of a chapter and
 * the session claimed the 45% already read. The shell now feeds only reports
 * that come after the restore landed; this makes the baseline a fact, not a
 * coincidence of zeros (a book genuinely at 0% re-baselined on every report).
 */
export interface SessionPercents {
  start: number
  current: number
  baselined: boolean
}

export function applySessionProgress(s: SessionPercents, progress: number): SessionPercents {
  if (!s.baselined) return { start: progress, current: progress, baselined: true }
  return { ...s, current: progress }
}
