// Bookmarks (#1314). A bookmark is a highlight of the open book's entry whose colour is `BOOKMARK`: it is stored, synced
// and tombstoned exactly as a highlight is (the hosts' stores and the V2 annotation carry it unchanged; ADR-031 "Amended
// 2026-11-15"), and never drawn. Its text is the first words at its place, so it is found again where that text still
// is, as a highlight is. Pure, page and both hosts: the range a bookmark keeps, whether one is on screen, the page's
// `bookmark-list` builder and the hosts' reader of it (the page renders untrusted book content).
import { BOOKMARK_COLOR, isBookmark } from '../../../../../packages/shared/src/reader/v2PageStore'
import { MAX_LIST, MAX_LIST_TEXT, isCfi, isId } from './highlights.mjs'

/** The `color` that makes an entry highlight (and a V2 annotation) a bookmark (`packages/shared`'s, the one definition). Not one of `HIGHLIGHT_COLORS`. */
export const BOOKMARK = BOOKMARK_COLOR
export { isBookmark }
/** At most this many UTF-16 units of text kept with a bookmark (its `selectedText`; its list label). */
export const BOOKMARK_TEXT = 120

/**
 * The range a bookmark made on `visible` (the range on screen, a relocate's) keeps: from its first non-white-space
 * character, at most `max` UTF-16 units of text, never past the screen's end, never cut inside a surrogate pair, ending
 * at its last non-white-space character. Null when there is no text on screen (an image page, a blank one).
 */
export function bookmarkRange(visible, max = BOOKMARK_TEXT) {
  if (!visible) return null
  const root = visible.commonAncestorContainer
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
  const { startContainer: sc, startOffset: so } = visible
  const first = sc.nodeType === 3 ? sc : sc.childNodes[so] ?? sc
  walker.currentNode = first
  const out = doc.createRange()
  let started = false
  let left = max
  for (let n = first.nodeType === 3 ? first : walker.nextNode(); n && left > 0; n = walker.nextNode()) {
    if (visible.comparePoint(n, 0) > 0) break   // past the screen's end (the result is the same without it: only the walk is shorter)
    if (!visible.intersectsNode(n)) continue
    let from = n === sc ? so : 0
    const to = n === visible.endContainer ? visible.endOffset : n.data.length
    if (!started) {
      // A style sheet or script in the body is text to a range, never the words on screen.
      if (/^(script|style)$/i.test(n.parentNode?.nodeName ?? '')) continue
      const at = n.data.slice(from, to).search(/\S/)
      if (at < 0) continue
      from += at
      out.setStart(n, from)
      started = true
    }
    let end = Math.min(to, from + left)
    if (end > from && end < n.data.length && /[\uD800-\uDBFF]/.test(n.data[end - 1])) end--
    // The end follows the last non-white-space character taken: none trails the bookmark's text.
    const kept = n.data.slice(from, end).search(/\s*$/)
    if (kept > 0) out.setEnd(n, from + kept)
    left -= Math.max(end - from, 1)
  }
  return started && out.toString().trim() ? out : null
}

/**
 * The text a bookmark keeps for `range` (a `bookmarkRange`: it starts in a text node): the range's own text, with a
 * space where two pieces sit in different blocks (a range's text glues a heading to the paragraph after it). Only white
 * space differs from the text at the range, so it still reads as that text where white space is ignored (`foldText`,
 * the page's restore check).
 */
export function bookmarkText(range) {
  const { startContainer: sc, endContainer: ec, commonAncestorContainer: root } = range
  if (sc === ec || sc.nodeType !== 3) return range.toString()
  const view = root.ownerDocument.defaultView
  // The nearest ancestor that is a box of its own: not inline, not `display: contents`.
  const blockOf = (n) => {
    let e = n.parentElement
    while (e && e !== root && /^(inline|contents|ruby)/.test(view?.getComputedStyle(e).display ?? 'inline')) e = e.parentElement
    return e
  }
  // Text and CDATA sections: exactly the nodes a range's own text is made of, so only the spaces added here differ.
  const walker = root.ownerDocument.createTreeWalker(root, 12 /* NodeFilter.SHOW_TEXT | SHOW_CDATA_SECTION */)
  walker.currentNode = sc
  let text = ''
  let block = null
  for (let n = sc; n; n = walker.nextNode()) {
    const piece = n.data.slice(n === sc ? range.startOffset : 0, n === ec ? range.endOffset : n.data.length)
    if (piece) {
      const b = blockOf(n)
      if (text && b !== block && !/\s$/.test(text) && !/^\s/.test(piece)) text += ' '
      text += piece
      block = b
    }
    if (n === ec) break
  }
  return text
}

/** `range` starts on the screen `visible` shows: at or after its start, before its end (the next screen's start). */
export function startsWithin(visible, range) {
  try {
    const { startContainer: c, startOffset: o } = range
    if (visible.comparePoint(c, o) < 0) return false
    // At or past the screen's end: a range moved to start there is empty.
    const tail = visible.cloneRange()
    tail.setStart(c, o)
    return !tail.collapsed
  } catch { return false }   // another document's range, a detached node
}

/**
 * The page's `bookmark-list` items: the entry's bookmarks found in this file (`placed`: their ids), in book order
 * (`compare`: foliate's CFI compare; a tie by creation time), each `{ id, cfi, text, at }`; `text` is display only (cut).
 */
export function bookmarkList(highlights, placed, compare) {
  return highlights
    .filter((h) => isBookmark(h) && placed.has(h.id))
    .map((h) => ({ id: h.id, cfi: h.cfi, text: Array.from(h.selectedText ?? h.quote ?? '').slice(0, MAX_LIST_TEXT).join(''), at: Number.isFinite(h.at) ? h.at : null }))
    .sort((a, b) => compare(a.cfi, b.cfi) || (a.at ?? 0) - (b.at ?? 0))
    .slice(0, MAX_LIST)
}

/**
 * A host's read of `bookmark-list`: `{ key, bookmarks, here, can }`, malformed items dropped; `here` only when it is one
 * of the items; null for a malformed message.
 */
export function readBookmarkList(m) {
  if (!m || typeof m !== 'object' || m.type !== 'bookmark-list' || typeof m.key !== 'string' || !Array.isArray(m.bookmarks)) return null
  const bookmarks = []
  for (const b of m.bookmarks.slice(0, MAX_LIST)) {
    if (!b || typeof b !== 'object' || !isId(b.id) || !isCfi(b.cfi) || typeof b.text !== 'string' || b.text.length > 2 * MAX_LIST_TEXT) continue
    bookmarks.push({ id: b.id, cfi: b.cfi, text: b.text, at: Number.isFinite(b.at) ? b.at : null })
  }
  return { key: m.key, bookmarks, here: bookmarks.some((b) => b.id === m.here) ? m.here : null, can: m.can === true }
}
