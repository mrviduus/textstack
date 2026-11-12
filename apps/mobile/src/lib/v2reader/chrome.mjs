// What the reader chrome needs from the page (#1263, #1264): where a tap landed, the book's reading direction,
// the navigation keys pressed inside a section. The page side (`navKey`) and the hosts' readers, pure: the page
// renders untrusted book content, so a host takes only what these return.
import { MAX_SELECTION_PX } from './selection.mjs'

/** The keys a section may forward (`key` message), as sent. Closed list. */
export const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Space', 'Escape']
/** `KeyboardEvent.key` → what is sent: the space bar's key is ' '. */
const BY_EVENT_KEY = new Map(NAV_KEYS.map((k) => [k === 'Space' ? ' ' : k, k]))

/** A book's own form field: a key typed there is the book's, never forwarded. */
const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/** The `key` message for a keydown in a section, or null: not on the list, a modifier held, or typed in a field. */
export function navKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  const key = BY_EVENT_KEY.get(e.key)
  if (!key) return null
  if (e.target?.closest?.(FIELD)) return null
  return { type: 'key', key, shift: !!e.shiftKey }
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

/** A host's read of `key`: `{ key, shift }` for a key on the list, or null (dropped). Never throws. */
export function readKey(m) {
  if (m?.type !== 'key' || !NAV_KEYS.includes(m.key) || typeof m.shift !== 'boolean') return null
  return { key: m.key, shift: m.shift }
}
