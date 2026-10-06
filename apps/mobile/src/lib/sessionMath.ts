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

/**
 * A jump the reader did not read through — a restore to another device's newer position (move or
 * the toast), a rebuild/reflow restore. The distance it covered is NOT reading. Accumulated apart
 * so start/end percents stay real book positions while the words read leave the jumps out.
 * `from` null: nothing fed yet, so the landing is simply the baseline.
 */
export function jumpDistance(from: number | null, to: number): number {
  return from == null ? 0 : to - from
}

/** Words read: book distance travelled, minus the jumps, times the book's words. */
export function sessionWordsRead(o: { start: number; current: number; jumped: number; wordCount: number }): number {
  return Math.round(Math.abs(o.current - o.start - o.jumped) * o.wordCount)
}

/**
 * Where a programmatic restore stands, for the session — set by useReaderPersistence (every
 * restore goes through its `issueRestore`), read by the shell's progress handler.
 * - `pending`: issued, not landed — reports are the restore travelling; never fed.
 * - `landed`: the next report is where it put the reader; its distance is a jump.
 */
export type SessionJump = 'idle' | 'pending' | 'landed'
