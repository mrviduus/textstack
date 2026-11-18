// The `ready` and `opened` deadlines (#1227, #1080 item 3), one rule for both hosts (V2ReaderScreen, web
// V2ReaderHost). Pure apart from setTimeout. Without them a page that never answers (a WebView too old for it,
// a refused script, a parser stuck on a file) leaves the host saying "Opening…" forever.
//
// A late answer is still taken: `ready()`/`answered()` after the deadline clear the overdue state, so the host
// drops its error (the page was slow, not dead).

/** `ready` from a page the host carries (Android's inline page, the dev server's frame): ~3.7 MB of script to parse, nothing to fetch. */
export const READY_DEADLINE_MS = 10_000
/** `ready` from a frame fetched over the network (the web production route: the shell, and the 1.6 MB gzipped page script on a cold cache). */
export const READY_DEADLINE_NETWORK_MS = 30_000
/**
 * `opened` after the open is sent: the page reads the bytes, hashes them (pure-JS SHA-256), parses the book.
 * Measured (R4 gate, epub-engine-prototype.md): an 87 MB EPUB opened in 6.4–7.7 s on the emulator, ~12 MB/s.
 * The knobs allow ~1 MB/s (12× slower: an old phone, a cold WebView) above a floor for the fixed cost of a
 * small book (the format reader, the first section), capped so a stuck open is said within 3 minutes.
 */
export const OPENED_FLOOR_MS = 20_000
export const OPENED_MS_PER_MB = 1_000
export const OPENED_CAP_MS = 180_000
/**
 * The web route's download (bytes before any open): no byte for this long is a stalled transfer, said with Retry
 * rather than a progress line that never moves. Per chunk, not per file: a slow link that keeps sending passes.
 */
export const DOWNLOAD_STALL_MS = 30_000

/** The `opened` deadline for a file of `bytes` (unknown: the floor). */
export function openedDeadlineMs(bytes) {
  const mb = bytes > 0 ? bytes / 1_048_576 : 0 // NaN, null, undefined: false
  return Math.min(OPENED_CAP_MS, Math.round(OPENED_FLOOR_MS + mb * OPENED_MS_PER_MB))
}

/**
 * One host's deadlines. `onChange(overdue)` fires when the state changes: `'ready'` (no `ready` in time),
 * `'opened'` (no answer to the open in time), or null (a late answer came, or the wait was given up).
 */
export function createDeadlines(onChange) {
  let overdue = null
  const timers = { ready: undefined, opened: undefined }
  const set = (next) => {
    if (next !== overdue) onChange((overdue = next))
  }
  /** After `met(kind)`: no timer of that kind is running. */
  const wait = (kind, ms) => {
    timers[kind] = setTimeout(() => {
      timers[kind] = undefined
      set(kind)
    }, ms)
  }
  const met = (kind) => {
    clearTimeout(timers[kind])
    timers[kind] = undefined
    if (overdue === kind) set(null)
  }
  return {
    /** A page load started (first mount, a reload): `ready` is due in `ms`; an open's wait ends with the old page. */
    waitReady(ms) {
      met('opened')
      met('ready')
      wait('ready', ms)
    },
    ready: () => met('ready'),
    /** An open was sent to the page: `opened` (or `open-failed`) is due in `openedDeadlineMs(bytes)`. */
    waitOpened(bytes) {
      met('opened')
      wait('opened', openedDeadlineMs(bytes))
    },
    /** The open was answered (`opened` or `open-failed`) or given up: no wait, no overdue `opened`. */
    answered: () => met('opened'),
    overdue: () => overdue,
    dispose() {
      clearTimeout(timers.ready)
      clearTimeout(timers.opened)
    },
  }
}

/** An open that misses its `opened` deadline this many times in a row is given up (Android: Retry reopens it). */
export const OPENED_OVERDUE_LIMIT = 2

/**
 * Overdue opens in a row, per open (the host's key: Android's file path). `strike(key)` counts one and answers
 * true when `key` reached the limit (then it starts again from zero); another key starts its own count, and
 * `clear()` (the open answered) forgets it.
 */
export function createOverdueStrikes(limit = OPENED_OVERDUE_LIMIT) {
  let key = null
  let count = 0
  return {
    strike(k) {
      count = k === key ? count + 1 : 1
      key = k
      if (count < limit) return false
      key = null
      count = 0
      return true
    },
    clear() {
      key = null
      count = 0
    },
  }
}
