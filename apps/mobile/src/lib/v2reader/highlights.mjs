// Highlights (#1312): the palette, the page's `highlight-list` builder and the hosts' readers of the page's highlight
// messages (`highlight-list`, `highlight-tap`, `highlight-removed`), in `readSelection`'s style. Pure, page and both
// hosts. The page renders untrusted book content: a host takes these only through the readers here.
import { isCfi, readRect } from './selection.mjs'
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
/** A highlight id as the page holds it: a v4 or the server's UUID, or a pre-#1078 `h…` one. */
export const isId = (id) => typeof id === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(id)

/**
 * The one list builder (highlights here, bookmarks in bookmarks.mjs, #1314): the entry's items whose id is in `ids`, in
 * book order (`compare`: foliate's CFI compare; a tie by creation time), each `{ id, cfi, text, at }` with its `color`
 * when `color` is asked for; `text` cut to `MAX_LIST_TEXT` code points, at most `MAX_LIST` items.
 */
export function listItems(highlights, ids, compare, color = false) {
  return highlights
    .filter((h) => ids.has(h.id))
    .map((h) => ({ id: h.id, cfi: h.cfi, ...(color ? { color: colorOf(h.color) } : {}), text: cut(h.selectedText ?? h.quote), at: Number.isFinite(h.at) ? h.at : null }))
    .sort((a, b) => compare(a.cfi, b.cfi) || (a.at ?? 0) - (b.at ?? 0))
    .slice(0, MAX_LIST)
}

const cut = (text) => Array.from(text ?? '').slice(0, MAX_LIST_TEXT).join('')

/**
 * The page's `highlight-list` items: the entry's highlights drawn on screen (`drawn`: their ids), each with its colour;
 * then the quotations (#1195, legacy anchor annotations: `quotation: true`, `cfi` '', nowhere to go), oldest first.
 */
export const highlightList = (highlights, drawn, compare, quotes = []) => [
  ...listItems(highlights, drawn, compare, true),
  ...quotes.map((q) => ({ id: q.id, cfi: '', color: colorOf(q.color), text: cut(q.selectedText), at: Number.isFinite(q.at) ? q.at : null, quotation: true }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
].slice(0, MAX_LIST)

/**
 * The one item reader of a host (a `highlight-list`'s items, a `bookmark-list`'s): the well-formed ones of `list`, at
 * most `MAX_LIST`, each `{ id, cfi, text, at }` with its `color` when asked for; a malformed item is dropped. A
 * highlight list's quotation (#1195) is `{ …, cfi: '', quotation: true }`.
 */
export function readItems(list, color = false) {
  const items = []
  for (const h of list.slice(0, MAX_LIST)) {
    if (!h || typeof h !== 'object' || !isId(h.id) || typeof h.text !== 'string' || h.text.length > 2 * MAX_LIST_TEXT) continue
    const quotation = color && h.quotation === true && h.cfi === ''
    if (!quotation && !isCfi(h.cfi)) continue
    items.push({ id: h.id, cfi: h.cfi, ...(color ? { color: colorOf(h.color) } : {}), text: h.text, at: Number.isFinite(h.at) ? h.at : null, ...(quotation ? { quotation: true } : {}) })
  }
  return items
}

/**
 * The drawn highlight over exactly `cfi` (`drawn`: the drawn ids), or undefined: a new highlight there would be a twin
 * (#1312 review).
 * ponytail: one deleted on another device during this session (the page does not know until the host tells it: web on a
 * 409 or a tap, Android when the notes are read again) is still reused, so highlighting its exact range again loses the
 * new highlight. If that matters: a host that knows it is deleted makes the page take a new id instead.
 */
export const sameRangeHighlight = (highlights, cfi, drawn) => highlights.find((h) => h.cfi === cfi && drawn.has(h.id))

/** A host's read of `highlight-list`: `{ key, highlights }`, malformed items dropped; null for a malformed message. */
export function readHighlightList(m) {
  if (!m || typeof m !== 'object' || m.type !== 'highlight-list' || typeof m.key !== 'string' || !Array.isArray(m.highlights)) return null
  return { key: m.key, highlights: readItems(m.highlights, true) }
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

/**
 * A note as a host saves it: trimmed; blank is none (null). Never cut (#1312 review): the server has no cap, and a note
 * written elsewhere (MCP, the legacy reader) may be longer than any cap here, which an edit would truncate.
 */
export function noteOf(text) {
  const t = typeof text === 'string' ? text.trim() : ''
  return t ? t : null
}

/**
 * What an editor's save writes: the note, or undefined when the draft is the note the editor opened with (#1312
 * review: nothing to write, so a note the host had not read yet is never cleared by a save that changed nothing).
 */
export function noteChange(draft, shown) {
  const n = noteOf(draft)
  return n === noteOf(shown) ? undefined : n
}
