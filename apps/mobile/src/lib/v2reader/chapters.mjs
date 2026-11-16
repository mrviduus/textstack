// "Discuss this chapter" (#1316): what a chapter is on the V2 reader, its text, and the hosts' reads of the page's
// two messages about it. A chapter is a contents entry (owner decision 2026-11-15); a book with no contents has its
// spine sections for chapters. Pure but for `boundsIn` and `textBetween`, which read a DOM they are handed. Used by
// the page and both hosts (bundled: it imports packages/shared, as selection.mjs does).
//
// Where a chapter ends (the default taken, README "Discuss this chapter"): just before the next entry in the
// contents, at any depth, that leads somewhere else, wherever the file boundary is: an entry's text runs over the
// files before that entry and into its file up to its anchor; several entries in one file each end where the next
// one's anchor starts (the next one in the document, whatever the order of the list); the last entry ends with
// the book.
import { isReviewableChapter } from '../../../../../packages/shared/src/lib/chapterReviewUi'

/** The server's cap on a share's text (`SyncLimits.MaxChapterTextBytes`), as UTF-8. */
export const MAX_CHAPTER_TEXT_BYTES = 200 * 1024
/** The server's caps on a share's key and title (`SyncLimits.MaxChapterKey`, `MaxChapterTitle`). */
export const MAX_CHAPTER_KEY = 200
export const MAX_CHAPTER_TITLE = 500
const MAX_INDEX = 100000
const MAX_REQUEST = 64
const MAX_TITLE = 200

const whole = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_INDEX
const samePlace = (a, b) => a.sec === b.sec && a.at === b.at

/**
 * The place a contents entry leads to, from foliate's `resolveHref(href)` answer `{ index, anchor }`:
 * `{ sec, at, anchor }` (`at` the href, what tells two places of one section apart; `anchor(doc)` finds its
 * element in that section's document), or null when it names no section of a book of `sections` sections.
 */
export function placeOf(resolved, href, sections) {
  const sec = resolved?.index
  if (!Number.isInteger(sec) || sec < 0 || sec >= sections || typeof href !== 'string') return null
  return { sec, at: href, anchor: typeof resolved.anchor === 'function' ? resolved.anchor : null }
}

const ELEMENT = 1, FOLLOWING = 4
const elementAt = (place, doc) => {
  const a = place?.anchor?.(doc)
  return a?.nodeType === ELEMENT ? a : null
}

/**
 * The chapter of entry `tocIndex`, of `places` (one per entry of the page's flat contents, null where the entry
 * leads nowhere), or null for no such entry:
 * - `start`: where it begins;
 * - `inSection`: the other entries of the same section at another href, listed before it or after: the chapter
 *   ends at the nearest of them after its start in that document (`boundsIn`: a contents list may name places out
 *   of order, or anchors the file does not have);
 * - `next`: the first later entry in a later section: with none of `inSection` after the start, the chapter runs
 *   up to it, over every file between and into its file, up to its anchor. Null: the book's last chapter;
 * - `startShared`: an earlier entry leads into the same section at another href, so the start of the section is
 *   not this chapter's: with its own anchor not found, the chapter cannot be told from that one.
 */
export function chapterOf(places, tocIndex) {
  const start = whole(tocIndex) ? places[tocIndex] : null
  if (!start) return null
  const inSection = places.filter((p) => p && p.sec === start.sec && !samePlace(p, start))
  const next = places.slice(tocIndex + 1).find((p) => p && p.sec > start.sec) ?? null
  const startShared = places.slice(0, tocIndex).some((p) => p && p.sec === start.sec && !samePlace(p, start))
  return { start, inSection, next, startShared }
}

/**
 * A chapter's part in the document `doc` of section `sec` (one of its files): `{ from, to, more }`: from element
 * `from` (null: the document's start) up to element `to` (null: its end), `more` when the chapter goes on in the
 * files after. Or `{ none: true }`: nothing of this document is the chapter's (the next chapter starts with it).
 * Or `{ refuse: true }`: the chapter's own anchor is not in its file and an earlier entry leads into the same
 * file, so where it starts cannot be told (sharing the file from its top would be that other chapter's text
 * under this one's title). An anchor not found with no such entry is the file's start.
 */
