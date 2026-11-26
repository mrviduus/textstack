// Bookmarks (#1314). A bookmark is a highlight of the open book's entry whose colour is `BOOKMARK_COLOR`: it is stored,
// synced and tombstoned exactly as a highlight is (the hosts' stores and the V2 annotation carry it unchanged; ADR-031
// "Amended 2026-11-15"), and never drawn. Its text is the first words at its place, so it is found again where that
// text still is, as a highlight is. Pure, page and both hosts: the range and text a bookmark keeps, whether one is at
// the top of the screen, the page's `bookmark-list` builder and the hosts' reader of it (the page renders untrusted
// book content).
import { isBookmark } from '../../shared/src/reader/pageStore'
import { blockOf, brBetween, rangeRoot, rangesIn, textPartsIn } from './text'
import { listItems, readItems } from './highlights.mjs'
import { isBookKey } from './openTracker.mjs'

export { isBookmark }
/** At most this many UTF-16 units of text kept with a bookmark (its `selectedText`; its list label). */
export const BOOKMARK_TEXT = 120

/**
 * The range a bookmark made on `visible` (the range on screen, a relocate's) keeps: from its first non-white-space
 * character, at most `max` UTF-16 units of the book's text (text.ts's: no script, style or noscript), never past
 * the screen's end, never cut inside a surrogate pair, ending at its last non-white-space character. Null when there
 * is no text on screen (an image page, a blank one).
 */
export function bookmarkRange(visible, max = BOOKMARK_TEXT) {
  if (!visible) return null
  const parts = textPartsIn(visible)
  const text = parts.map((p) => p.node.data.slice(p.from, p.to)).join('')
  const start = text.search(/\S/)
  if (start < 0) return null
  let end = Math.min(text.length, start + max)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  // Offsets in the text of the nodes on screen: the first one's own data starts `from` before the screen's text.
  return rangesIn(rangeRoot(visible), parts.map((p) => p.node))(parts[0].from + start, text.slice(start, end).trimEnd().length)
}

/**
 * The text a bookmark keeps for `range`, as a label reads: the book's text in it (no script, style or noscript), with a
 * space where two pieces sit in different blocks (text.ts `blockOf`) or a `<br>` stands between them (a range's
 * own text glues a heading to the paragraph after it, and one line to the next). Compared with itself on restore:
 * `bookmarkText` of the range at the CFI, white space ignored.
 */
