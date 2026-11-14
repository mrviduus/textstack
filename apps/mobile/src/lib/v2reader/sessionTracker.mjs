// Reading sessions of the V2 reader (#1313), one rule for both hosts. Pure: every call takes the time.
//
// The legacy readers' rules (apps/web useReadingSession, apps/mobile useReadingSession): a session starts on the
// reader's first activity, time counts up to 3 min after the last activity, 5 min without any ends it, one under
// 10 s is not kept, none counts over 4 h (its words scaled down with its time); a host ends it when the book closes
// or another opens, the tab is hidden or the app goes to the background, and on unmount. The heartbeat (`tick`)
// only ends an idle one: time is counted from the activity timestamps, each gap clamped to [0, 3 min], so a clock
// set back never subtracts.
//
// Words read come from the page's `relocate` (`fraction`, `words`: the book's length estimated from the shown
// section; null for CBZ and PDF, so those count time only). The reader's own move (`moved`) counts the ground it
// covers past the session's furthest place times `words`: the reader's own move back keeps that furthest place, so
// back then forward again counts the ground once. A move that is not the reader's own turn (a relocate without
// `moved`: the open, a restore, a sync move, a re-layout; or the landing of the host's own navigation, a contents
// entry, a section control, the taken offer: `jump()` before it) counts nothing and puts the baseline and the
// furthest place where it landed. A `moved` the page reports for anything else (a followed link, a long scroll)
// counts no more than the server's top pace (800 wpm) reads in the session's counted time since the last step
// that counted: never time before the session, nor idle time past 3 min a gap.
import { createHostMoves, HOST_MOVE_GRACE_MS } from './chrome.mjs'

export const SESSION_IDLE_MS = 3 * 60_000
export const SESSION_END_IDLE_MS = 5 * 60_000
export const SESSION_HEARTBEAT_MS = 30_000
export const MIN_SESSION_SECONDS = 10
export const MAX_SESSION_SECONDS = 14_400
/** ReadingPace.MaxWpm on the server: no step counts more words than this pace reads in its time. */
export const MAX_WPM = 800

const gap = (from, to) => Math.min(Math.max(to - from, 0), SESSION_IDLE_MS)
/** Within a host move's grace (chrome.mjs): a clock set back after the landing is outside it. */
const inGrace = (ms) => ms >= 0 && ms < HOST_MOVE_GRACE_MS

export function createSessionTracker() {
  /** The open book's key (the host's: a server book id, or the bytes' sha256); null: none taken. */
  let book = null
  /** The last relocate's fraction; null: none since the open. */
  let place = null
  let session = null
  /** The host's own navigations and their landings (chrome.mjs, as the bars use it). */
  let moves = createHostMoves()
  /** When the last `jump()` asked, until its landing; an ask with no relocate within the grace expires. */
  let askedAt = null

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
      // Past the 4 h cap the words go down with the time: the pace stays the one read.
      wordsRead: Math.round(active > MAX_SESSION_SECONDS ? (s.words * MAX_SESSION_SECONDS) / active : s.words),
      startPercent,
      endPercent: place ?? startPercent,
    }
  }
  /** Whether this relocate is (part of) the landing of the host's own navigation. */
  const landed = (now) => {
    if (askedAt !== null && !inGrace(now - askedAt)) {
      // Nothing landed within the grace: the reader's next turns are their own.
      moves = createHostMoves()
      askedAt = null
    }
    const ms = moves.onRelocate(now)
    if (ms === 0) askedAt = null
    return inGrace(ms)
  }

  return {
    /** An open starts (or the book closed): the session so far ends (returned), and nothing is known of the next. */
    open(now) {
      const ended = end(now)
      book = null
      place = null
      moves = createHostMoves()
      askedAt = null
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
      const jumped = landed(now)
      if (r.moved) activity(now)
      if (r.fraction === null) return
      const from = place
      place = r.fraction
      if (!session) return
      // A session started with no place (a `jump()` first) starts where the first relocate puts it.
      session.start ??= from ?? r.fraction
      if (jumped || !r.moved) {
        // Not the reader's own turn: it reads nothing, and the reader reads on from where it put them.
        session.furthest = r.fraction
        if (jumped) session.counted = session.activeMs
        return
      }
      const base = Math.max(from ?? r.fraction, session.furthest ?? r.fraction)
      if (r.words === null || r.fraction <= base) return
      session.words += Math.min((r.fraction - base) * r.words, ((session.activeMs - session.counted) / 60_000) * MAX_WPM)
      session.furthest = r.fraction
      session.counted = session.activeMs
    },
    /**
     * The host navigates (a contents entry, a section control, the taken offer): where it lands is not reading.
     * Its relocates within the grace (chrome.mjs HOST_MOVE_GRACE_MS) are the landing; none by then, the ask expires.
     */
    jump(now) {
      activity(now)
      moves.start()
      askedAt = now
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
