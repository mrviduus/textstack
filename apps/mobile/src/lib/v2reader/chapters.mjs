// "Discuss this chapter" (#1316): what a chapter is on the V2 reader, its text, and the hosts' reads of the page's
// two messages about it. A chapter is a contents entry (owner decision 2026-11-15); a book with no contents has its
// spine sections for chapters. Pure but for `textBetween`, which walks a DOM it is handed. Used by the page and
// both hosts.
//
// Where a chapter ends (the default taken, README "Discuss this chapter"): just before the next entry in the
// contents, at any depth, that leads somewhere else. An entry over several files ends with the last file before
// that entry; several entries in one file each end where the next one's anchor starts; the last entry ends with
// the book.

/** The server's cap on a share's text (`SyncLimits.MaxChapterTextBytes`), as UTF-8. */
export const MAX_CHAPTER_TEXT_BYTES = 200 * 1024
/** The server's caps on a share's key and title (`SyncLimits.MaxChapterKey`, `MaxChapterTitle`). */
export const MAX_CHAPTER_KEY = 200
export const MAX_CHAPTER_TITLE = 500
const MAX_INDEX = 100000
const MAX_REQUEST = 64

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

/**
 * The chapter of entry `tocIndex`, of `places` (one per entry of the page's flat contents, null where the entry
 * leads nowhere): `{ start, end }`, `end` the place of the first later entry that leads further on (a later
 * section, or another href of the same one) and null for the book's last chapter. Null: no such entry.
 */
export function chapterOf(places, tocIndex) {
  const start = whole(tocIndex) ? places[tocIndex] : null
  if (!start) return null
  for (let i = tocIndex + 1; i < places.length; i++) {
    const p = places[i]
    if (p && (p.sec > start.sec || (p.sec === start.sec && !samePlace(p, start)))) return { start, end: p }
  }
  return { start, end: null }
}

/**
 * The entry whose chapter ends where entry `tocIndex` starts: the nearest earlier entry at another place, as the
 * contents list them. Null: none (the first chapter, or an entry that leads nowhere).
 */
export function chapterBefore(places, tocIndex) {
  const at = whole(tocIndex) ? places[tocIndex] : null
  if (!at) return null
  for (let i = tocIndex - 1; i >= 0; i--) if (places[i] && !samePlace(places[i], at)) return i
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
 * The text of `doc` from element `from` (null: its start) up to element `to` (null: its end), as paragraphs:
 * one string per block, whitespace collapsed, soft hyphens dropped, empty ones left out. Text only: no markup,
 * no script or style content, no image.
 */
export function textBetween(doc, from, to) {
  const root = doc.body ?? doc.documentElement
  const out = []
  if (!root) return out
  const FOLLOWING = 4, CONTAINED_BY = 16
  // NodeFilter's values (the page's section documents and jsdom agree): SHOW_ELEMENT | SHOW_TEXT, FILTER_REJECT, FILTER_ACCEPT.
  const walker = doc.createTreeWalker(root, 1 | 4, { acceptNode: (n) => (n.nodeType === 1 && SKIPPED.has(tag(n)) ? 2 : 1) })
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

const utf8 = new TextEncoder()
const bytes = (s) => utf8.encode(s).length

/**
 * Paragraphs joined into a share's text within the server's cap: `{ text, cut }`. `cut`: the chapter is longer
 * and the text stops at the last whole paragraph that fits (a first paragraph over the cap alone is cut at a
 * character). Never silent: the hosts tell the reader, and the handoff says so.
 */
export function fitText(paragraphs, cap = MAX_CHAPTER_TEXT_BYTES) {
  let text = ''
  let size = 0
  for (const p of paragraphs) {
    const add = (text ? 2 : 0) + bytes(p)
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
 * A host's read of `relocate.chapterEnd` (never throws): the chapter whose end is on screen, `{ tocIndex, section }`
 * (`tocIndex` the entry's index in `opened.toc`, null in a book with no contents; `section` the spine section
 * shown), or null: none, or anything malformed. The page renders the book: nothing else is taken.
 */
export function readChapterEnd(m) {
  const e = m?.type === 'relocate' ? m.chapterEnd : null
  if (!e || typeof e !== 'object' || !whole(e.section)) return null
  if (e.tocIndex != null && !whole(e.tocIndex)) return null
  return { tocIndex: e.tocIndex ?? null, section: e.section }
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
  if (bytes(m.text) > MAX_CHAPTER_TEXT_BYTES) return null
  return { request, text: m.text, cut: m.cut === true }
}