export function bookmarkText(range) {
  const root = rangeRoot(range)
  const brs = [...root.querySelectorAll('br')]
  let text = ''
  let prev = null
  for (const { node, from, to } of textPartsIn(range)) {
    const piece = node.data.slice(from, to)
    const apart = prev && (blockOf(prev, root) !== blockOf(node, root) || brBetween(brs, prev, node))
    if (apart && !/\s$/.test(text) && !/^\s/.test(piece)) text += ' '
    text += piece
    prev = node
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
 * How many lines of text `rects` (a range's client rects) lie on: rects are one line while each starts within half
 * its size of the line's start along the block axis (down the page; across it in a vertical book). Counted from the
 * live layout, so it holds at any font size, line height or device pixel ratio.
 */
export function lineCount(rects, vertical = false) {
  const lines = [...rects]
    .map((r) => (vertical ? { at: r.left, size: r.width } : { at: r.top, size: r.height }))
    .filter((r) => r.size > 0)
    .sort((a, b) => a.at - b.at)
  let count = 0
  let line = null
  for (const r of lines) {
    if (line && r.at - line.at <= Math.min(line.size, r.size) / 2) continue
    line = r
    count++
  }
  return count
}

/** The first of `rects` with a size along the block axis (a range's first line), or undefined. */
export const firstLine = (rects, vertical = false) => [...rects].find((r) => (vertical ? r.width : r.height) > 0)

/** In scrolled flow a bookmark up to this many lines above the screen's first whole line is at the top (`atTop`). */
export const TOP_LINES_ABOVE = 2

/**
 * `mark` (a bookmark's range) is at the top of the screen whose first words are `place` (`bookmarkRange` of the range
 * on screen): the place being read is bookmarked.
 * - It starts where `place` does, or after it on the same line.
 * - In scrolled flow also up to `TOP_LINES_ABOVE` lines above: foliate's visible range there starts at the first line
 *   wholly below the viewport's top, so the line a jump anchors at the top (and, reopened one line on, the line just
 *   above the viewport) is before it.
 * Never one further down the screen, never one on the page before in paginated flow. `rects`: a range's client rects
 * (the live layout); a test passes its own. `placeLine`: `firstLine` of `place` on demand, for a caller asking many marks to measure it once.
 */
export function atTop(place, mark, { scrolled = false, vertical = false, rects = (r) => r.getClientRects(), placeLine } = {}) {
  try {
    const order = mark.compareBoundaryPoints(0 /* Range.START_TO_START */, place)
    if (order === 0) return true
    if (order < 0 && !scrolled) return false
    // #1354: a mark starting on a line below the place's first is never at the top, decided by first lines alone (each
    // placed bookmark of the section is asked on every relocate; a span to one far below is long). No line: the span.
    const m = order > 0 && firstLine(rects(mark), vertical)
    const p = m && (placeLine ? placeLine() : firstLine(rects(place), vertical))
    if (m && p && lineCount([p, m], vertical) > 1) return false
    const [first, last] = order < 0 ? [mark, place] : [place, mark]
    // From the earlier start through the later one's first character: every line between them, both ends' included.
    const span = first.cloneRange()
    span.setEnd(last.startContainer, Math.min(last.startOffset + 1, last.startContainer.length ?? last.startOffset))
    const lines = lineCount(rects(span), vertical)
    return lines > 0 && lines <= (order < 0 ? TOP_LINES_ABOVE + 1 : 1)
  } catch { return false }   // another document's range, a detached node
}

/**
 * #1350: a page-based book's bookmark (PDF, CBZ, pre-paginated EPUB) marks a whole page, and its label is where it is:
 * "<the TOC entry covering it> · p. <page>" (`page`: the page's label from the book's page list, else its 1-based
 * number), "p. <page>" with no entry. Stored as the bookmark's `selectedText` (synced: plain English, not the UI's).
 */
export function pageBookmarkText(title, page) {
  const cap = (s, n) => Array.from(String(s ?? '').trim()).slice(0, n).join('')
  const t = cap(title, 100)
  const p = `p. ${cap(page, 20)}`
  return t ? `${t} · ${p}` : p
}

/** #1350: the id of the placed bookmark on page (section) `index` of a page-based book, or null. */
export const pageBookmarkOn = (highlights, placed, index) =>
  highlights.find((h) => isBookmark(h) && placed.has(h.id) && h.index === index)?.id ?? null

/**
 * The page's `bookmark-list` items: the entry's bookmarks found in this file (`placed`: their ids), in book order, each
 * `{ id, cfi, text, at }` (highlights.mjs `listItems`, the highlights' builder).
 */
export const bookmarkList = (highlights, placed, compare) => listItems(highlights.filter(isBookmark), placed, compare)

/**
 * A host's read of `bookmark-list`: `{ key, bookmarks, here, can, placing }`, malformed items dropped (highlights.mjs
 * `readItems`); `here` only when it is one of the items; null for a malformed message or, given `open` (the host's open
 * key), another book's (openTracker.mjs `isBookKey`). A message without `bookmarks` (#1354: the list unchanged) keeps
 * `prev`'s (the host's last read), null when `prev` is not that book's.
 */
export function readBookmarkList(m, { open, prev } = {}) {
  if (!m || typeof m !== 'object' || m.type !== 'bookmark-list' || typeof m.key !== 'string') return null
  if (open !== undefined && !isBookKey(m.key, open)) return null
  let bookmarks
  if (m.bookmarks === undefined && isBookKey(m.key, prev?.key ?? null)) bookmarks = prev.bookmarks
  else if (Array.isArray(m.bookmarks)) bookmarks = readItems(m.bookmarks)
  else return null
  return { key: m.key, bookmarks, here: bookmarks.some((b) => b.id === m.here) ? m.here : null, can: m.can === true, placing: m.placing === true }
}
