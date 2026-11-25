// "Discuss this chapter" (#1316): what a chapter is on the V2 reader, its text, and the hosts' reads of the page's
// two messages about it. A chapter is a contents entry (owner decision 2026-11-15); a book with no contents has its
// spine sections for chapters. Pure but for `startsIn` and `textBetween`, which read a DOM they are handed. Used by
// the page and both hosts (bundled: it imports packages/shared, as selection.mjs does).
//
// Where chapters start and end (the default taken, README "Discuss this chapter"), ONE rule, the document's order:
// each entry starts at its place in its file (`startsIn`: an entry with no anchor at the file's top; an anchor the
// file lacks at the top for the file's first entry in the list, nowhere for a later one); a chapter runs from its
// start to the next start in reading order, whatever the order of the list and wherever the file boundary is: over
// the files with no start of their own, and into the next start's file up to it. The last chapter ends with the
// book. The page decides the chapter that ended and the chapter's text by this rule only (never foliate's current
// entry, which goes by the list).
import { isReviewableChapter } from '../../shared/src/lib/chapterReviewUi'
import { clip } from '../../shared/src/reader/textAnchor'
import { readToc } from './toc.mjs'

/** The server's cap on a share's text (`SyncLimits.MaxChapterTextBytes`), as UTF-8. */
export const MAX_CHAPTER_TEXT_BYTES = 200 * 1024
const MAX_INDEX = 100000
/** The longest `chapter-text` request id: the page answers none longer, a host reads none longer. */
export const MAX_REQUEST = 64
const MAX_TITLE = 200

const whole = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_INDEX
const samePlace = (a, b) => a.sec === b.sec && a.at === b.at

/**
 * The place a contents entry leads to, from foliate's `resolveHref(href)` answer `{ index, anchor }`:
 * `{ sec, at, top, anchor }` (`at` the href, what tells two places of one section apart; `top`: the href names the
 * file only, no fragment: the file's start; `anchor(doc)` finds its element in that section's document), or null
 * when it names no section of a book of `sections` sections.
 */
export function placeOf(resolved, href, sections) {
  const sec = resolved?.index
  if (!Number.isInteger(sec) || sec < 0 || sec >= sections || typeof href !== 'string') return null
  return { sec, at: href, top: !href.includes('#'), anchor: typeof resolved.anchor === 'function' ? resolved.anchor : null }
}

const ELEMENT = 1, FOLLOWING = 4
const elementAt = (place, doc) => {
  const a = place?.anchor?.(doc)
  return a?.nodeType === ELEMENT ? a : null
}

/**
 * Where the chapters of section `sec` start in its document `doc`, in document order: `[{ owner, members, el }]`,
 * `el` the start's element (null: the file's top). An entry with no fragment starts at the file's top; one whose
 * anchor the file does not have starts there too when no entry before it in the list leads into this file at
 * another href, and nowhere otherwise (it is left out: never a chapter, its text unavailable). An element that
 * contains another entry's element comes before it (a `<section id>` around a chapter's subsections). Entries at the
 * same start are one group, named by the last of them in the list (the most specific: "Chapter 1" under "Part One").
 */
export function startsIn(places, sec, doc) {
  const groups = []
  places.forEach((p, i) => {
    if (!p || p.sec !== sec) return
    let el = p.top ? null : elementAt(p, doc)
    if (!p.top && !el && places.slice(0, i).some((q) => q && q.sec === sec && !samePlace(q, p))) return
    const same = groups.find((g) => g.el === el)
    if (same) {
      same.members.push(i)
      same.owner = i
    } else groups.push({ owner: i, members: [i], el })
  })
  // Stable: the top first, then by position (an ancestor before what it contains).
  return groups.sort((a, b) => (!a.el ? -1 : !b.el ? 1 : a.el.compareDocumentPosition(b.el) & FOLLOWING ? -1 : 1))
}