export function boundsIn(chapter, sec, doc) {
  const { start, inSection, next, startShared } = chapter
  if (sec === start.sec) {
    const from = elementAt(start, doc)
    if (!from && startShared) return { refuse: true }
    // The nearest one after the start in the document, whatever the list's order: an entry placed before the
    // start, inside it, or at an anchor the file does not have ends nothing.
    let to = null
    for (const p of inSection) {
      const el = elementAt(p, doc)
      if (!el || (from && (!(from.compareDocumentPosition(el) & FOLLOWING) || from.contains(el)))) continue
      if (!to || el.compareDocumentPosition(to) & FOLLOWING) to = el
    }
    return to ? { from, to, more: false } : { from, to: null, more: true }
  }
  if (next && sec === next.sec) {
    const to = elementAt(next, doc)
    return to ? { from: null, to, more: false } : { none: true }
  }
  return { from: null, to: null, more: true }
}

/** A book has contents when an entry of them leads somewhere: the page's one rule; a host never re-derives it. */
export const hasContents = (places) => places.some(Boolean)

/**
 * The entry whose chapter ends where entry `tocIndex` starts, in the document `doc` of its section: the nearest
 * entry of that file placed before it in the document (whatever the list's order), else, with none there, the
 * nearest earlier entry of the list in an earlier file (its chapter runs into this file). Null: none.
 */
export function chapterBefore(places, tocIndex, doc) {
  const at = whole(tocIndex) ? places[tocIndex] : null
  const from = elementAt(at, doc)
  if (!at || !from) return null
  let best = null
  let bestEl = null
  for (const [i, p] of places.entries()) {
    if (!p || p.sec !== at.sec || samePlace(p, at)) continue
    const el = elementAt(p, doc)
    // Before the start, and the nearest so far: it follows the best one.
    if (!el || !(el.compareDocumentPosition(from) & FOLLOWING) || el.contains(from)) continue
    if (!bestEl || bestEl.compareDocumentPosition(el) & FOLLOWING) [best, bestEl] = [i, el]
  }
  if (best !== null) return best
  for (let i = tocIndex - 1; i >= 0; i--) if (places[i] && places[i].sec < at.sec) return i
  return null
}

/** The key a chapter's share and checkpoints carry: stable for one file version, never a title. */
export const chapterKey = ({ tocIndex, section }) => (whole(tocIndex) ? `toc-${tocIndex}` : `section-${section}`)

const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'])
const SKIPPED = new Set(['script', 'style', 'template', 'head', 'title', 'noscript', 'svg', 'math', 'rt', 'rp'])
const tag = (el) => el.localName?.toLowerCase() ?? ''
/**
 * Marked as not for reading, as far as markup says it (the document is not laid out: no style is computed): a
 * page-break marker (its print page number), `hidden`, `aria-hidden`, an inline `display: none`.
 * ponytail: text hidden by a stylesheet rule is still read; lay the document out if a book's share shows it.
 */
const unread = (el) => el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true'
  || /(^|\s)(doc-)?pagebreak(\s|$)/.test(`${el.getAttribute('epub:type') ?? ''} ${el.getAttribute('role') ?? ''}`)
  || /display\s*:\s*none/i.test(el.getAttribute('style') ?? '')

/**
 * The text of `doc` from element `from` (null: its start) up to element `to` (null: its end), as paragraphs:
 * one string per block, whitespace collapsed, soft hyphens dropped, empty ones left out. Text only: no markup,
 * no script or style content, no image.
 */
export function textBetween(doc, from, to) {
  const root = doc.body ?? doc.documentElement
  const out = []
  if (!root) return out
  const CONTAINED_BY = 16
  // NodeFilter's values (the page's section documents and jsdom agree): SHOW_ELEMENT | SHOW_TEXT, FILTER_REJECT, FILTER_ACCEPT.
  const walker = doc.createTreeWalker(root, 1 | 4, { acceptNode: (n) => (n.nodeType === 1 && (SKIPPED.has(tag(n)) || unread(n)) ? 2 : 1) })
  let started = !from
  let block = null
  let current = ''
  let broke = false
  const flush = () => {
    const s = current.replace(/­/g, '').replace(/\s+/g, ' ').trim()
    if (s) out.push(s)
    current = ''
  }
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (to && (n === to || to.compareDocumentPosition(n) & (FOLLOWING | CONTAINED_BY))) break
    if (!started) {
      if (n !== from && !(from.compareDocumentPosition(n) & (FOLLOWING | CONTAINED_BY))) continue
      started = true
    }
    if (n.nodeType === 1) {
      if (tag(n) === 'br') broke = true
      continue
    }
    let b = n.parentNode
    while (b && b !== root && !BLOCKS.has(tag(b))) b = b.parentNode
    if (b !== block || broke) flush()
    block = b
    broke = false
    current += n.data
  }
  flush()
  return out
}

