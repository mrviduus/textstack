// Reading sessions of the V2 reader (#1313), one rule for both hosts. Pure: every call takes the time.
//
// The legacy readers' rules (apps/web useReadingSession, apps/mobile useReadingSession): a session starts on the
// reader's first activity, time counts up to 3 min after the last activity, 5 min without any ends it, one under
// 10 s is not kept, none counts over 4 h; a host ends it when the book closes or another opens, the tab is hidden
// or the app goes to the background, and on unmount. The heartbeat (`tick`) only ends an idle one: time is counted
// from the activity timestamps, each gap clamped to [0, 3 min], so a clock set back never subtracts. Whenever the
// seconds sent are fewer than the time counted (the 4 h cap, a clock set back), the words go down with them: the
// pace sent is the pace read.
//
// Words read come from the page's `relocate` (`fraction`, `words`: the book's length estimated from the shown
// section; null for CBZ and PDF, so those count time only), by its `cause` (chrome.mjs `readRelocate`): the page
// says what moved the place; the host never guesses it.
// - `turn`, the reader's own page turn: counts the ground past the session's furthest place times `words`, at most
//   800 wpm (the server's top pace) of the counted time since the last step that counted. A turn back keeps the
//   furthest place, so back then forward again counts the ground once.
// - `nav`, the landing of a navigation (a contents entry, a section control, the taken offer, a sync move, a
//   restore, a followed link): counts nothing; the reader reads on from there (baseline and furthest place).
// - `layout`, anything else (a re-layout, the same place again): counts nothing; the baseline moves, the furthest
//   place stays, so ground already counted is not counted again.

export const SESSION_IDLE_MS = 3 * 60_000
export const SESSION_END_IDLE_MS = 5 * 60_000
export const SESSION_HEARTBEAT_MS = 30_000
export const MIN_SESSION_SECONDS = 10
export const MAX_SESSION_SECONDS = 14_400
/** ReadingPace.MaxWpm on the server: no step counts more words than this pace reads in its time. */
export const MAX_WPM = 800

const gap = (from, to) => Math.min(Math.max(to - from, 0), SESSION_IDLE_MS)

export function createSessionTracker() {
  /** The open book's key (the host's: a server book id, or the bytes' sha256); null: none taken. */
  let book = null
  /** The last relocate's fraction; null: none since the open. */
  let place = null
  let session = null

  const start = (now) => {
    // `furthest`: the session's furthest place; `counted`: its counted time when a step last counted.
    session = { book, startedAt: now, lastActivity: now, activeMs: 0, start: place, furthest: place, counted: 0, words: 0 }
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
    const active = Math.round((s.activeMs + gap(s.lastActivity, now)) / 1000)
    // Never more than the span: a clock set back before the start leaves none, and no session.
    const seconds = Math.min(active, MAX_SESSION_SECONDS, Math.floor((now - s.startedAt) / 1000))
    if (seconds < MIN_SESSION_SECONDS) return null
    const startPercent = s.start ?? place ?? 0
    return {
      book: s.book,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(now).toISOString(),
      durationSeconds: seconds,
      wordsRead: Math.round(seconds < active ? (s.words * seconds) / active : s.words),
      startPercent,
      endPercent: place ?? startPercent,
    }
  }

  return {
    /** An open starts (or the book closed): the session so far ends (returned), and nothing is known of the next. */
    open(now) {
      const ended = end(now)
      book = null
      place = null
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
      // A turn is the reader's even when the save rule says not moved (`moved` stays false while a restore never came).
      if (r.moved || r.cause === 'turn') activity(now)
      if (r.fraction === null) return
      const from = place
      place = r.fraction
      if (!session) return
      // A session started with no place starts where the first relocate puts it.
      session.start ??= from ?? r.fraction
      if (r.cause === 'nav') {
        session.furthest = r.fraction
        return
      }
      const base = Math.max(from ?? r.fraction, session.furthest ?? r.fraction)
      session.furthest ??= r.fraction
      if (r.cause !== 'turn' || r.words === null || r.fraction <= base) return
      session.words += Math.min((r.fraction - base) * r.words, ((session.activeMs - session.counted) / 60_000) * MAX_WPM)
      session.furthest = r.fraction
      session.counted = session.activeMs
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
