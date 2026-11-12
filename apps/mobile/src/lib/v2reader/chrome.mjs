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

/** A relocate this soon after a bar control was pressed (the bar's own prev/next) keeps the bars up. */
export const BAR_PRESS_GRACE_MS = 1000

/** Scrolling (the reader moving, scrolled flow) hides the bars, unless a bar control just moved it. */
export function hidesBarsOnRelocate({ flow, moved, msSinceBarPress }) {
  return flow === 'scrolled' && moved && !(msSinceBarPress < BAR_PRESS_GRACE_MS)
}

/** Android back, in order: the offer, then the open book (back to the list), then the route. */
export function backAction({ offer, reading }) {
  if (offer) return 'close-offer'
  if (reading) return 'close-book'
  return 'leave'
}
