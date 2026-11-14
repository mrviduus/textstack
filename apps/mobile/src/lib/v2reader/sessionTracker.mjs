// Reading sessions of the V2 reader (#1313), one rule for both hosts. Pure: every call takes the time.
//
// The legacy readers' rules (apps/web useReadingSession, apps/mobile useReadingSession): a session starts on the
// reader's first activity, time counts up to 3 min after the last activity, 5 min without any ends it, one under
// 10 s is not kept, none counts over 4 h; a host ends it when the book closes or another opens, the tab is hidden
// or the app goes to the background, and on unmount. The heartbeat (`tick`) only ends an idle one: time is counted
// from the activity timestamps, each gap clamped to [0, 3 min], so a clock set back never subtracts.
//
// Words read come from the page's `relocate` (`fraction`, `words`: the book's length estimated from the shown
// section; null for CBZ and PDF, so those count time only): a move by the reader (`moved`) counts the ground it
// covers past the furthest place of the session (back then forward again counts once) times `words`. A relocate the
// reader did not make (the open, a restore, a sync move, a re-layout) only moves the baseline, and so do the host's
// own navigations (a contents entry, a section control, the taken offer: `jump()` before them, its landing
// relocates within `JUMP_GRACE_MS`). Anything else the page reports as `moved` (a followed link, a long scroll)
// counts no more than the server's top pace (800 wpm) reads in the session's counted time since the last step
// that counted: never time before the session, nor idle time past 3 min a gap.
export const SESSION_IDLE_MS = 3 * 60_000
export const SESSION_END_IDLE_MS = 5 * 60_000
export const SESSION_HEARTBEAT_MS = 30_000
export const MIN_SESSION_SECONDS = 10
export const MAX_SESSION_SECONDS = 14_400
/** ReadingPace.MaxWpm on the server: no step counts more words than this pace reads in its time. */
export const MAX_WPM = 800
/** A host navigation can land in more than one relocate (chrome.mjs HOST_MOVE_GRACE_MS). */
export const JUMP_GRACE_MS = 1000

const gap = (from, to) => Math.min(Math.max(to - from, 0), SESSION_IDLE_MS)

export function createSessionTracker() {
  /** The open book's key (the host's: a server book id, or the bytes' sha256); null: none taken. */
  let book = null
  /** The last relocate's fraction; null: none since the open. */
  let place = null
  let session = null
  /** A host navigation: 'asked' until its first relocate, then that relocate's time (its grace); null: none. */
  let landing = null

  const start = (now) => {
    const at = place?.fraction ?? null
    // `furthest`: the session's furthest place; `counted`: its counted time when a step last counted.
    session = { book, startedAt: now, lastActivity: now, activeMs: 0, start: at, furthest: at, counted: 0, words: 0 }
  }
  const activity = (now) => {
    if (book === null) return
    if (!session) return start(now)
    session.activeMs += gap(session.lastActivity, now)
    session.lastActivity = now
  }
  const end = (now) => {
    const s = session
    session = null
    if (!s) return null
    // Never more than the span: a clock set back before the start leaves none, and no session.
    const seconds = Math.min(Math.round((s.activeMs + gap(s.lastActivity, now)) / 1000), MAX_SESSION_SECONDS, Math.floor((now - s.startedAt) / 1000))
    if (seconds < MIN_SESSION_SECONDS) return null
    const startPercent = s.start ?? place?.fraction ?? 0
    return {
      book: s.book,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(now).toISOString(),
      durationSeconds: seconds,
      wordsRead: Math.round(s.words),
      startPercent,
      endPercent: place?.fraction ?? startPercent,
    }
  }

  return {
    /** An open starts (or the book closed): the session so far ends (returned), and nothing is known of the next. */
    open(now) {
      const ended = end(now)
      book = null
      place = null
      landing = null
      return ended
    },
    /**
     * The open book is this one (`opened` taken); null: a book whose reading is not recorded (not synced). A session
     * of another book ends (returned): nothing read in one is counted to the other.
     */
    bind(key, now) {
      const ended = session && session.book !== key ? end(now) : null
      book = key
      return ended
    },
    /** A relocate as `readRelocate` (chrome.mjs) returns it; null is dropped. */
    relocate(r, now) {
      if (!r) return
      if (landing === 'asked') landing = now
      const jumped = landing !== null && now - landing < JUMP_GRACE_MS
      if (r.moved) activity(now)
      if (r.fraction === null) return
      const from = place
      place = { fraction: r.fraction }
      if (!session) return
      if (jumped) return void (session.counted = session.activeMs)
      const base = Math.max(from?.fraction ?? r.fraction, session.furthest ?? r.fraction)
      if (session.furthest === null) session.furthest = r.fraction
      if (!r.moved || r.words === null || r.fraction <= base) return
      session.words += Math.min((r.fraction - base) * r.words, ((session.activeMs - session.counted) / 60_000) * MAX_WPM)
      session.furthest = r.fraction
      session.counted = session.activeMs
    },
    /**
     * The host navigates (a contents entry, a section control, the taken offer): where it lands is not reading.
     * ponytail: a jump that sends no relocate (a target already on screen) leaves the next one (the reader's turn)
     * uncounted, one page; a per-jump id from the page would settle it if that page shows in the pace.
     */
    jump(now) {
      activity(now)
      landing = 'asked'
    },
    /** The reader did something in the book: a tap, a key, a word, a selection. */
    activity,
    /** The heartbeat: a session idle for 5 min ends (returned). */
    tick(now) {
      return session && now - session.lastActivity >= SESSION_END_IDLE_MS ? end(now) : null
    },
    /** Hidden, background, unmount: the session ends (returned; null when there was none, or it was too short). */
    end,
  }
}
