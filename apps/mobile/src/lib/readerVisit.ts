/**
 * One reader visit, carried across a chapter change.
 *
 * Changing chapter is `router.replace`, and Expo Router's REPLACE mints a new
 * route key (StackRouter → createRouteFromAction), so the reader screen
 * REMOUNTS. Without this, every "Next" ended the reading session (one
 * ReadingSession row per chapter), zeroed the saved-words counter that the top
 * bar and the exit summary show, and forgot that a chapter had been finished.
 *
 * The leaving reader hands its state over (`carryVisit`); the arriving one
 * claims it if it is the same book (`claimVisit`). If nobody claims it — the
 * next chapter failed to open and the reader backed out — `flush` runs after
 * CARRY_MS and the old session is submitted, as an unmount would have done.
 *
 * Module state, one slot: there is one reader on screen at a time.
 */

/** The reading session's counters, as `useReadingSession` hands them over. */
export interface SessionSnapshot {
  startedAt: number
  activeSeconds: number
  /** Book distance covered by programmatic jumps — not reading (sessionMath.jumpDistance). */
  jumped?: number
  startPercent: number
  currentPercent: number
  submitted: boolean
}

export interface ReaderVisit {
  /** Book identity: `edition:<slug>` / `userbook:<id>` — known at mount, unlike an edition id. */
  key: string
  session: SessionSnapshot
  savedWords: number
  finishedChapter: boolean
}

/** Long enough for a chapter to load over a slow network; short enough that an abandoned visit is still submitted. */
export const CARRY_MS = 30_000

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
}

let pending: { visit: ReaderVisit; flush: () => void; handle: unknown; timers: Timers } | null = null

function take() {
  const p = pending
  if (!p) return null
  pending = null
  p.timers.clear(p.handle)
  return p
}

export function carryVisit(visit: ReaderVisit, flush: () => void, timers: Timers = realTimers): void {
  take()?.flush()
  const entry = { visit, flush, timers, handle: null as unknown }
  entry.handle = timers.set(() => {
    if (pending !== entry) return
    pending = null
    flush()
  }, CARRY_MS)
  pending = entry
}

/** The carried visit for this book, or null. A carry for another book is flushed, never adopted. */
export function claimVisit(key: string): ReaderVisit | null {
  const p = take()
  if (!p) return null
  if (p.visit.key !== key) { p.flush(); return null }
  return p.visit
}