/**
 * What another file's chapter-end and chapter-text questions need of section `sec`, from any document of it:
 * `owners` (its starts' entries in document order) and `top` (its first start has nothing to read before it: a
 * chapter running into this file ends with the file before).
 */
export function fileSummary(places, sec, doc) {
  const groups = startsIn(places, sec, doc)
  return { owners: groups.map((g) => g.owner), top: groups.length > 0 && (!groups[0].el || textBetween(doc, null, groups[0].el).length === 0) }
}

/**
 * The chapters of one file in reading order, `[{ owner, from, to, last }]` from its starts (`startsIn`): the text
 * before the first start is `carry`'s (the chapter running in from an earlier file; null: none, that text is no
 * chapter's); each start runs to the next one, the last to the file's end (`last`: whether it ends there is the
 * next file's question).
 */
export function segmentsIn(groups, carry) {
  const out = []
  if (!groups.length || groups[0].el) out.push({ owner: carry, from: null, to: groups[0]?.el ?? null, last: !groups.length })
  groups.forEach((g, k) => out.push({ owner: g.owner, from: g.el, to: groups[k + 1]?.el ?? null, last: k === groups.length - 1 }))
  return out
}

/** A book has contents when an entry of them leads somewhere: the page's one rule; a host never re-derives it. */
export const hasContents = (places) => places.some(Boolean)

/** The key a chapter's share and checkpoints carry: stable for one file version, never a title. */
export const chapterKey = ({ tocIndex, section }) => (whole(tocIndex) ? `toc-${tocIndex}` : `section-${section}`)

/**
 * Where each spine section starts on the 0–1 scale of `relocate.fraction`: foliate's SectionProgress (a linear
 * section's share by byte size; a non-linear or empty one takes none), computed from `sections` so a book made without
 * the view (`describe(id, url)`) has it too.
 */
export function sectionStarts(sections) {
  const sizes = sections.map((s) => (s?.linear !== 'no' && s?.size > 0 ? s.size : 0))
  const total = sizes.reduce((a, b) => a + b, 0)
  let sum = 0
  return sizes.map((size) => {
    const at = total ? sum / total : 0
    sum += size
    return at
  })
}

/**
 * ADR-033 P3: the book's contents as the server keeps them, `[{ key, title, depth, fraction }]` in reading order. `toc`
 * is the page's flat list (`opened.toc`), read as hosts read it (`readToc`: label, depth); `resolveHref` foliate's.
 * Keys by `chapterKey`: an entry that leads somewhere is `toc-<its index>`, its title its label, its fraction where its
 * section starts (section precision: an anchor's place inside its file is not measured). A book with no contents (the
 * page's one rule, `hasContents`) has its linear spine sections, `section-<index>`, titled "Section <n>" (the server
 * needs a title; a section has none of its own); a fixed layout with no contents has none (no chapters there).
 */
export async function tocEntries(toc, sections, resolveHref, fixedLayout = false) {
  const starts = sectionStarts(sections)
  const places = []
  for (const t of toc) {
    try { places.push(placeOf(await resolveHref(t.href), t.href, sections.length)) } catch { places.push(null) }
  }
  if (hasContents(places)) {
    return readToc({ toc }).flatMap((e) => {
      const p = places[e.index]
      return p ? [{ key: chapterKey({ tocIndex: e.index }), title: e.label, depth: e.depth, fraction: starts[p.sec] }] : []
    })
  }
  if (fixedLayout) return []
  return sections.flatMap((s, i) => (s?.linear !== 'no' ? [{ key: chapterKey({ tocIndex: null, section: i }), title: `Section ${i + 1}`, depth: 0, fraction: starts[i] }] : []))
}

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
    const s = current.replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim()
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
      if (!text) text = clip(p, Math.floor(cap / 3))
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
  const title = typeof e.title === 'string' ? clip(e.title.trim(), MAX_TITLE) : ''
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