/**
 * Whether a host offers Discuss for the chapter whose end is on screen (`readChapterEnd`): any, but front and back
 * matter by its title (the legacy readers' rule, `isReviewableChapter`: Cover, Title Page, Copyright, Contents…).
 * A chapter with no title (a book with no contents, an entry with a blank label) is offered. The legacy rule's
 * word minimum is not applied: the page does not count a chapter's words at a page turn (its files are not all
 * loaded); it reports no end for a chapter with no text at all.
 */
export function offersDiscuss(chapterEnd) {
  return !!chapterEnd && (chapterEnd.title === null || isReviewableChapter({ title: chapterEnd.title }))
}

const utf8Encoder = new TextEncoder()
// Named apart from the page's own `bytes` (a book's): the bundle keeps both names as written.
const utf8Size = (s) => utf8Encoder.encode(s).length

/**
 * Paragraphs joined into a share's text within the server's cap: `{ text, cut }`. `cut`: the chapter is longer
 * and the text stops at the last whole paragraph that fits (a first paragraph over the cap alone is cut at a
 * character). Never silent: the hosts tell the reader, and the handoff says so.
 */
export function fitText(paragraphs, cap = MAX_CHAPTER_TEXT_BYTES) {
  let text = ''
  let size = 0
  for (const p of paragraphs) {
    const add = (text ? 2 : 0) + utf8Size(p)
    if (size + add > cap) {
      // ponytail: a UTF-16 unit is at most 3 UTF-8 bytes, so cap / 3 units always fit; a tighter cut needs an encoder loop.
      if (!text) text = p.slice(0, Math.floor(cap / 3)).replace(/[\ud800-\udbff]$/, '')
      return { text, cut: true }
    }
    text += (text ? '\n\n' : '') + p
    size += add
  }
  return { text, cut: false }
}

/**
 * A host's read of `relocate.chapterEnd`, or of `chapter-end` (the same, said after its relocate once the page
 * knew it), never throws: the chapter whose end is on screen,
 * `{ tocIndex, section, title }` (`tocIndex` the entry's index in `opened.toc`, null in a book with no contents;
 * `section` the spine section shown; `title` the entry's label as the page read it, text, cut to 200, null when
 * blank or in a book with no contents), or null: none, or anything malformed. The page renders the book: nothing
 * else is taken. What the page says is the rule: a host does not look the entry up in its own contents.
 */
export function readChapterEnd(m) {
  const e = m?.type === 'relocate' || m?.type === 'chapter-end' ? m.chapterEnd : null
  if (!e || typeof e !== 'object' || !whole(e.section)) return null
  if (e.tocIndex != null && !whole(e.tocIndex)) return null
  const title = typeof e.title === 'string' ? e.title.trim().slice(0, MAX_TITLE) : ''
  return { tocIndex: e.tocIndex ?? null, section: e.section, title: title || null }
}

/**
 * A host's read of the page's `chapter-text` answer (never throws): `{ request, text, cut }`, or `{ request, error }`
 * (`empty`: no text in that chapter; `unavailable`: no such chapter, or a book whose text the page cannot read),
 * or null: not that message, no request id, a text over the server's cap (the page never sends one).
 */
export function readChapterText(m) {
  if (m?.type !== 'chapter-text' || typeof m.request !== 'string' || !m.request || m.request.length > MAX_REQUEST) return null
  const request = m.request
  if (typeof m.text !== 'string') return { request, error: m.error === 'empty' ? 'empty' : 'unavailable' }
  if (!m.text.trim()) return { request, error: 'empty' }
  if (utf8Size(m.text) > MAX_CHAPTER_TEXT_BYTES) return null
  return { request, text: m.text, cut: m.cut === true }
}
