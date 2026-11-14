// Highlights (#1312): the palette, the page's `highlight-list` builder and the hosts' readers of the page's highlight
// messages (`highlight-list`, `highlight-tap`, `highlight-removed`), in `readSelection`'s style. Pure, page and both
// hosts. The page renders untrusted book content: a host takes these only through the readers here.
import { MAX_SELECTION_CFI, readRect } from './selection.mjs'
import { readTap } from './chrome.mjs'

/** The legacy readers' four colours (web SelectionToolbar, mobile HighlightNoteModal), in their order. */
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'pink', 'blue']
/** What the page draws for each (foliate's overlayer at its .3 opacity: the legacy 200-tone swatches would vanish). */
export const HIGHLIGHT_FILL = { yellow: '#facc15', green: '#4ade80', pink: '#f472b6', blue: '#60a5fa' }
export const isHighlightColor = (c) => HIGHLIGHT_COLORS.includes(c)
/** A stored colour as drawn: the server does not enumerate colours, so one off the list is drawn yellow. */
export const colorOf = (c) => (isHighlightColor(c) ? c : 'yellow')

/** At most this many items in a `highlight-list`; text cut to this many code points (display only). */
export const MAX_LIST = 5000
export const MAX_LIST_TEXT = 200
/** A note's length cap in UTF-16 units (the server has none; a textarea's maxLength). */
export const MAX_NOTE = 2000
/** A highlight id as the page holds it: a v4 or the server's UUID, or a pre-#1078 `h…` one. */
const isId = (id) => typeof id === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(id)
const isCfi = (c) => typeof c === 'string' && c.length <= MAX_SELECTION_CFI && c.startsWith('epubcfi(')

/**
 * The page's `highlight-list` items: the entry's highlights drawn on screen (`drawn`: their ids), in book order
 * (`compare`: foliate's CFI compare; a tie by creation time), each `{ id, cfi, color, text, at }`.
 */
export function highlightList(highlights, drawn, compare) {
  return highlights
    .filter((h) => drawn.has(h.id))
    .map((h) => ({ id: h.id, cfi: h.cfi, color: colorOf(h.color), text: Array.from(h.selectedText ?? h.quote ?? '').slice(0, MAX_LIST_TEXT).join(''), at: Number.isFinite(h.at) ? h.at : null }))
    .sort((a, b) => compare(a.cfi, b.cfi) || (a.at ?? 0) - (b.at ?? 0))
    .slice(0, MAX_LIST)
}

/** A host's read of `highlight-list`: `{ key, highlights }`, malformed items dropped; null for a malformed message. */
export function readHighlightList(m) {
  if (!m || typeof m !== 'object' || m.type !== 'highlight-list' || typeof m.key !== 'string' || !Array.isArray(m.highlights)) return null
  const highlights = []
  for (const h of m.highlights.slice(0, MAX_LIST)) {
    if (!h || typeof h !== 'object' || !isId(h.id) || !isCfi(h.cfi) || typeof h.text !== 'string' || h.text.length > 2 * MAX_LIST_TEXT) continue
    highlights.push({ id: h.id, cfi: h.cfi, color: colorOf(h.color), text: h.text, at: Number.isFinite(h.at) ? h.at : null })
  }
  return { key: m.key, highlights }
}

/**
 * A host's read of `highlight-tap` (a tap on a drawn highlight): `{ id, rect, x, y }`, the highlight's box and the
 * tap's point in page-viewport px (`readTap`'s bounds), or null.
 */
export function readHighlightTap(m) {
  if (!m || typeof m !== 'object' || m.type !== 'highlight-tap' || !isId(m.id)) return null
  const rect = readRect(m.rect)
  const at = readTap({ type: 'tap', x: m.x, y: m.y })
  return rect && at && { id: m.id, rect, x: at.x, y: at.y }
}

/** A host's read of `highlight-removed` (`removeHighlight` done): `{ key, id }`, or null. */
export function readHighlightRemoved(m) {
  return m && typeof m === 'object' && m.type === 'highlight-removed' && typeof m.key === 'string' && isId(m.id) ? { key: m.key, id: m.id } : null
}

/** A note as a host saves it: trimmed, at most MAX_NOTE; blank is none (null). */
export function noteOf(text) {
  const t = typeof text === 'string' ? text.trim().slice(0, MAX_NOTE) : ''
  return t ? t : null
}
