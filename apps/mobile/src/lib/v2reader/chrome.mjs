// What the reader chrome needs from the page (#1263, #1264): where a tap landed, the book's reading direction,
// the navigation keys pressed inside a section. The page side (`navKey`) and the hosts' readers, pure: the page
// renders untrusted book content, so a host takes only what these return.
import { MAX_SELECTION_PX } from './selection.mjs'

/** The keys a section may forward (`key` message), as sent. Closed list. */
export const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Space', 'Escape']
/** `KeyboardEvent.key` → what is sent: the space bar's key is ' '. */
const BY_EVENT_KEY = new Map(NAV_KEYS.map((k) => [k === 'Space' ? ' ' : k, k]))

/**
 * The `key` message for a keydown, or null: not on the list, a modifier held, an arrow with Shift (it extends a
 * selection), or pressed on anything but the document itself: a focused control, link, summary, media or field
 * of the book keeps its own keys. `repeat`: the key is held (auto-repeat).
 */
export function navKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  const key = BY_EVENT_KEY.get(e.key)
  if (!key || (e.shiftKey && key.startsWith('Arrow'))) return null
  const t = e.target
  const doc = t?.ownerDocument
  if (!doc || (t !== doc.body && t !== doc.documentElement) || t.closest('[contenteditable]:not([contenteditable="false"])')) return null
  return { type: 'key', key, shift: !!e.shiftKey, repeat: !!e.repeat }
}

const coord = (v) => typeof v === 'number' && v >= -MAX_SELECTION_PX && v <= MAX_SELECTION_PX

/** A host's read of `tap`: `{ x, y }` in page-viewport px, or null (dropped). Never throws. */
export function readTap(m) {
  if (m?.type !== 'tap' || !coord(m.x) || !coord(m.y)) return null
  return { x: m.x, y: m.y }
}

/** `opened.dir`: 'rtl' or 'ltr'; anything else is null (the host's default, left to right). */
export function readDir(m) {
  return m?.dir === 'rtl' || m?.dir === 'ltr' ? m.dir : null
}

/** A host's read of `key`: `{ key, shift, repeat }` for a key on the list, or null (dropped). Never throws. */
export function readKey(m) {
  if (m?.type !== 'key' || !NAV_KEYS.includes(m.key) || typeof m.shift !== 'boolean' || typeof m.repeat !== 'boolean') return null
  return { key: m.key, shift: m.shift, repeat: m.repeat }
}

/**
 * What a key does, for both hosts: the arrows by the direction the book pages in (ArrowLeft is the next page
 * right to left), PageUp and Shift+Space back, PageDown and Space on, Escape the bars. Null for anything else.
 */
export function keyAction({ key, shift, dir }) {
  if (key === 'ArrowLeft') return dir === 'rtl' ? 'next' : 'prev'
  if (key === 'ArrowRight') return dir === 'rtl' ? 'prev' : 'next'
  if (key === 'PageUp') return 'prev'
  if (key === 'PageDown') return 'next'
  if (key === 'Space') return shift ? 'prev' : 'next'
  if (key === 'Escape') return 'bars'
  return null
}

/** The cap on the TOC label the chrome renders. */
const MAX_TOC_LABEL = 200
const count = (v) => Number.isInteger(v) && v >= 0 && v <= 100_000

/**
 * A host's read of `relocate` for what the chrome shows and follows (never throws): `fraction` in [0, 1], `index`
 * and `sections` whole numbers ≤ 100,000, else null; `toc` a string cut to 200, else ''; `tocIndex` (the current entry's index in
 * `opened.toc`, #1261) a whole number ≤ 100,000, else null (the host still checks it against its list); `dir` through `readDir`;
 * `moved` (the reader moved the place, the page's save rule) and `atEnd` (the end of the book is on screen,
 * #1266) true only when exactly `true`.
 * The position code (sync, ADR-019) keeps reading the message as before.
 */
export function readRelocate(m) {
  if (m?.type !== 'relocate') return null
  const f = m.fraction
  return {
    fraction: typeof f === 'number' && f >= 0 && f <= 1 ? f : null,
    index: count(m.index) ? m.index : null,
    sections: count(m.sections) ? m.sections : null,
    toc: typeof m.toc === 'string' ? m.toc.slice(0, MAX_TOC_LABEL) : '',
    tocIndex: count(m.tocIndex) ? m.tocIndex : null,
    dir: readDir(m),
    moved: m.moved === true,
    atEnd: m.atEnd === true,
  }
}

/**
 * Until the word popup (#1269): a `word` acts as a tap at the centre of its `rect`, `{ x, y }` in page-viewport px,
 * or null (dropped: not a `word`, or a rect `readTap` would refuse). Never throws.
 */
export function readWordTap(m) {
  const r = m?.type === 'word' ? m.rect : null
  if (!r || ![r.x, r.y, r.w, r.h].every(coord) || r.w < 0 || r.h < 0) return null
  return readTap({ type: 'tap', x: r.x + r.w / 2, y: r.y + r.h / 2 })
}

/** A relocate this soon after one a bar button caused keeps the bars up (a landing can relocate more than once). */
export const HOST_MOVE_GRACE_MS = 1000

/**
 * The reader moving the place (the page's `moved`: a swipe, a scroll, a turn) hides the bars, in either flow,
 * unless a bar button (or the taken offer) just moved it: the bars stay under the finger.
 */
export function hidesBarsOnRelocate({ moved, msSinceHostMove }) {
  return moved && !(msSinceHostMove < HOST_MOVE_GRACE_MS)
}

/**
 * The host's own moves the page counts as the reader's (a bar button's `prev()`/`next()`, a chosen `goTo`):
 * `start()` when it calls the page; `onRelocate(now)` per relocate gives the ms since that move landed: 0 for the
 * first relocate after `start()`, however late it comes.
 */
export function createHostMoves() {
  let pending = false
  let at = -Infinity
  return {
    start() { pending = true },
    onRelocate(now) {
      if (pending) {
        pending = false
        at = now
      }
      return now - at
    },
  }
}

/** Android back, in order: the offer, then the open book (back to the list), then the route. */
export function backAction({ offer, reading }) {
  if (offer) return 'close-offer'
  if (reading) return 'close-book'
  return 'leave'
}

/** The marker the Android host's close script posts after the flush. */
export const BOOK_CLOSED = 'book-closed'

/**
 * Android host, closing a book: the page's pending save first (`flush()` posts its `store` synchronously), then
 * the marker, so the `store` is in before the host ends the book (messages arrive in order).
 */
// A plain literal (no `${BOOK_CLOSED}`): a template is kept in the page bundle even unused; the test pins the type.
export const CLOSE_BOOK_JS = 'try{window.__fol.flush()}catch(e){};window.ReactNativeWebView.postMessage(\'{"type":"book-closed"}\');true'

/** A page load's `ready` reopens the open in flight only while its book is on screen: a closed book stays closed. */
export function reopensOnReady({ opening, inBook }) {
  return !!opening && inBook
}

/** Page messages acted on with no book on screen: a `tap`, `key`, `word` or `selection` from the hidden page is dropped. */
export function takenWithoutBook(type) {
  return type !== 'tap' && type !== 'key' && type !== 'word' && type !== 'selection'
}
