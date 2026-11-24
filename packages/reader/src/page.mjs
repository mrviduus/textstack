// The V2 reader page (ADR-029), bundled alone by build.mjs into readerPage.generated.ts and run in
// the reader's WebView. foliate-js parses AND renders a local EPUB, MOBI/AZW3, FB2, CBZ or PDF (#1128: all
// but EPUB have readers that run only when such a book opens, see formatModule); this file adds word tap → host, the
// translation drawn above the word, and the reader data (position + highlights by CFI and quote, a PDF's
// position by page; one entry per book file). The host ↔ page message contract is in README.md.
import './.vendor/foliate-js/view.js'
import { Overlayer } from './.vendor/foliate-js/overlayer.js'
import { EPUB } from './.vendor/foliate-js/epub.js'
import { compare as compareCfi } from './.vendor/foliate-js/epubcfi.js'
import { BlobReader, BlobWriter, TextWriter, ZipReader, configure } from './.vendor/foliate-js/vendor/zip.js'
import { tokenizeVocabWords } from '../../shared/src/text/vocabKey'
import { SELECTION_SETTLE_MS, rangeToLocator, textNodes } from './text'
import { mergeOverlay } from './overlays.mjs'
import { STAGE_COLORS, readMarkWords, sameMark, shortGloss, wordMarksIn } from './wordMarks.mjs'
import { createSaveScheduler } from './saveScheduler.mjs'
import { isFractionOnly } from '../../shared/src/reader/fractionPosition'
import { emptyEntry, entryFor, foldText, isPdfPage, isPosition, isQuotation, quoteOf, sha1, sha256Yielding, withHighlight, withPosition } from './store.mjs'
import { uuidV4 } from './uuid.mjs'
import { openableHref, rectInPage, sentenceOf, sentenceOfRange, trimRange } from './tap.mjs'
import { MAX_SELECTION_CFI, selectionMessage } from './selection.mjs'
import { SPOKEN_FILL } from './listen.mjs'
import { navKey } from './chrome.mjs'
import { HIGHLIGHT_FILL, colorOf, highlightList, isHighlightColor, sameRangeHighlight } from './highlights.mjs'
import { atTop, bookmarkList, bookmarkRange, bookmarkText, isBookmark, startsWithin } from './bookmarks.mjs'
import { BOOKMARK_COLOR } from '../../shared/src/reader/pageStore'
import { MAX_SELECTED_TEXT } from '../../shared/src/reader/locators'
import { THEMES, readSettings, settingsCss } from './settings.mjs'
import { applyAlignment } from './alignment.mjs'
import { applyFontFamily } from './fonts.mjs'
import { checkFb2, comicName, fb2AsUtf8, imageType, isTextual, sniffFormat, zipFormat } from './formats.mjs'
import { createLightbox, imageAt } from './lightbox.mjs'
import { clipBook } from './clip.mjs'
import { tapAction } from './tapZone.mjs'
import { MAX_CHAPTER_TEXT_BYTES, fileSummary, fitText, hasContents, placeOf, segmentsIn, startsIn, textBetween, tocEntries } from './chapters.mjs'
import { MAX_RESULTS, SEARCH_FILL, readQuery, searchItems } from './search.mjs'
import { bookMeta, coverJpeg, isRequestId } from './describe.mjs'

const post = (m) => window.ReactNativeWebView?.postMessage(JSON.stringify(m))
const log = (level, msg) => post({ type: 'log', level, msg })
addEventListener('error', (e) => log('error', String(e.error?.stack ?? e.message)))
addEventListener('unhandledrejection', (e) => log('error', String(e.reason?.stack ?? e.reason)))

let view = null
/** The reading settings (#1260, settings.mjs): the defaults until the host sends the reader's. */
let look = readSettings(null)
let flow = 'paginated'   // ADR-029 Decision 1
/** The open book's format (formats.mjs) and whether it has text: a comic book has no words to tap, select or translate. */
let format = null
let textual = true
/**
 * Whether highlights and the translation label can be drawn: not on a CBZ (no text), not on a PDF (a PDF
 * highlight is a `pdf-page` anchor with page rects, not built; the fixed-layout renderer has no overlayer).
 * Sent in `opened` so a host offers neither where the page would refuse it.
 */
let annotatable = true
/** cfi → what is drawn over it; re-added when a section's overlayer is recreated (chapter navigation). */
const overlays = new Map()
/** cfi → the range foliate last drew it over (its section document's): where a tap finds a highlight (#1312). */
const drawnRanges = new Map()
/**
 * #1314, bookmarks (bookmarks.mjs: entry highlights of colour `BOOKMARK_COLOR`, never drawn):
 * - `placed`: the ids of the entry's bookmarks whose text is still at their CFI in this file (as a drawn highlight's is);
 * - `listed`: their `bookmark-list` items, built when the set changes (restore, addHighlights, add, remove), never per
 *   relocate; `listedVersion` counts its changes;
 * - `hereId`: the bookmark the place being read has (see `hereOf`), or null;
 * - `placing`: the restores and `addHighlights` calls not finished yet, and `awaitingMore`: the host said more
 *   annotations follow the restore (`restore(json, true)`): no bookmark can be made until they are placed, or one
 *   made meanwhile could be the twin of one still coming;
 * - `bookmarksSent`: what the last `bookmark-list` said (view, list version, here, can).
 */
const placed = new Set()
const placedQuotes = new Set()
let listed = []
let listedVersion = 0
let hereId = null
const placing = new Set()
let awaitingMore = false
let bookmarksSent = null
/** Test-only (formats.check.mjs): the next bookmark passes throw. */
let testBreakBookmarks = false
/** #1271: the reader's saved words (wordMarks.mjs `readMarkWords`), as the host last sent them, and whether their glosses show. */
let vocab = []
let showGlosses = false
/** #1272: the CFI of the range the host is speaking (`speaking`), drawn underlined until it says it ended; or null. */
let spokenCfi = null
/** This file's identity and its entry. No save until the stored one is restored. */
let book = null
let entry = null
/** #1195: the open book's quotations (legacy anchor annotations): listed, never drawn, never in a `store`. */
let quotes = []
/**
 * The host is moving the view: from `open` until its restore has run, and during a host `goTo` (a sync
 * adopt or move). Its relocates save nothing and nothing is echoed back: the host already holds that
 * position (`applyStates` stored it before calling). Only the reader moving saves.
 */
let hostMoving = false
/**
 * The save rule: a relocate saves the position only when the reader moved — its renderer `reason` (the
 * fork's view.js forwards it in the view's relocate) is not 'anchor' (foliate re-laying the page out: a
 * resize, a font or flow change) AND its CFI differs from the
 * previous relocate's (foliate relocates again where it already is: after a landing, and the 'snap' of
 * every touchend). `lastCfi` follows every relocate of the open book, re-layouts included.
 */
let lastCfi = null
/**
 * #1313: the navigations of the view on screen still landing (a restore, a host `goTo`, `section()`, a followed link):
 * their relocates are `cause` `nav`. Foliate reports a turn across a section with the same reason ('navigation') as a
 * jump, so only the page knows which navigations it asked for. Reset at the swap; one of a closed view never counts
 * again, however it ends.
 * ponytail: one that has not settled after NAV_BOUND_MS stops counting: the bound exists only for a navigation that
 * never settles (a hung load must not make the rest of the book a navigation); a landing slower than it (a 2 MB
 * single-file section can lay out for seconds on Android) is counted as the reader's. A restore is not bounded: its
 * own end clears `awaitingRestore`, and while it runs its relocates are `nav`.
 */
let navs = 0
const NAV_BOUND_MS = 15_000
const asNav = async (fn, bounded = true) => {
  const mine = viewSeq
  let counting = true
  const stop = () => {
    if (counting && mine === viewSeq) navs--
    counting = false
  }
  navs++
  const bound = bounded ? setTimeout(stop, NAV_BOUND_MS) : 0
  try { return await fn() } finally { clearTimeout(bound); stop() }
}
/** Test-only (formats.check.mjs; the build has no test mode): ms every restore waits before it runs. */
let testRestoreDelay = 0
/**
 * #1313: from the swap until the restore has landed, the open itself is a navigation, unless the reader acts first
 * (`readerActed`: any input the page sees, or a turn): an open whose restore never comes (the web host's failed read)
 * does not make the reader's own turns a navigation.
 */
let awaitingRestore = false
let readerActed = false
let scrollInputAt = 0
const onInput = () => { readerActed = true; scrollInputAt = Date.now() }
for (const type of ['pointerdown', 'wheel', 'keydown', 'touchstart']) document.addEventListener(type, onInput, { capture: true, passive: true })
/** A mouse moving over the book, for the web host's bars (its own document never sees it): at most one per 250 ms. Touch never. */
let lastMove = 0
const onMove = (e) => {
  const now = Date.now()
  if (e.pointerType !== 'mouse' || now - lastMove < 250) return
  lastMove = now
  post({ type: 'pointer-move' })
}
document.addEventListener('pointermove', onMove, { passive: true })
/**
 * The last `selection` sent: its range (edge whitespace dropped), text, CFI, sentence. What `highlightSelection`
 * highlights when no selection is live: kept after the selection is cleared (tapping a host button may clear the
 * WebView's selection first).
 */
let lastSelection = null
/**
 * The latest open attempt (#1128 S5). Only ever goes up, and answers one question only: may this build
 * swap in? A build that is not the latest when it is made is destroyed and never shown.
 */
let openSeq = 0
/**
 * The open whose view is on screen. Turns over exactly at the swap (`open`), never earlier: while a newer
 * book is hashed or made, the book on screen keeps reporting, saving, navigating and answering its restore.
 * Every listener and queued call is stamped with it and does nothing on a view it was not made for.
 */
let viewSeq = 0
/** The view that finished opening (`opened` posted): a restore is for that view only. */
let readySeq = 0
const saves = createSaveScheduler(post)

/**
 * Reader fonts as blob: URLs (font-src blob:), from embedded family chunks. Each family is loaded
 * once when chosen; no network, including on Android. Null only if loading fails.
 */
const fontUrls = new Map()
function fontUrl() {
  if (fontUrls.has(look.fontFamily)) return fontUrls.get(look.fontFamily)
  try {
    const fonts = formatModule(look.fontFamily)
    const faces = look.fontFamily === 'dyslexic' ? { regular: fonts.woff2 } : fonts
    const urls = Object.fromEntries(Object.entries(faces).map(([name, bytes]) => [name,
      URL.createObjectURL(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], { type: 'font/woff2' }))]))
    fontUrls.set(look.fontFamily, urls)
    return urls
  } catch (e) {
    log('warn', `${look.fontFamily} font not loaded: ${e?.message ?? e}`)
    return null
  }
}
/**
 * The settings on screen: this document's own colours (the margins, the letterbox of a fixed-layout page, which
 * has no styles to set) and the open book's sections. foliate re-lays the book out where it is (`anchor`).
 */
function applyLook() {
  const { bg, fg } = THEMES[look.theme]
  document.documentElement.dataset.readerTheme = look.theme
  for (const el of [document.documentElement, document.body]) {
    el.style.background = bg
    el.style.color = fg
  }
  if (view && !view.isFixedLayout) {
    for (const { doc } of view.renderer?.getContents?.() ?? []) {
      applyAlignment(doc, look.textAlign)
      applyFontFamily(doc, look)
    }
  }
  view?.renderer?.setStyles?.(settingsCss(look, fontUrl(), showGlosses))
}

const SVG = 'http://www.w3.org/2000/svg'
const GLOSS_COLOR = 'rgba(59, 130, 246, 0.8)'
/**
 * The product's inline translation — saved-word underline + italic label centred
 * above the word (the retired engine's LABEL_LOOK, E44). foliate calls it again with fresh rects on every
 * expand (font size, viewport), so the label follows the word without our own layout code.
 */
function glossOf(rects, text, el) {
  const g = document.createElementNS(SVG, 'g')
  const first = rects[0]
  if (!first) return g
  // The book's size at draw time (options are reused on redraw, so read it here, not when added).
  const fs = parseFloat(el?.ownerDocument?.defaultView?.getComputedStyle(el).fontSize) || 16
  const t = document.createElementNS(SVG, 'text')
  t.setAttribute('x', first.left + first.width / 2)
  t.setAttribute('y', first.top - 2)
  t.setAttribute('text-anchor', 'middle')
  t.setAttribute('fill', 'currentColor')
  t.setAttribute('style', `font-style: italic; font-size: ${(fs * 0.42).toFixed(1)}px; opacity: .75`)
  t.textContent = shortGloss(text)
  g.append(t)
  return g
}

/**
 * Foliate draw fn, called again with fresh rects on every expand (font size, viewport), so both
 * decorations follow the text without our own layout code. One overlay carries both: see overlays.mjs.
 */
/**
 * A section's writing mode (vertical underlines run beside the column), read once per section document; undefined when
 * its window is gone (a section unloading mid-draw: never an error out of foliate's overlayer loop).
 */
const writingModes = new WeakMap()
function writingModeOf(el) {
  const doc = el?.ownerDocument
  if (!doc) return undefined
  if (!writingModes.has(doc)) writingModes.set(doc, doc.defaultView?.getComputedStyle(doc.body ?? el).writingMode)
  return writingModes.get(doc)
}

function decorate(rects, { hl, gloss, mark, spoken, el }) {
  const g = document.createElementNS(SVG, 'g')
  if (hl) g.append(Overlayer.highlight(rects, { color: HIGHLIGHT_FILL[colorOf(hl.color)] }))
  // A saved word (#1271) is underlined in its stage's colour; a word the host glossed on a tap, in the label's. foliate's
  // underline, so a vertical book's runs beside its column.
  const writingMode = mark || gloss || spoken ? writingModeOf(el) : undefined
  if (mark || gloss) g.append(Overlayer.underline(rects, { color: mark ? STAGE_COLORS[mark.stage] : GLOSS_COLOR, width: 2, writingMode }))
  // The range spoken (#1272) last, over a saved word's underline: it stays visible.
  if (spoken) g.append(Overlayer.underline(rects, { color: SPOKEN_FILL, width: 3, writingMode }))
  // The tap's translation, else the saved word's own behind the reader's setting (read at draw time).
  const label = gloss || (showGlosses && mark?.gloss)
  if (label) g.append(glossOf(rects, label, el))
  return g
}

/** #1265: a tapped EPUB image full screen, in this document (lightbox.mjs); the book behind it inert. */
const lightbox = createLightbox(document, post, () => view)

function onTap(doc, index, e) {
  if (e.target.closest?.('a[href]')) return   // foliate owns links
  if (!doc.getSelection().isCollapsed) return   // a selection, not a word tap
  if (dismissing) return   // it ended the selection sent (`selection-cleared`), nothing else
  // An image (reflowable EPUB only: not a comic, not a fixed-layout page) opens the lightbox from the middle zone only
  // (tapZone.mjs, the hosts' rule): an edge still turns the page, so a page-filling image does not take every tap.
  // No `tap`, `word` or `highlight-tap` then.
  const img = format === 'epub' && !view.isFixedLayout && imageAt(e.target)
  if (img && tapAction({ x: tapAt(doc, e).x, width: innerWidth, flow, dir: pagedDir() }) === 'toggle') return lightbox.open(img, doc.defaultView.frameElement)
  // A drawn highlight under the tap (#1312): the host's editor for it, not a word or a chrome tap.
  const hit = highlightAt(doc, e.clientX, e.clientY)
  if (hit) return post({ ...tapAt(doc, e), type: 'highlight-tap', id: hit.id, rect: rectInPage(doc.defaultView.frameElement, hit.range.getBoundingClientRect()) })
  const c = doc.caretRangeFromPoint?.(e.clientX, e.clientY)
  const node = c?.startContainer
  if (!node || node.nodeType !== Node.TEXT_NODE) return post(tapAt(doc, e))
  // Same word rule as the reader engine's wordAt (soft hyphens kept inside the word).
  const w = tokenizeVocabWords(node.data.replace(/­/g, 'a')).find((t) => t.start <= c.startOffset && c.startOffset <= t.end)
  if (!w || !/\p{L}/u.test(w.word)) return post(tapAt(doc, e))
  const range = doc.createRange()
  range.setStart(node, w.start)
  range.setEnd(node, w.end)
  // The caret snaps to the nearest text: a tap in a margin is not a tap on the line's last word.
  const r = range.getBoundingClientRect()
  if (e.clientX < r.left - 4 || e.clientX > r.right + 4 || e.clientY < r.top - 4 || e.clientY > r.bottom + 4) return post(tapAt(doc, e))
  post({
    type: 'word', index, word: node.data.slice(w.start, w.end).replace(/­/g, ''),
    // No CFI where nothing can be drawn at one (a PDF's text layer has no CFI that means anything).
    sentence: sentenceOf(node, w.start, w.end), cfi: annotatable ? view.getCFI(index, range) : null,
    // Host-viewport coordinates of the word.
    rect: rectInPage(doc.defaultView.frameElement, r),
  })
}

/** Each section document's index: the fixed-layout renderer's `getContents()` gives none. */
const sectionIndex = new WeakMap()
const shownDocs = () => (view?.renderer?.getContents?.() ?? []).map((c) => c.doc).filter(Boolean)

/** This gesture dismisses the selection sent: decided at its press, so how long the press lasts does not matter. */
let dismissing = false

/** A `tap` with where it landed, in page-viewport px (`rectInPage`: a scaled fixed-layout frame too). */
function tapAt(doc, e) {
  const { x, y } = rectInPage(doc.defaultView.frameElement, { left: e.clientX, top: e.clientY, width: 0, height: 0 })
  return { type: 'tap', x, y }
}

/**
 * A navigation key (chrome.mjs `navKey`: a closed list, never typed into a control) is the host's, forwarded:
 * from a section document, and from this one, where focus falls when foliate replaces the focused section.
 */
function onKey(e) {
  const m = navKey(e)
  if (!m) return
  e.preventDefault()   // the host moves the view, not the frame by itself
  post(m)
}
document.addEventListener('keydown', onKey)

/** A press while a selection is sent ends it, in every shown section, at once; its click is no tap. */
function onPress() {
  dismissing = !!selectionSent
  if (!dismissing) return
  for (const d of shownDocs()) d.getSelection()?.removeAllRanges()
  selectionSent = null
  post({ type: 'selection-cleared' })
}
// The page's own document: the paginator's margins and outer columns, beside a letterboxed fixed-layout page.
// A tap there is a `tap` too (the hosts' edge zones are mostly there). Nothing before a book is on screen.
document.addEventListener('pointerdown', () => { if (view) onPress() })
document.addEventListener('click', (e) => {
  if (!view || dismissing) return
  post({ type: 'tap', x: Math.round(e.clientX), y: Math.round(e.clientY) })
})

function onLoad({ detail: { doc, index } }) {
  // Any book, CBZ too: the reader acting in a section is the reader acting (`readerActed`).
  for (const type of ['pointerdown', 'wheel', 'keydown', 'touchstart']) doc.addEventListener(type, onInput, { capture: true, passive: true })
  doc.addEventListener('pointermove', onMove, { passive: true })
  doc.addEventListener('keydown', onKey)
  // Images only: every tap is a chrome toggle, and nothing is kept for a highlight.
  if (!textual) return doc.addEventListener('click', (e) => post(tapAt(doc, e)))
  sectionIndex.set(doc, index)
  doc.addEventListener('touchmove', () => { scrollInputAt = Date.now() }, { passive: true })
  if (!view.isFixedLayout) applyAlignment(doc, look.textAlign)
  if (!view.isFixedLayout) applyFontFamily(doc, look)
  doc.addEventListener('pointerdown', onPress)
  doc.addEventListener('click', (e) => onTap(doc, index, e))
  doc.addEventListener('selectionchange', () => {
    // One selection at a time: a new one in this section ends the one in another shown section (a spread).
    if (!doc.getSelection().isCollapsed) for (const d of shownDocs()) if (d !== doc) d.getSelection()?.removeAllRanges()
    settleSelection()
  })
}

/** The last `selection` posted (its JSON), null once `selection-cleared` went: a re-fired same selection is not sent again. */
let selectionSent = null
let selectionTimer = 0
/**
 * `selection` once the selection stops changing (a drag fires selectionchange all the way: text.ts
 * settle time) and whenever the view moves it (a `relocate`, a scroll, a resize); `selection-cleared` once the
 * one sent is gone.
 */
function settleSelection() {
  clearTimeout(selectionTimer)
  selectionTimer = setTimeout(sendSelection, SELECTION_SETTLE_MS)
}
addEventListener('resize', settleSelection)

const sameRange = (a, b) => a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset

/** `doc`'s live selection, edge whitespace dropped: `{ doc, index, frame, s, range }`, or null (none, no text, no frame). */
function liveRange(doc) {
  const frame = doc.defaultView?.frameElement
  const s = frame ? doc.getSelection() : null
  const raw = s?.rangeCount && !s.isCollapsed ? s.getRangeAt(0) : null
  const range = raw && trimRange(raw)
  const index = sectionIndex.get(doc)
  return range && index !== undefined ? { doc, index, frame, s, range } : null
}

/**
 * What a live selection is: its range, text, CFI and sentence, the one description both the `selection` message
 * and `highlightSelection` use. Computed once per range: the same range again is `lastSelection`.
 */
function describe({ doc, index, s, range }) {
  if (lastSelection?.doc === doc && sameRange(lastSelection.range, range)) return lastSelection
  return {
    index, doc, range: range.cloneRange(),
    // As rendered: across blocks and a PDF text layer's lines, words stay apart (a range's text glues them).
    text: s.toString(),
    // No CFI where nothing can be drawn at one (a PDF), as `word`, nor where `highlightSelection` refuses it.
    cfi: annotatable && range.toString().length <= MAX_SELECTED_TEXT ? view.getCFI(index, range) : null,
    sentence: sentenceOfRange(range.startContainer, range.startOffset, range.endContainer, range.endOffset),
  }
}

/**
 * `doc`'s selection as a message, or null: none, no text, its frame gone (a section no longer shown), or no part
 * of it inside the page viewport. A move recomputes the box only. The box sent is the part inside the viewport.
 */
function selectionIn(doc) {
  const live = liveRange(doc)
  const rect = live && clipToViewport(rectInPage(live.frame, live.range.getBoundingClientRect()))
  if (!rect) return null
  const sel = describe(live)
  const m = selectionMessage({ index: sel.index, text: sel.text, cfi: sel.cfi, sentence: sel.sentence, rect })
  return m && { m, sel }
}

/** The part of a page-viewport box inside the viewport, or null when none is. */
function clipToViewport({ x, y, w, h }) {
  const [l, t, r, b] = [Math.max(x, 0), Math.max(y, 0), Math.min(x + w, innerWidth), Math.min(y + h, innerHeight)]
  return r > l && b > t ? { x: l, y: t, w: r - l, h: b - t } : null
}

function sendSelection() {
  let found = null
  for (const doc of shownDocs()) if ((found = selectionIn(doc))) break
  if (found) {
    // What `highlightSelection` highlights: exactly the range this message describes.
    lastSelection = found.sel
    const json = JSON.stringify(found.m)
    if (json !== selectionSent) post(found.m)
    selectionSent = json
  } else if (selectionSent) {
    selectionSent = null
    post({ type: 'selection-cleared' })
  }
}

/**
 * foliate does not serialise navigation: overlapping goTo's load a section whose blob: URL the other
 * one already revoked. Every navigation of ours runs after the previous one. foliate's own goTo logs
 * its failures to the console and resolves either way, so only our own throws reach this catch; a
 * caller that needs to know whether a navigation arrived has to look (see restore).
 */
let navigating = Promise.resolve()
/**
 * Bound to the view it was called for: `open` starts a fresh chain, so a goTo that never settles on the
 * previous view (its section's blob: URL revoked by close) cannot hold up the next book, and a call still
 * queued behind it never runs on the new view.
 */
const navigate = (fn) => {
  const mine = viewSeq
  return (navigating = navigating.then(() => (mine === viewSeq ? fn() : undefined)).catch((e) => log('error', `navigation: ${e?.stack ?? e}`)))
}

/**
 * The end of the book is on screen (#1266): the end of its last linear section, or for a fixed layout that
 * section's spread. Not the renderer's own `atEnd`, which applies the paged rule in scrolled flow too. A host
 * cannot tell this from `fraction` (scrolled flow reports the top of the viewport, a spread its current side).
 */
function atBookEnd(index) {
  try {
    const r = view.renderer
    const last = view.book.sections.map((s) => s.linear !== 'no').lastIndexOf(true)
    if (last < 0) return false
    if (view.isFixedLayout) return arrivedAt(last)
    if (index !== last) return false
    return r.scrolled ? r.end >= r.viewSize - 1 : r.page >= r.pages - 2
  } catch { return false }
}

/** The end of the shown section is on screen (the test `atBookEnd` makes for the last one). */
const sectionEndShown = () => {
  const r = view.renderer
  return r.scrolled ? r.end >= r.viewSize - 1 : r.page >= r.pages - 2
}

/**
 * Text the reader can see: not white space, and drawn (a `display: none` page number has no box). The text nodes
 * are text.ts's (`textNodes`: no script, style or noscript content).
 */
const ink = (n) => /\S/.test(n.data) && (n.parentElement?.getClientRects().length ?? 0) > 0
const atOrAfter = (el, n) => !!(el.compareDocumentPosition(n) & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY))
/** The last text to read in `doc` before element `to` (null: before its end) and not before element `from` (null: its start), or null. */
function lastInk(doc, from, to) {
  const nodes = textNodes(doc.body)
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (to && atOrAfter(to, n)) continue
    if (from && !atOrAfter(from, n)) return null
    if (ink(n)) return n
  }
  return null
}
/**
 * The last character of text node `n` is on screen: where it is drawn, in the page's viewport (`rectInPage`, as a
 * selection's box). By geometry, not foliate's visible range: that range runs on past the screen in a file with
 * text that is not drawn.
 */
function endOnScreen(n) {
  if (!n) return false
  const at = n.data.search(/\S\s*$/)
  const r = n.ownerDocument.createRange()
  r.setStart(n, at)
  r.setEnd(n, at + 1)
  const rects = r.getClientRects()
  const frame = n.ownerDocument.defaultView?.frameElement
  if (!rects.length || !frame) return false
  const { x, y, w, h } = rectInPage(frame, rects[rects.length - 1])
  const [cx, cy] = [x + w / 2, y + h / 2]
  return cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight
}

/**
 * #1316, "Discuss this chapter" (chapters.mjs): where the open book's contents lead, kept on the view it is of
 * (`view.tsChapters`), so no other book ever reads it. Found out after the book is on screen, one entry at a time
 * (a KF8 entry reads the file): an open never waits for it. `places` is null until then; `ready` resolves when it
 * is there. Not for a fixed layout (a CBZ, a PDF, a pre-paginated EPUB): its sections are pages, with no text the
 * page can read on its own: no chapter end and no chapter text.
 */
let testHoldChapters = 0
function startChapters(v) {
  if (v.tsChapters || v.isFixedLayout || !v.book) return
  const toc = flat(v.book.toc ?? [])
  const c = v.tsChapters = { places: null, labels: toc.map((t) => t.label || null), files: new Map(), ready: null }
  c.ready = (async () => {
    if (testHoldChapters) await new Promise((done) => setTimeout(done, testHoldChapters))
    const places = []
    for (const t of toc) {
      // Its view left the screen: the rest is nobody's.
      if (v !== view) return
      try { places.push(placeOf(await v.book.resolveHref(t.href), t.href, v.book.sections.length)) } catch { places.push(null) }
    }
    c.places = places
  })().catch((e) => log('error', `chapters: ${e?.stack ?? e}`))
  // The place on screen was reported before this was known: its chapter end is said now, if it has one.
  void c.ready.then(() => refineChapterEnd(v))
}

/**
 * Section `sec`'s `fileSummary` (chapters.mjs): its starts in document order and whether the first is at its top.
 * Read from that file once per view (`files`); `{ wait }` until it is known. A file that cannot be read has no start.
 */
function summaryOf(v, sec) {
  const { files, places } = v.tsChapters
  const known = files.get(sec)
  if (known && !(known instanceof Promise)) return { value: known }
  const wait = known ?? (async () => {
    let summary = { owners: [], top: false }
    try { summary = fileSummary(places, sec, await v.book.sections[sec].createDocument()) } catch (e) { log('warn', `chapters of section ${sec}: ${e?.message ?? e}`) }
    files.set(sec, summary)
  })()
  files.set(sec, wait)
  return { wait }
}
const linear = (v, i) => v.book.sections[i]?.linear !== 'no'

/**
 * The chapter running into section `index` from before it: the last start of the nearest earlier linear file that
 * has one (`{ value }`: its entry, or null: no chapter before), `{ wait }` while a file is being read.
 */
function carryInto(v, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (!linear(v, i)) continue
    const s = summaryOf(v, i)
    if (s.wait) return s
    if (s.value.owners.length) return { value: s.value.owners.at(-1) }
  }
  return { value: null }
}

/**
 * Whether the chapter running to the end of section `index` ends there: the next linear file's first start is at
 * its top, or there is no later linear file (the book's end). `{ wait }` while that file is being read.
 */
function endsWithFile(v, index) {
  for (let i = index + 1; i < v.book.sections.length; i++) {
    if (!linear(v, i)) continue
    const s = summaryOf(v, i)
    if (s.wait) return s
    return { value: s.value.top }
  }
  return { value: true }
}

/**
 * #1316: the chapter whose end is on screen, as `{ value }` (`{ tocIndex, section, title }` or null), with `wait`
 * when something it needs is still being read (the answer then is null for now: `refineChapterEnd`). The chapters
 * of the file on screen are chapters.mjs's, by the document's order (`startsIn`, `segmentsIn`: one rule with
 * `chapterText`, never foliate's current entry); a book with no contents (no entry of them leads anywhere: the one
 * rule, here) has its spine sections for chapters (`tocIndex` null). The chapter that ended is the last one of the
 * file whose last drawn line is on screen and that ends there (the next start follows in this file, or the next
 * file starts with one, or the book ends). Not a chapter with nothing to read in this file. Never guessed by a host
 * from `fraction` or `tocIndex`.
 */
function chapterEndNow(v, d) {
  try {
    const index = d.section?.current
    const c = v.tsChapters
    if (!c || !Number.isInteger(index)) return { value: null }
    if (!c.places) return { value: null, wait: c.ready }
    const { places, labels } = c
    const here = (tocIndex) => ({ value: { tocIndex, section: index, title: tocIndex === null ? null : labels[tocIndex] } })
    const doc = v.renderer.getContents?.().find((x) => x.index === index)?.doc
    if (!doc?.body) return { value: null }
    if (!hasContents(places)) return sectionEndShown() && lastInk(doc, null, null) ? here(null) : { value: null }
    const groups = startsIn(places, index, doc)
    let carry = null
    if (!groups.length || groups[0].el) {
      const r = carryInto(v, index)
      if (r.wait) return { value: null, wait: r.wait }
      carry = r.value
    }
    const segments = segmentsIn(groups, carry)
    let lastEnds = null
    for (let k = segments.length - 1; k >= 0; k--) {
      const s = segments[k]
      if (s.owner == null) continue
      if (s.last) {
        if (lastEnds === null) {
          const r = endsWithFile(v, index)
          if (r.wait) return { value: null, wait: r.wait }
          lastEnds = r.value
        }
        if (!lastEnds) continue
      }
      const n = lastInk(doc, s.from, s.to)
      if (n && endOnScreen(n)) return here(s.owner)
    }
    return { value: null }
  } catch { return { value: null } }
}

/**
 * The place last reported for the view on screen. Its chapter end, where it needed something not read yet (where
 * the contents lead, the next entry's file), is said once that is known, as `chapter-end`: for that place only,
 * never after a newer relocate.
 */
let lastRelocate = null
function chapterEndFor(d) {
  const v = view
  const r = chapterEndNow(v, d)
  lastRelocate = { view: v, detail: d }
  // (Where the contents lead is still being found out: `startChapters` comes back to this place itself.)
  if (r.wait && r.wait !== v.tsChapters?.ready) void r.wait.then(() => refineChapterEnd(v))
  return r.value
}
function refineChapterEnd(v, tries = 0) {
  const last = lastRelocate
  if (v !== view || last?.view !== v || tries > 3) return
  const r = chapterEndNow(v, last.detail)
  if (r.wait) return void r.wait.then(() => { if (lastRelocate === last) refineChapterEnd(v, tries + 1) })
  if (r.value) post({ type: 'chapter-end', chapterEnd: r.value })
}

/**
 * #1316: the text of one chapter for the host to share (`chapter-text`, answered once per request unless another
 * book opened meanwhile): contents entry `tocIndex` from its start to the next start in reading order (chapters.mjs
 * `startsIn`, the rule the chapter end follows), or, in a book with no contents, spine section `section`. Read from
 * the book's own section documents, not the screen: text only, in paragraphs, within the server's cap (`cut` when
 * the chapter is longer: chapters.mjs `fitText`). `unavailable` for an entry with no start (its anchor is not in a
 * file an earlier entry leads into): the page never names such an entry as a chapter that ended.
 */
async function chapterText(request, tocIndex, section) {
  // The host's own id, echoed as it came: anything else gets no answer.
  if (typeof request !== 'string' || !request || request.length > 64) return
  const v = view
  const answer = (a) => { if (v === view) post({ type: 'chapter-text', request, ...a }) }
  try {
    const sections = v?.book?.sections
    const c = v?.tsChapters
    if (!sections || !c) return answer({ error: 'unavailable' })
    await c.ready
    const places = c.places
    if (v !== view || !places) return answer({ error: 'unavailable' })
    const paragraphs = []
    let length = 0
    const take = (doc, from, to) => {
      for (const p of textBetween(doc, from, to)) {
        paragraphs.push(p)
        length += p.length
      }
    }
    let i
    if (Number.isInteger(tocIndex) && places[tocIndex]) {
      i = places[tocIndex].sec
      const doc = await sections[i].createDocument()
      if (v !== view) return
      const groups = startsIn(places, i, doc)
      const k = groups.findIndex((g) => g.members.includes(tocIndex))
      if (k < 0) return answer({ error: 'unavailable' })
      take(doc, groups[k].el, groups[k + 1]?.el ?? null)
      if (groups[k + 1]) return answer(fitted(paragraphs))
    } else if (Number.isInteger(tocIndex) || hasContents(places) || !Number.isInteger(section) || !sections[section]) {
      return answer({ error: 'unavailable' })
    } else {
      // A book with no contents: the section is the chapter.
      const doc = await sections[section].createDocument()
      if (v !== view) return
      take(doc, null, null)
      return answer(fitted(paragraphs))
    }
    // On over the files with no start of their own, into the next start's file up to it.
    for (i++; i < sections.length && length <= MAX_CHAPTER_TEXT_BYTES; i++) {
      if (sections[i].linear === 'no') continue
      const doc = await sections[i].createDocument()
      if (v !== view) return
      const groups = startsIn(places, i, doc)
      if (!groups.length) { take(doc, null, null); continue }
      if (groups[0].el) take(doc, null, groups[0].el)
      break
    }
    answer(fitted(paragraphs))
  } catch (e) {
    log('error', `chapterText: ${e?.stack ?? e}`)
    answer({ error: 'unavailable' })
  }
}
const fitted = (paragraphs) => {
  const f = fitText(paragraphs)
  return f.text ? f : { error: 'empty' }
}

const wordCounts = new WeakMap()
/**
 * For a host's "time left" (#1262), which a book fraction alone cannot give: `sectionEnd`, the book fraction where
 * the shown section ends, and `words`, the book's length in words, estimated from the shown section (its words
 * over its share of the book), so it shifts a little from section to section. Either is null when unknown; `words`
 * always for a book with no text layer of its own (CBZ, PDF).
 */
function lengthAt(index) {
  try {
    const f = view.getSectionFractions()
    // getSectionFractions adds an epsilon: the last one is a hair over 1.
    const sectionEnd = f[index + 1] >= 0 ? Math.min(1, f[index + 1]) : null
    const share = f[index + 1] - f[index]
    const doc = !view.isFixedLayout && textual && view.renderer.getContents?.().find((c) => c.index === index)?.doc
    if (!doc?.body || !(share > 0)) return { sectionEnd, words: null }
    if (!wordCounts.has(doc)) wordCounts.set(doc, tokenizeVocabWords(doc.body.textContent ?? '').length)
    return { sectionEnd, words: Math.round(wordCounts.get(doc) / share) || null }
  } catch { return { sectionEnd: null, words: null } }
}

/**
 * foliate's goTo resolves with the target it resolved, arrived or not (a locked paginator, a section that
 * failed to load): the renderer is asked whether that section is on screen. A fixed-layout renderer's
 * contents carry no index, and a target in the spread already shown emits no relocate, so it is asked
 * whether the target's spread is the one shown.
 */
function arrivedAt(index) {
  const r = view.renderer
  if (!view.isFixedLayout) return !!r?.getContents?.().some((c) => c.index === index)
  // A section that is not in the book has no spread: getSpreadOf(undefined) would match a spread's empty side.
  const spreadOf = (i) => (view.book.sections[i] ? r?.getSpreadOf?.(view.book.sections[i])?.index : undefined)
  return spreadOf(index) != null && spreadOf(index) === spreadOf(r.index)
}

/**
 * A book whose positions name a page (`page`, the `page-name` locator), not text at a CFI: an image book
 * (CBZ), and a pre-paginated EPUB (#1196: foliate's fixed-layout renderer reports no range, so there is no
 * text position to build). A PDF has its own page numbers (`pdf-page`).
 */
const pageForm = () => !textual || (format === 'epub' && view.isFixedLayout)
/**
 * The section's stable key, foliate's section id: a CBZ image's entry name (`comicName`), an EPUB spine
 * item's manifest href resolved against the OPF (epub.js). Both come from the file's bytes alone, so two
 * devices with the same file agree on it, whatever order they list the sections in.
 */
const pageKey = (i) => String(view.book.sections[i]?.id ?? '')
/**
 * The section named `key`, -1 if none: restore and a host goTo find a page by name, never by its index alone.
 * The position's own index is taken when that section has the name (a spine may list one href twice), else the first.
 */
function sectionNamed(key, hint) {
  const { sections } = view.book
  return Number.isInteger(hint) && sections[hint] && String(sections[hint].id) === key ? hint : sections.findIndex((s) => String(s.id) === key)
}
/** A named-page position by its shape (a page key, no quote): found by `page`, whatever kind of book it is in. */
const isNamedPage = (p) => typeof p?.page === 'string' && p.quote === undefined

/**
 * Goes to a goTo target or a stored position. A fraction-only one
 * (#1187) by its fraction, 0 being the text start (not a cover before it); a PDF page by its section
 * (page − 1); a named page (CBZ, pre-paginated EPUB) by its name, never by the CFI its index rebuilds (two
 * devices may order a CBZ's entries differently); any other position by its CFI. Answers the section it
 * arrived at, -1 if it did not.
 */
async function land(target) {
  if (isPosition(target) && isNamedPage(target)) {
    const index = sectionNamed(target.page, target.index)
    if (index < 0) return -1
    await view.goTo(index)
    return arrivedAt(index) ? index : -1
  }
  const resolved = await (isFractionOnly(target)
    ? (target.fraction === 0 ? view.goToTextStart() : view.goTo({ fraction: target.fraction }))
    : view.goTo(isPdfPage(target) ? target.page - 1 : isPosition(target) ? target.cfi : target))
  return resolved && arrivedAt(resolved.index) ? resolved.index : -1
}

/**
 * The place a relocate (or `view.lastLocation`) shows, as the entry's position: the one builder for
 * every save. The visible range's start: its CFI and the text there, to verify the CFI on restore. A
 * page-form book's page (`pageForm`: CBZ, pre-paginated EPUB) is saved by its key (`page`, no quote),
 * which is what restore checks. Null where there is nothing to build from (a text location without a range).
 */
function positionOf(d) {
  // A PDF page (#1128 S5): `pdf-page`, the section index + 1. Never a CFI.
  if (d && format === 'pdf') return Number.isInteger(d.section?.current) ? { page: d.section.current + 1, index: d.section.current, fraction: d.fraction, at: Date.now() } : null
  if (!d) return null
  const at = { cfi: d.cfi, index: d.section?.current, fraction: d.fraction, at: Date.now() }
  if (pageForm()) {
    const page = pageKey(at.index)
    return page ? { ...at, page } : null
  }
  return d.range ? { ...at, quote: quoteOf(d.range.toString().replace(/^\s+/, '')) } : null
}

/**
 * The scheme fits the file (the server's `SyncValidation.FitsFile`, one rule more): a PDF takes a page
 * number and nothing else (no CFI, no fraction), every other book anything but a page number.
 */
const fits = (p) => (format === 'pdf') === isPdfPage(p)

// Pre-order, as foliate numbers its TOC items (progress.js assignIDs): `relocate.tocIndex` indexes this list.
const flat = (items, depth = 0) => items.flatMap((t) => [{ label: t.label?.trim(), href: t.href, depth }, ...flat(t.subitems ?? [], depth + 1)])

/** Saves the entry through the host. Addressed to the book it is called for, not the one open later. */
function persist(delay = 0) {
  saves.save(book.sha256, JSON.stringify(entry), delay)
}

/** Adds or updates what is drawn over `patch.value`, keeping any other decoration already there. */
function annotate(patch) {
  const a = mergeOverlay(overlays.get(patch.value), patch)
  overlays.set(a.value, a)
  return view.addAnnotation(a)
}

/** The element a range starts in: whose font size a label is drawn at. */
const elementOf = (range) => (range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer)

/**
 * #1271: the saved words in section `index` (its document `doc`), as `vocab` says now: a mark drawn for each occurrence
 * (by its CFI, so one over a highlight's range is that overlay), one no longer saved removed, an unchanged one left as
 * drawn; `glosses`: the setting changed, so every mark with a gloss is drawn again. Sections are marked as they load
 * (`create-overlay`), never the whole book.
 */
// ponytail: no cap on a section's occurrences (one overlay each: the commonest 50 words make 3,920 in one chapter, 391 ms
// on desktop); draw only the ones near the viewport if real vocabularies make it felt.
function markSection({ index, doc, overlayer } = {}, glosses = false) {
  if (!annotatable || !doc?.body || !overlayer) return
  const want = new Map()
  for (const { range, word } of wordMarksIn(doc.body, vocab)) want.set(view.getCFI(index, range), { range, mark: { stage: word.stage, gloss: word.gloss } })
  for (const [cfi, a] of overlays) if (a.index === index && a.mark && !want.has(cfi)) undecorate(cfi, { mark: undefined })
  for (const [cfi, { range, mark }] of want) {
    const prev = overlays.get(cfi)
    if (sameMark(prev?.mark, mark) && !(glosses && mark.gloss)) continue
    const a = mergeOverlay(prev, { value: cfi, index, mark })
    overlays.set(cfi, a)
    // Straight to the section's overlayer with the range in hand, under the overlay's key (what foliate's
    // `addAnnotation` would do after resolving the CFI again: measured, that doubled a dense section's time).
    if (a.hl) drawnRanges.set(cfi, range)
    overlayer.add(cfi, range, decorate, { hl: a.hl, gloss: a.gloss, mark, spoken: a.spoken, el: elementOf(range) })
  }
}

/**
 * One decoration over `cfi` goes (`patch` unsets it); the others over the same range stay (one overlay, overlays.mjs): a
 * removed highlight keeps the word's mark, translation and spoken mark; a word no longer saved keeps its highlight.
 */
function undecorate(cfi, patch) {
  if (!overlays.has(cfi)) return
  const a = { ...overlays.get(cfi), ...patch }
  if (!a.hl) drawnRanges.delete(cfi)
  if (a.hl || a.gloss || a.mark || a.spoken) return annotate(a)
  overlays.delete(cfi)
  return view.deleteAnnotation({ value: cfi })
}
/** The highlight drawn over `cfi` goes; a translation label or the spoken mark over the same range stays. */
const unhighlight = (cfi) => undecorate(cfi, { hl: undefined })

/**
 * #1272: the host speaks the range at `cfi` (a `word`'s or `selection`'s, in section `index`): it is underlined, the
 * previous one goes (one at a time). `null`: the speech ended or stopped, the mark goes. Not where `annotatable` is
 * false, nor for a value that is no range CFI (a `warn`). True when drawn.
 */
function speaking(cfi, index) {
  if (spokenCfi) undecorate(spokenCfi, { spoken: undefined })
  spokenCfi = null
  if (cfi === null || cfi === undefined) return false
  if (!view || !annotatable || typeof cfi !== 'string' || !cfi.startsWith('epubcfi(') || cfi.length > MAX_SELECTION_CFI
    || !Number.isInteger(index) || index < 0) {
    log('warn', 'speaking ignored: no range to mark here')
    return false
  }
  spokenCfi = cfi
  annotate({ value: cfi, index, spoken: true })
  return true
}

/**
 * Ranges of sections no longer loaded go (their frame removed: no window). Run when a section's overlayer is made
 * and on every tap, so the map holds the loaded sections' highlights only (#1312 review: it grew with every section
 * visited, and every tap scanned it).
 */
function pruneDrawn() {
  for (const [cfi, range] of drawnRanges) if (!range.startContainer.ownerDocument?.defaultView) drawnRanges.delete(cfi)
}

/** The drawn highlight under a point of `doc` (its own coordinates), or null. */
function highlightAt(doc, x, y) {
  pruneDrawn()
  for (const [cfi, range] of drawnRanges) {
    const hl = overlays.get(cfi)?.hl
    if (!hl || range.startContainer.ownerDocument !== doc) continue
    for (const r of range.getClientRects()) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { id: hl.id, range }
  }
  return null
}

/**
 * #1315: in-book search, foliate's own (`view.search`: every section's own document, never the network; each hit drawn
 * in its section as that section loads). One search at a time: a call ends the one running (it stops at its next
 * section) and starts after it; `searchSeq` names the latest call, the swap turns it over and starts a fresh chain (a
 * search of a closed book that never settles holds up nothing).
 */
let searchSeq = 0
let searching = Promise.resolve()
/**
 * The host's `search(query, id)`: `search-results` messages carrying `id`, one per section with hits, then one with
 * `done`. `more`: a hit past MAX_RESULTS exists (never said for exactly that many): foliate is asked for one hit more
 * than is listed, and stops matching there. `incomplete`: part of the book could not be read (foliate skips a section
 * whose document fails or has no body, an SVG spine item, and says so). A task between sections, so input and paint
 * come first in a long book. No query (`readQuery`: null, too short, too long): the hits drawn go, nothing is answered.
 */
function search(raw, id) {
  const run = ++searchSeq
  const query = readQuery(raw)
  // A newer call, or the swap (it turns `searchSeq` over too).
  const stale = () => run !== searchSeq
  searching = searching.then(async () => {
    // First: a call superseded while it waited touches nothing (the view may be another book's by now).
    if (stale()) return
    const v = view
    v?.clearSearch()
    if (!v || !query || !Number.isSafeInteger(id)) return
    // The book's own language decides what folds (case, accents) where a section names none: never the reader's
    // browser (foliate's default is an object Intl reads as "the runtime's locale": under Turkish, "in" misses "In").
    // A book with no language, or one that is no language tag, has none: foliate then searches as English.
    const defaultLocale = v.language?.canonical
    let found = 0
    let skipped = 0
    const answer = (results, end) => post({ type: 'search-results', key: book.sha256, id, results, done: !!end, more: end === 'more', incomplete: !!end && skipped > 0 })
    try {
      for await (const r of v.search({ query, defaultLocale, limit: MAX_RESULTS + 1, draw: Overlayer.highlight, drawOptions: { color: SEARCH_FILL } })) {
        if (stale()) return
        if (r?.error) {
          skipped++
          log('warn', `search: section ${r.index} could not be read, skipped`)
        }
        if (r?.subitems) {
          const items = searchItems(r.subitems)
          const room = MAX_RESULTS - found
          if (room) answer(items.slice(0, room))
          found += Math.min(items.length, room)
          // The hit past the cap is in hand (foliate stopped at it): there are more.
          if (items.length > room) return answer([], 'more')
        }
        await new Promise((next) => setTimeout(next))
        // Before foliate is asked for the next section: a search ended meanwhile reads and draws nothing more
        // (leaving the loop closes foliate's generator).
        if (stale()) return
      }
    } catch (e) {
      skipped++
      log('warn', `search stopped: ${e?.message ?? e}`)
    }
    if (!stale()) answer([], 'done')
  }).catch((e) => log('error', `search: ${e?.stack ?? e}`))
}

/** The ids of the highlights drawn now. */
const drawnIds = () => new Set([...overlays.values()].flatMap((a) => (a.hl ? [a.hl.id] : [])))
const savedQuote = (h) => h?.color === 'quote'
const listedIds = () => new Set([...drawnIds(), ...entry.highlights.filter((h) => savedQuote(h) && placedQuotes.has(h.id)).map((h) => h.id)])

/**
 * The open book's drawn highlights, in book order (#1312, highlights.mjs `highlightList`): sent whenever they change
 * (restored, added, highlighted, recoloured, removed), so a host's list is the page's and needs no diff of its own.
 */
function postList() {
  if (!entry) return
  post({ type: 'highlight-list', key: book.sha256, highlights: highlightList(entry.highlights, listedIds(), compareCfi, quotes) })
}

/** The entry's bookmark list, built again (the set of found bookmarks may have changed); a new version only if it did. */
function relist() {
  const next = entry ? bookmarkList(entry.highlights, placed, compareCfi) : []
  if (JSON.stringify(next) === JSON.stringify(listed)) return
  listed = next
  listedVersion++
}

/** Bookmark `h`'s range in the section document `loc` shows (a relocate's detail), or null: another section's, a CFI it does not resolve. */
function rangeOn(h, loc) {
  try {
    const { index, anchor } = view.resolveCFI(h.cfi)
    return index === loc.section?.current ? anchor(loc.range.startContainer.ownerDocument) : null
  } catch { return null }
}

/**
 * #1314: the bookmark the place being read has, or null. `place`: the first words on screen (`bookmarkRange`).
 * - The one it had is kept while the reader has not moved (`cause` is not a turn or a navigation: a re-layout by a font
 *   or flow change, a bookmark added, a jump to one) and it is still on screen: a re-layout may put it mid-screen.
 * - Otherwise the bookmark at the top of the screen (bookmarks.mjs `atTop`, by the live layout): never one further down.
 * ponytail: resolves every found bookmark's CFI per relocate; index them by section if a book ever holds thousands.
 */
function hereOf(loc, cause, place) {
  const top = place && { scrolled: !!view.renderer.scrolled, vertical: /^vertical/.test(writingModeOf(elementOf(place)) ?? '') }
  const atTheTop = (r) => !!r && !!place && atTop(place, r, top)
  if (hereId && cause !== 'turn' && cause !== 'nav') {
    const kept = entry.highlights.find((h) => h.id === hereId && placed.has(h.id))
    const r = kept && rangeOn(kept, loc)
    // (One just above the screen in scrolled flow is found by the top rule below.)
    if (r && startsWithin(loc.range, r)) return hereId
  }
  return entry.highlights.find((h) => placed.has(h.id) && atTheTop(rangeOn(h, loc)))?.id ?? null
}

/** Whether a bookmark can be made at `place` now: not where the book takes none, not while bookmarks are still being placed. */
const canBookmark = (place) => annotatable && !awaitingMore && placing.size === 0 && !!place

/**
 * #1314: the open book's bookmarks in book order (`listed`), the one the place being read has (`here`) and whether one
 * can be made here (`can`): sent whenever any of it changes (restored, added, removed, a relocate), never the same
 * message twice. `cause`: a relocate's (`turn` / `nav` / `layout`), none for a change of the bookmarks themselves.
 * Never throws: a failure here must not stop what called it (a relocate saves the position first).
 */
function postBookmarks(loc = view?.lastLocation, cause) {
  if (!entry) return
  try {
    if (testBreakBookmarks) throw new Error('test: the bookmark pass broke')
    const place = loc?.range ? bookmarkRange(loc.range) : null
    hereId = hereOf(loc, cause, place)
    const can = canBookmark(place)
    // Bookmarks still being placed (#1314 review): a host shows them loading, not "this page cannot be bookmarked".
    const loading = awaitingMore || placing.size > 0
    const sent = `${viewSeq}:${listedVersion}:${hereId}:${can}:${loading}`
    if (sent === bookmarksSent) return
    bookmarksSent = sent
    post({ type: 'bookmark-list', key: book.sha256, bookmarks: listed, here: hereId, can, placing: loading })
  } catch (e) {
    log('error', `bookmarks: ${e?.stack ?? e}`)
  }
}

/** A restore or an `addHighlights` begins placing bookmarks: none can be made until its token leaves `placing`. */
function placingStarts() {
  const token = {}
  placing.add(token)
  postBookmarks()
  return token
}

/**
 * #1314: a bookmark at the place on screen: the first words there (≤ `BOOKMARK_TEXT`, `bookmarkText`) and their CFI,
 * kept in the entry as a highlight of colour `BOOKMARK_COLOR` (saved and synced as one, never drawn). It is the one
 * here at once (it starts where the screen does). Refused with a `warn`: before `restored`; while bookmarks are still being placed; where there is no
 * text to keep (an image page, a fixed-layout book, a PDF); where the place being read has a bookmark (`hereOf`: no
 * duplicate, no twin of one the host holds). A bookmark further down the screen does not refuse it.
 */
function addBookmark() {
  if (!entry) return log('warn', 'addBookmark ignored: the stored entry is not restored yet')
  if (placing.size || awaitingMore) return log('warn', 'addBookmark ignored: bookmarks are still being placed')
  const loc = view.lastLocation
  const range = annotatable && loc?.range ? bookmarkRange(loc.range) : null
  if (!range) return log('warn', 'addBookmark ignored: no text to bookmark here')
  // The place being read has one (`hereOf`: one that starts here, the one at the top, the one just jumped to).
  if (hereOf(loc, undefined, range)) return log('warn', 'addBookmark ignored: this place is bookmarked')
  const index = loc.section.current
  // As a label reads (a space between blocks and lines); restore compares it with the same text at the CFI.
  const selectedText = bookmarkText(range)
  const h = { id: uuidV4(), cfi: view.getCFI(index, range), index, quote: quoteOf(selectedText), selectedText, prefix: '', suffix: '', color: BOOKMARK_COLOR, at: Date.now() }
  entry = withHighlight(entry, h)
  placed.add(h.id)
  relist()
  persist()
  postBookmarks()
  return h
}

/**
 * #1314: bookmark `id` leaves the entry (wherever it is in the book); `highlight-removed` tells the host to tombstone
 * it, as for a highlight (the hosts hold both as one kind of row).
 */
function removeBookmark(id) {
  if (!entry?.highlights.some((x) => x.id === id && isBookmark(x))) return log('warn', 'removeBookmark ignored: not a bookmark here')
  entry = { ...entry, highlights: entry.highlights.filter((x) => x.id !== id) }
  placed.delete(id)
  relist()
  persist()
  post({ type: 'highlight-removed', key: book.sha256, id })
  postBookmarks()
}

/** The entry's highlight `id` as drawn now (its overlay is this one's), or null with a `warn` naming the call. */
function drawnHighlight(id, call) {
  if (!entry || !annotatable) return void log('warn', `${call} ignored: no highlights here`)
  const h = entry.highlights.find((x) => x.id === id)
  const a = h && overlays.get(h.cfi)
  if (savedQuote(h) && placedQuotes.has(h.id)) return { h, a: { index: h.index } }
  if (a?.hl?.id !== id) return void log('warn', `${call} ignored: not a highlight drawn here`)
  return { h, a }
}

/** #1312: a drawn highlight's colour (one of `HIGHLIGHT_COLORS`), redrawn and saved (`store`). */
function recolorHighlight(id, color) {
  if (!isHighlightColor(color)) return log('warn', 'recolorHighlight ignored: not a colour')
  const d = drawnHighlight(id, 'recolorHighlight')
  if (!d || d.h.color === color) return
  entry = withHighlight(entry, { ...d.h, color })
  persist()
  annotate({ value: d.h.cfi, index: d.a.index, hl: { id, color } })
  postList()
}

/**
 * #1312: a drawn highlight removed from the entry and the screen; `highlight-removed` tells the host to tombstone it
 * (the entry's absence alone tombstones nothing: entryChanges never reads a missing highlight as a delete).
 */
function removeHighlight(id) {
  // #1195: a quotation leaves the list only (tombstoned elsewhere); nothing is sent, so its row is never written.
  if (quotes.some((q) => q.id === id)) {
    quotes = quotes.filter((q) => q.id !== id)
    return postList()
  }
  const d = drawnHighlight(id, 'removeHighlight')
  if (!d) return
  entry = { ...entry, highlights: entry.highlights.filter((x) => x.id !== id) }
  placedQuotes.delete(id)
  persist()
  unhighlight(d.h.cfi)
  post({ type: 'highlight-removed', key: book.sha256, id })
  postList()
}

/**
 * A format reader the page carries as text (build.mjs FORMATS), run on first use under the page's own
 * nonce: the CSP admits a nonce'd inline script whoever inserts it and nothing else, so no directive
 * is widened for it (README, Formats). The reader registers itself on window.__tsFormats.
 */
const NONCE = document.currentScript?.nonce
const formats = (window.__tsFormats = {})
function formatModule(name) {
  if (!formats[name]) {
    const s = document.createElement('script')
    s.nonce = NONCE
    s.textContent = self.__TS_FORMATS?.[name] ?? ''
    document.head.append(s)
    s.remove()
  }
  if (!formats[name]) throw new Error(`the ${name} reader did not load`)
  return formats[name]
}

/**
 * view.js's makeBook, routed by content (formats.mjs), not by file name. EPUB keeps our own SHA-1:
 * foliate's default is crypto.subtle, missing at origin "null", so IDPF-obfuscated fonts would not
 * decode there. MOBI/AZW3, FB2 and CBZ go to the fork's own readers. An adapter, not a patch.
 */
async function makeBookFor(bytes, name, kind) {
  // `kind` is sniffFormat's, taken before the open book was touched (openFor).
  if (kind === 'pdf') {
    // pdf.js runs on the page's main thread (build.mjs FORMATS.pdf): no Worker, no wasm (the CSP has no
    // 'wasm-unsafe-eval'), nothing fetched: cMaps come from the page's own chunk (PdfCMaps), standard-font
    // data not at all (system fonts).
    // pdf.js's main-thread "worker" clones every message with structuredClone, which pdfPolyfills.mjs cannot
    // stand in for: refused here, before the swap, instead of an open that never answers.
    if (typeof structuredClone !== 'function') throw new Error('this WebView is too old to read PDF')
    const { makePDF, css } = formatModule('pdf')
    // A load that fails destroys its own loading task (the fork's makePDF, #1203).
    const book = await makePDF(new File([bytes], name), { css, params: { useWasm: false, CMapReaderFactory: PdfCMaps } }).catch((e) => {
      throw e?.name === 'PasswordException' ? new Error('this PDF is password-protected and cannot be opened') : e
    })
    // One page per screen, never foliate's two-page spreads: within a spread a page step or goTo shows the
    // other page without a relocate, so the saved page would be the spread's first.
    book.rendition.spread = 'none'
    // An outline entry pdf.js cannot resolve (an integer page, a dangling reference) rejects; foliate awaits
    // every entry while opening, after the swap. Such an entry goes nowhere instead of failing the open.
    for (const k of ['splitTOCHref', 'resolveHref']) {
      const f = book[k]
      book[k] = (href) => f(href).catch(() => null)
    }
    return { format: 'pdf', book }
  }
  // An HTML clip: one section, sanitized (clip.mjs).
  if (kind === 'html') return { format: 'html', book: clipBook(bytes) }
  if (kind === 'mobi') {
    const { MOBI, unzlibSync } = formatModule('mobi')
    // MOBI6 or KF8 (AZW3, or a MOBI/KF8 combo's KF8 half), foliate's choice; formats.mjs checked its header.
    return { format: 'mobi', book: await new MOBI({ unzlib: unzlibSync }).open(new File([bytes], name)) }
  }
  const fb2Of = (b) => formatModule('fb2').makeFB2(new Blob([fb2AsUtf8(b)]))
  if (kind === 'fb2') return { format: 'fb2', book: await fb2Of(bytes) }
  configure({ useWebWorkers: false })
  const entries = await new ZipReader(new BlobReader(new Blob([bytes]))).getEntries()
  const map = new Map(entries.map((e) => [e.filename, e]))
  const loader = {
    entries,
    loadText: (n) => map.get(n)?.getData(new TextWriter()) ?? null,
    loadBlob: (n, type) => map.get(n)?.getData(new BlobWriter(type)) ?? null,
    getSize: (n) => map.get(n)?.uncompressedSize ?? 0,
  }
  const zipped = zipFormat([...map.keys()])
  if (zipped === 'epub') return { format: 'epub', book: await new EPUB({ ...loader, sha1: async (str) => sha1(str) }).init() }
  if (zipped === 'cbz') {
    // foliate keeps lower-case extensions only (`001.JPG` would be no page): each entry is also known by
    // comicName, and the comic reader sees only that. The reader titles a book by its file name; the
    // host's is a path, and the host falls back to its own.
    // Each name once (a zip may repeat one: two pages with one id would restore to the first), and each
    // page blob typed by its extension: the reader asks for none, and an untyped SVG is no image.
    const names = new Set()
    for (const e of entries) {
      const n = comicName(e.filename)
      if (!map.has(n)) map.set(n, e)
      names.add(n)
    }
    const comic = { ...loader, entries: [...names].map((filename) => ({ filename })), loadBlob: (n, type) => loader.loadBlob(n, type ?? imageType(n)) }
    return { format: 'cbz', book: formatModule('cbz').makeComicBook(comic, { name: '' }) }
  }
  // FBZ: the FB2 inside.
  const fb2 = entries.find((e) => e.filename.toLowerCase().endsWith('.fb2'))
  const inner = new Uint8Array(await (await loader.loadBlob(fb2.filename)).arrayBuffer())
  checkFb2(inner)   // throws: custom entities (sniffFormat checks a plain FB2 the same way)
  return { format: 'fb2', book: await fb2Of(inner) }
}

/**
 * pdf.js's predefined cMaps from the page's own carried chunk (build.mjs `pdfcmaps`), run the first time a
 * PDF names one: a CJK font on one draws a blank page and extracts no text without them.
 */
class PdfCMaps {
  async fetch({ name }) {
    const b64 = formatModule('pdfcmaps')[name]
    if (!b64) throw new Error(`unknown CMap ${String(name).slice(0, 40)}`)
    return { cMapData: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), isCompressed: true }
  }
}

/** A book no view will show again: its own `destroy` (a pdf.js document, blob: URLs). Never throws. */
function destroy(b) {
  try { b?.destroy?.() } catch (e) { log('warn', `destroying a book: ${e?.message ?? e}`) }
}

/** Removes a book's `<meta http-equiv="refresh">` from `doc` (it navigates the section frame away; CSP does not cover it). */
function dropRefresh(doc) {
  const refresh = [...doc.querySelectorAll('meta[http-equiv]')].filter((m) => /refresh/i.test(m.getAttribute('http-equiv')))
  refresh.forEach((m) => m.remove())
  return refresh.length > 0
}

/**
 * One `telemetry` message per opened book (#1128): the layout in use 5 minutes in (or when the next
 * book opens first) and whether the reader switched it within those 5 minutes. A host's flow() before
 * `opened` is its stored setting, not a switch.
 */
const SESSION_MS = 5 * 60 * 1000
let session = null
function endSession() {
  if (!session) return
  clearTimeout(session.timer)
  post({ type: 'telemetry', event: 'reader-flow', mode: flow, format, switchedInFirst5Min: session.switched })
  session = null
}

const text = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? String(Object.values(v)[0] ?? '') : '')
const firstAuthor = (m) => { const a = [].concat(m?.author ?? [])[0]; return a?.name ?? a }

async function open(bytes, name, kind, mine) {
  const sha256 = await sha256Yielding(bytes)
  // Checked BEFORE book is assigned: a superseded open must not re-key the current book's saves (#1168).
  if (mine !== openSeq) return false
  // Made before the open book is touched: a file its reader cannot make a book of (a password-protected
  // or broken PDF, a damaged index) fails here, and the book on screen keeps reading and saving (openFor).
  const made = await makeBookFor(bytes, name, kind)
  // Superseded while it was made, or nothing to show: destroyed, never swapped in (a pdf.js document
  // holds the whole file).
  const empty = !made.book.sections?.length
  if (mine !== openSeq || empty) destroy(made.book)
  if (mine !== openSeq) return false
  if (empty) throw new Error(kind === 'pdf' ? 'this PDF has no pages' : 'this book has no sections')
  // The swap. The book on screen's last turn (a save still debounced) is written under its own key first, then
  // forgotten: flush() hands a host nothing of a previous open (the same book opened again, unmoved, #1286 review).
  saves.flush()
  saves.forget()
  endSession()
  book = { sha256, size: bytes.length, name }
  entry = null
  quotes = []
  hostMoving = true
  awaitingRestore = true
  readerActed = false
  navs = 0
  lastCfi = null
  viewSeq = mine
  navigating = Promise.resolve()
  // The old book's search ends here; the new view has none.
  searchSeq++
  searching = Promise.resolve()
  lastSelection = null
  // Nothing of the old book's selection is sent after the swap; a selection the host holds ends here.
  clearTimeout(selectionTimer)
  if (selectionSent) post({ type: 'selection-cleared' })
  selectionSent = null
  // The old book's image goes with it (`lightbox` closed is posted).
  lightbox.close()
  // A view that never rendered a section (a spine of linear="no", a book that failed to open) throws
  // from close(); letting that through would wedge the page and fail this good book instead.
  try { view?.close() } catch (e) { log('warn', `closing the previous book: ${e?.message ?? e}`) }
  // view.close() leaves the book alive: destroyed here, or each replaced PDF keeps its document.
  destroy(view?.book)
  view?.remove()
  overlays.clear()
  drawnRanges.clear()
  // Bookmarks: nothing queued for the old book (an `addHighlights` behind a navigation that never settles) holds up
  // this one's. (`placed`, the list and `awaitingMore` are set again by this book's restore.)
  placing.clear()
  spokenCfi = null
  view = document.createElement('foliate-view')
  document.body.append(view)
  view.addEventListener('load', onLoad)
  view.addEventListener('relocate', ({ detail: d }) => {
    // Each view's listeners carry the seq of the open that made them: once another view is on screen, a
    // dying view's events — close() still fires relocate — are dropped, not posted (#1168). A newer open
    // still being made does not silence this one.
    if (mine !== viewSeq) return
    // The save rule's own test: the reader moved the place (not a re-layout, not the same place again, not the
    // host moving the view). Sent as `moved`, so a host never guesses it from CFIs.
    const moved = d.reason !== 'anchor' && d.cfi !== lastCfi && !hostMoving
    // #1313, what moved the place: nothing (the same place again: `layout`, whatever asked for it); the landing of a
    // navigation (`nav`; foliate often reports a landing with reason 'anchor', as the new section expands); outside one,
    // a re-layout ('anchor': `layout`) or the reader's own turn (a swipe, a scroll, a tap or key turn, prev()/next()).
    // ponytail: a turn across a section in scrolled flow is foliate's re-anchoring (`layout`, about a screen uncounted
    // per section), and a swipe while a navigation lands is `nav`; the root fix is the fork tagging its own turn
    // crossings (paginator #turnPage/snap passing reason 'turn').
    const cause = d.cfi === lastCfi ? 'layout' : navs > 0 || (awaitingRestore && !readerActed) ? 'nav' : d.reason === 'anchor' ? 'layout' : 'turn'
    lastCfi = d.cfi
    post({ type: 'relocate', index: d.section?.current, sections: d.section?.total, fraction: d.fraction, toc: d.tocItem?.label ?? null, tocIndex: d.tocItem?.id ?? null, cfi: d.cfi, dir: pagedDir(), moved, cause, atEnd: atBookEnd(d.section?.current), chapterEnd: chapterEndFor(d), ...lengthAt(d.section?.current) })
    // A selection moved (or left the screen) with the view, a font or flow change's re-layout included: sent
    // again, or cleared.
    settleSelection()
    const position = moved && entry ? positionOf(d) : null
    if (position) {
      entry = withPosition(entry, position)
      persist(400)
    }
    // #1314, after the save (and never throwing): which bookmark the place has now, and whether one can be made here.
    postBookmarks(d, cause)
  })
  view.addEventListener('create-overlay', ({ detail: { index } }) => {
    if (mine !== viewSeq) return
    pruneDrawn()
    // #1271: marks are kept for the section on screen only (paginated and scrolled alike show one): the ones of a
    // section that left go, this one's are placed again from `vocab` once its document is the view's (after this
    // event, foliate attaches the overlayer and makes the view current).
    for (const [cfi, a] of overlays) {
      if (!a.mark) continue
      const rest = { ...a, mark: undefined }
      if (rest.hl || rest.gloss || rest.spoken) overlays.set(cfi, rest)
      else overlays.delete(cfi)
    }
    for (const a of overlays.values()) if (a.index === index) view.addAnnotation(a)
    // A task, not a microtask: the turn is painted (and its relocate sent) first, the marks right after.
    if (vocab.length) setTimeout(() => {
      if (mine === viewSeq) markSection(view.renderer.getContents().find((c) => c.index === index && c.overlayer))
    })
  })
  view.addEventListener('draw-annotation', ({ detail: { draw, annotation: a, range } }) => {
    if (a.hl) drawnRanges.set(a.value, range)
    draw(decorate, { hl: a.hl, gloss: a.gloss, mark: a.mark, spoken: a.spoken, el: elementOf(range) })
  })
  // A link within the book: followed as view.js would, its landing a navigation (#1313).
  view.addEventListener('link', (e) => {
    e.preventDefault()
    if (mine !== viewSeq) return
    const { href } = e.detail
    void navigate(() => asNav(() => view.goTo(href)))
  })
  view.addEventListener('external-link', (e) => {
    e.preventDefault()
    const href = openableHref(e.detail.a)
    if (href) post({ type: 'openLink', href })
    else log('warn', `link not opened, not http(s): ${String(e.detail.a.getAttribute('href')).slice(0, 80)}`)
  })
  format = made.format
  textual = isTextual(format)
  annotatable = textual && format !== 'pdf'
  // A book's <meta http-equiv="refresh"> is dropped before its section renders. Parsed every time,
  // never pre-matched on the source text: `&#x72;efresh` spells it past a text match. EPUB hands each
  // section through transformTarget, and so does KF8 (the fork's mobi.js); MOBI6 has none, so its section
  // documents are cleaned where they are made. FB2 and CBZ sections are built by foliate from whitelisted
  // elements only, and an HTML clip's by clip.mjs.
  const nb = made.book
  if (nb.transformTarget) nb.transformTarget.addEventListener('data', ({ detail }) => {
    if (!/html/.test(detail.type)) return
    detail.data = Promise.resolve(detail.data).then((str) => {
      if (typeof str !== 'string') return str
      const doc = new DOMParser().parseFromString(str, detail.type)
      return dropRefresh(doc) ? new XMLSerializer().serializeToString(doc) : str
    })
  })
  else if (typeof nb.createDocument === 'function') {
    const make = nb.createDocument.bind(nb)
    nb.createDocument = async (section) => { const doc = await make(section); dropRefresh(doc); return doc }
  }
  await view.open(nb)
  // The scrolled paginator relocates on a scroll only after a debounce, and not at all on the first one after
  // an anchored re-layout: a selection's box follows every scroll.
  view.renderer.addEventListener('scroll', () => {
    if (mine !== viewSeq) return
    settleSelection()
    if (flow === 'scrolled' && !hostMoving && !navs && Date.now() - scrollInputAt < 2000) {
      const section = view.renderer.getContents?.()[0]?.index
      if (Number.isInteger(section)) post({ type: 'reader-scroll', section, offset: view.renderer.start })
    }
  })
  view.renderer.setAttribute('flow', flow)
  view.renderer.setAttribute('margin', '24px')
  applyLook()
  await view.init({ showTextStart: true })
  // Still the view on screen: it answers `opened`, even if a newer open is under way (that one may yet fail
  // before its swap, and this book must not stay on screen unanswered and unrestorable).
  if (mine !== viewSeq) return false
  const { book: b } = view
  session = { at: Date.now(), switched: false, timer: setTimeout(endSession, SESSION_MS) }
  readySeq = mine
  post({
    // reflowable: false for a fixed-layout book (CBZ, a pre-paginated EPUB), where flow() changes nothing.
    // annotatable: false where highlights and the translation label are refused (CBZ, PDF).
    type: 'opened', book, format, textual, annotatable, reflowable: !view.isFixedLayout,
    // #1314: a bookmark can be made somewhere in this book (text at a CFI): not a CBZ, a PDF or a pre-paginated EPUB.
    bookmarkable: annotatable && !view.isFixedLayout,
    dir: pagedDir(),
    // Either may be missing, a string, or a language map ({ en: … }); the host falls back to the file name.
    title: text(b.metadata?.title), author: text(firstAuthor(b.metadata)),
    // #1269: the book's language (a string or a list, foliate's metadata); the hosts read it with readLang.
    lang: String([].concat(b.metadata?.language ?? [])[0] ?? '').slice(0, 35),
    sections: b.sections.length, toc: flat(b.toc ?? []),
    // #1315: the book has section documents to search (not a CBZ's images, nor a PDF: the fork's PDF reader makes none).
    searchable: b.sections.some((s) => typeof s.createDocument === 'function'),
  })
  // #1316: after the book is on screen and answered; nothing of an open waits for it.
  startChapters(view)
  return true
}

/**
 * The direction the renderer pages in (#1263). A fixed layout spreads by the book's page-progression direction
 * (EPUB spine, MOBI EXTH 527); a reflowable book lays its columns out by the section's own direction, as the
 * paginator's getDirection reads it (the book's language sets it where no attribute does). Left to right if unknown.
 */
function pagedDir() {
  if (view.isFixedLayout) return view.book.dir === 'rtl' ? 'rtl' : 'ltr'
  const doc = view.renderer.getContents?.()[0]?.doc
  const body = doc?.body
  if (!body) return 'ltr'
  return body.dir === 'rtl' || doc.documentElement.dir === 'rtl' || doc.defaultView.getComputedStyle(body).direction === 'rtl' ? 'rtl' : 'ltr'
}

/** The text a CFI points at in this book's own section document (not the rendered one): verification. */
async function textAt(cfi, bookmark = false) {
  const { index, anchor } = view.resolveCFI(cfi)
  const doc = await view.book.sections[index].createDocument()
  const range = anchor(doc)
  const text = range?.toString() ?? ''
  // A bookmark's (#1314): the text a bookmark made there keeps. A failure there is the range's own text, never a lost
  // entry; a highlight never runs it.
  let label = text
  if (bookmark && range?.startContainer) {
    try {
      if (testBreakBookmarks) throw new Error('test: the bookmark label broke')
      label = bookmarkText(range)
    } catch (e) { log('warn', `bookmark text at ${String(cfi).slice(0, 80)}: ${e?.message ?? e}`) }
  }
  return { index, text, label }
}

/** A stored highlight's (or bookmark's) text is still what is at its CFI, white space and typography aside. */
const stillThere = (h, { text, label }) => foldText(isBookmark(h) ? label : text) === foldText(h.selectedText ?? h.quote)

/**
 * The host's stored entry for this file (or null). A CFI is used only while the text there is still
 * the saved quote; otherwise that item is reported and left out, never drawn somewhere else.
 */
function restore(json, more = false) {
  // Only for the view on screen that answered `opened`: not a view still opening (a restore meant for an
  // earlier `opened` of the same file). A newer open still being made does not refuse it.
  if (!book || readySeq !== viewSeq) return log('warn', 'restore ignored: no book is ready for it')
  const mine = viewSeq
  // One slot of the navigation chain, taken when called: a host goTo made meanwhile runs after it and wins.
  return navigate(async () => {
    try {
      return await asNav(async () => {
        if (testRestoreDelay) await new Promise((done) => setTimeout(done, testRestoreDelay))
        // #1314: more annotations follow by `addHighlights` (the web host's pull): no bookmark is made before them.
        awaitingMore = !!more
        return restoreInto(json, () => mine !== viewSeq)
      }, false)
    } finally {
      // Whatever happened, the page saves again: a restore that threw used to silence every save. Not
      // for a view opened since: that one is still restoring.
      if (mine === viewSeq) hostMoving = awaitingRestore = false
    }
  })
}

/**
 * Highlights the host learned after `restore` (#1226: the web host pulls them after the position): each is
 * drawn where its text still is (as restore checks), joins the entry, and is not saved (the host holds it).
 * The reader is not moved. Queued behind the restore, so it lands in the restored entry. Answered by
 * `highlights`, one status per item (as `restored` reports them).
 */
const addHighlights = (list) => {
  // Said at once (#1314): no bookmark can be made until these are placed, however long the queue before them is.
  const called = viewSeq
  const token = placingStarts()
  return navigate(() => addHighlightsNow(list)).finally(() => {
    placing.delete(token)
    if (called !== viewSeq || !entry) return
    awaitingMore = false
    relist()
    postBookmarks()
  })
}
async function addHighlightsNow(list) {
  const mine = viewSeq
  const result = []
  for (const raw of Array.isArray(list) ? list : []) {
    if (!entry || !annotatable || mine !== viewSeq) return
    if (isQuotation(raw)) {
      if (!quotes.some((q) => q.id === raw.id)) quotes = [...quotes, raw]
      result.push({ id: raw.id, status: 'listed' })
      continue
    }
    const h = withHighlight(emptyEntry(book), raw).highlights[0]
    if (!h || entry.highlights.some((x) => x.id === h.id)) {
      result.push({ id: raw?.id, status: h ? 'already drawn' : 'not a highlight' })
      continue
    }
    const at = await textAt(h.cfi, isBookmark(h)).catch(() => ({ text: '', label: '' }))
    if (mine !== viewSeq || !entry) return
    const ok = stillThere(h, at)
    result.push({ id: h.id, status: ok ? 'restored' : 'quote mismatch, not drawn' })
    if (!ok) continue
    entry = withHighlight(entry, h)
    // A bookmark (#1314) is kept, never drawn.
    if (isBookmark(h)) placed.add(h.id)
    else if (savedQuote(h)) placedQuotes.add(h.id)
    else annotate({ value: h.cfi, index: at.index, hl: { id: h.id, color: h.color } })
  }
  post({ type: 'highlights', key: book.sha256, highlights: result })
  postList()
}

/** `stale()`: another view took over during an await; nothing more is done or answered for this one. */
async function restoreInto(json, stale) {
  const stored = json ? entryFor(json, book) : null
  entry = stored ?? emptyEntry(book)
  // #1195: the host's quotations are listed, never part of the entry the page stores.
  quotes = entry.quotations ?? []
  delete entry.quotations
  // The bookmarks found are this entry's (a second restore of the same view replaces them); none can be made until
  // they are placed and the position has landed.
  placed.clear()
  placedQuotes.clear()
  relist()
  const token = placingStarts()
  try {
    return await restoreNow(json, stored, stale)
  } finally {
    placing.delete(token)
    if (!stale()) {
      relist()
      postBookmarks()
    }
  }
}
async function restoreNow(json, stored, stale) {
  const result = { found: !!stored, rejected: !!json && !stored, position: 'none', highlights: [] }
  for (const h of entry.highlights) {
    const at = await textAt(h.cfi, isBookmark(h)).catch(() => ({ text: '', label: '' }))
    if (stale()) return result
    // An entry written before selectedText (#1078) kept the whole selection in quote.
    const ok = stillThere(h, at)
    result.highlights.push({ id: h.id, status: ok ? 'restored' : 'quote mismatch, not drawn' })
    if (!ok) continue
    // A bookmark (#1314) is kept, never drawn.
    if (isBookmark(h)) placed.add(h.id)
    else if (savedQuote(h)) placedQuotes.add(h.id)
    else annotate({ value: h.cfi, index: at.index, hl: { id: h.id, color: h.color } })
  }
  const p = entry.position
  if (p && !fits(p)) {
    // A page number only on a PDF; a CFI or a fraction never on one (#1128 S5).
    result.position = 'wrong position kind, stayed at start'
  } else if (p && format === 'pdf') {
    if (p.page > view.book.sections.length) result.position = 'page not found, stayed at start'
    else {
      const arrived = (await land(p)) >= 0
      if (stale()) return result
      result.position = arrived ? 'restored' : 'navigation failed, stayed at start'
    }
  } else if (isFractionOnly(p)) {
    // A transitional server locator (#1187): no CFI and no quote to check, only where in the book.
    // Approximate (the legacy fraction counts words, foliate's bytes). Fraction 0 (never read on the other
    // device) is the text start init already shows: no navigation. The entry keeps the fraction until
    // the reader moves (the save rule).
    const arrived = p.fraction === 0 || (await land(p)) >= 0
    if (stale()) return result
    result.position = arrived ? 'restored by fraction' : 'navigation failed, stayed at start'
  } else if (p && (isNamedPage(p) || pageForm())) {
    // A named page, by its shape as `land()` takes it: the stored key must still be a page of this book. A
    // quoted position on a page-form book (CBZ, pre-paginated EPUB) has no page to find.
    const index = isNamedPage(p) ? sectionNamed(p.page, p.index) : -1
    if (index < 0) result.position = 'page not found, stayed at start'
    else {
      await view.goTo(index)
      if (stale()) return result
      result.position = arrivedAt(index) ? 'restored' : 'navigation failed, stayed at start'
    }
  } else if (p) {
    const { index, text } = await textAt(p.cfi).catch(() => ({ text: '' }))
    if (stale()) return result
    // (A `page` position has no quote: it cannot be verified on a book with text.)
    if (!text || !p.quote ||!foldText(text).startsWith(foldText(p.quote))) result.position = 'quote mismatch, stayed at start'
    else {
      await view.goTo(p.cfi)
      if (stale()) return result
      result.position = arrivedAt(index) ? 'restored' : 'navigation failed, stayed at start'
    }
  }
  // For the view still on screen only (`stale` turns at the swap).
  // `key`: the book it is for (= `store`'s key), so a host drops one for a book it is not reading.
  if (!stale()) {
    post({ type: 'restored', key: book.sha256, ...result })
    postList()
  }
  return result
}


/**
 * The live selection (else the last `selection` sent), exactly as a `selection` message describes it, as a highlight
 * of `color` (#1312: one of `HIGHLIGHT_COLORS`, yellow by default): CFI + selection (+ its ≤64-code-point quote) + 30
 * chars of context, saved.
 */
function highlightSelection(color = 'yellow', quotation = false) {
  if (quotation) color = 'quote'
  if (!quotation && !isHighlightColor(color)) return log('warn', 'highlightSelection ignored: not a colour')
  if (!textual) return log('warn', 'highlightSelection ignored: this book has no text')
  if (!annotatable) return log('warn', 'highlightSelection ignored: no highlights on a PDF yet')
  // The live selection, settled or not, on screen or not, described as a `selection` message would describe it;
  // without one (a host's button press collapsed it first), the last one sent.
  const live = shownDocs().map(liveRange).find(Boolean)
  const s = live ? describe(live) : lastSelection
  if (!s || s.range.collapsed) return null
  // Before `restored` there is nothing to add to, and saving now would overwrite the stored entry.
  if (!entry) return log('warn', 'highlightSelection ignored: the stored entry is not restored yet')
  const selectedText = s.range.toString()
  // An image-only or whitespace-only selection (a paragraph break) has no text: the server refuses
  // it (SyncValidation.RequiredText), and the page would draw a highlight that can never sync.
  if (!selectedText.trim()) return log('warn', 'highlightSelection ignored: the selection has no text')
  // Refused, not cut: a cut selectedText no longer reads as the text at the CFI, so it would never restore.
  if (selectedText.length > MAX_SELECTED_TEXT) return log('warn', `highlightSelection ignored: over ${MAX_SELECTED_TEXT} characters`)
  const cfi = view.getCFI(s.index, s.range)
  // Exactly a drawn highlight's range (#1312 review): that highlight, recoloured if need be, never a second one over it
  // (it would own the taps while the host's diff took it for the first's twin, and write none of its edits).
  const same = sameRangeHighlight(entry.highlights, cfi, listedIds())
  if (same) {
    if (!quotation && same.color !== color) recolorHighlight(same.id, color)
    endSelection()
    post({ type: 'highlighted', id: same.id, cfi, quote: same.quote, selectedText: same.selectedText ?? same.quote, color })
    return same
  }
  const loc = rangeToLocator(s.doc.body, s.range, String(s.index))
  const h = {
    id: uuidV4(), cfi, index: s.index,
    quote: quoteOf(selectedText), selectedText, prefix: loc?.text?.before ?? '', suffix: loc?.text?.after ?? '', color, at: Date.now(),
  }
  entry = withHighlight(entry, h)
  persist()
  if (quotation) placedQuotes.add(h.id)
  else annotate({ value: h.cfi, index: s.index, hl: { id: h.id, color } })
  // The selection is done, as `clearSelection` ends it: at once, not after the settle time, or the next press within it
  // would be taken for its dismissal and its tap (a tap on the new highlight) dropped (#1312).
  endSelection()
  post({ type: 'highlighted', id: h.id, cfi: h.cfi, quote: h.quote, selectedText, color })
  postList()
  return h
}

/** The selection is over: gone from every shown section, `selection-cleared` at once if one was sent, nothing to fall back on. */
function endSelection() {
  clearTimeout(selectionTimer)
  for (const d of shownDocs()) d.getSelection()?.removeAllRanges()
  lastSelection = null
  if (selectionSent) post({ type: 'selection-cleared' })
  selectionSent = null
}

const openFailed = (name, error) => post({ type: 'open-failed', name, error })

/**
 * One `opened` or one `open-failed` per call — unless a newer openUrl took over first: then neither, except a
 * book already swapped in, which answers `opened` while it is still the view on screen (the newer open may yet fail).
 */
function openFor(bytes, name, mine, fileFormat) {
  // Refused before anything is touched: a DRM book, a damaged KF8 or an unknown file leaves
  // the open book reading, reporting and saving, like a failed read (#1168). No view swap, no session end.
  // An HTML clip is only what the host says is one (the server's file format): never guessed from bytes.
  let kind
  try { kind = fileFormat === 'html' ? 'html' : sniffFormat(bytes) } catch (e) { return openFailed(name, String(e?.message ?? e).slice(0, 200)) }
  return open(bytes, name, kind, mine).catch((e) => {
    log('error', `open: ${e?.stack ?? e}`)
    // Failed before the swap: the book on screen never stopped reading (its view is still `viewSeq`).
    if (mine === openSeq) openFailed(name, String(e?.message ?? e).slice(0, 200))
  })
}

/** A served file's bytes (openUrl's read, as a promise). */
const readBytes = (url) => new Promise((done, fail) => {
  const x = new XMLHttpRequest()
  x.responseType = 'arraybuffer'
  x.onload = () => (x.status === 200 && x.response ? done(new Uint8Array(x.response)) : fail(new Error(`cannot read the file (status ${x.status})`)))
  x.onerror = () => fail(new Error('cannot read the file'))
  x.open('GET', url)
  x.send()
})

/**
 * #1426: one `described` per call with a valid id. With `url`, a book of its own, made without the view and destroyed
 * after: no open sequence is touched, so it never supersedes an open and the book on screen keeps reading. Without,
 * the book on screen. A cover that fails to draw is none; the details are still sent.
 */
async function describeBook(id, url) {
  if (!isRequestId(id)) return log('warn', 'describe ignored: no request id')
  const answer = (a) => post({ type: 'described', id, meta: null, cover: null, ...a })
  let made = null
  try {
    let b = view?.book
    if (url) {
      const bytes = await readBytes(url)
      b = made = (await makeBookFor(bytes, 'book', sniffFormat(bytes))).book
    }
    if (!b) return answer({ error: 'no book is open' })
    const meta = bookMeta(b.metadata, navigator.language)
    const cover = await Promise.resolve(b.getCover?.()).then(coverJpeg).catch((e) => {
      log('warn', `describe: no cover (${e?.name ?? 'error'})`)
      return null
    })
    // ADR-033 P3: the contents the server keeps (chapters.mjs `tocEntries`); none when they cannot be read.
    const toc = await tocEntries(flat(b.toc ?? []), b.sections, (href) => b.resolveHref(href), b.rendition?.layout === 'pre-paginated').catch((e) => {
      log('warn', `describe: no contents (${e?.name ?? 'error'})`)
      return []
    })
    answer({ meta, cover, toc })
  } catch (e) {
    log('warn', `describe: ${e?.name ?? 'error'}`)
    answer({ error: String(e?.message ?? e).slice(0, 200) })
  } finally {
    if (made) destroy(made)
  }
}

// A save still debounced is written before the page may go away: hidden (backgrounded, a tab switch) or unloaded.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saves.flush() })
addEventListener('pagehide', () => saves.flush())

window.__fol = {
  // The host is leaving (backgrounded, unmounted, closed): a save still debounced is written at once. Returns the
  // latest `store` (#1286: the web host takes it synchronously; untrusted there, read as a `store` message).
  flush: () => saves.flush(),
  // Read by the page itself (Android: the host's interceptor, bookOrigin.mjs; web: a blob: URL): no book bytes
  // cross the bridge. `open-failed`: unreadable, not a book this page reads, DRM- or password-protected. `fileFormat`:
  // the server's for the file, when the host knows it; only 'html' (a clip) is acted on, every other is sniffed.
  openUrl: (url, name, fileFormat = null) => {
    // Order requests before reading: an older XHR may finish after the latest book has opened (#1069).
    // viewSeq changes only at the swap, so a failed read still leaves the current book reading and saving.
    const mine = ++openSeq
    const x = new XMLHttpRequest()
    x.responseType = 'arraybuffer'
    x.onload = () => {
      if (mine !== openSeq) return
      return x.status === 200 && x.response
        ? openFor(new Uint8Array(x.response), name, mine, fileFormat)
        : openFailed(name, `cannot read the file (status ${x.status})`)
    }
    x.onerror = () => { if (mine === openSeq) openFailed(name, 'cannot read the file') }
    x.open('GET', url)
    x.send()
  },
  restore: (json, more) => restore(json, more)?.catch((e) => log('error', `restore: ${e?.stack ?? e}`)),
  addHighlights: (list) => addHighlights(list).catch((e) => log('error', `addHighlights: ${e?.stack ?? e}`)),
  highlightSelection,
  saveQuotation: () => highlightSelection('yellow', true),
  recolorHighlight,
  removeHighlight,
  addBookmark,
  removeBookmark,
  // A position (as stored: CFI, page or fraction-only, #1187; one that does not fit the book is ignored),
  // a CFI, an href or a section index. Not
  // `chosen` (the host moving the view: a sync adopt or move) nothing is saved or echoed back, the host
  // already holds that position; a position becomes the entry's own, so a later save (a highlight) does
  // not write the old place back. `chosen` (the reader's own choice: a taken offer) the place it landed
  // on is saved, built as a relocate's save is. Not arrived: nothing changes.
  goTo: (target, chosen = false) => navigate(async () => {
    if (!view?.book) return
    if (target === '') return log('warn', 'goTo ignored: a quotation has no place')
    if (target && typeof target === 'object' && !isPosition(target)) return log('warn', 'goTo ignored: not a position')
    if (isPosition(target) ? !fits(target) : format === 'pdf' && String(target).startsWith('epubcfi(')) return log('warn', 'goTo ignored: wrong position kind for this book')
    if (isPdfPage(target) && target.page > view.book.sections.length) return log('warn', 'goTo ignored: page not in this book')
    const mine = viewSeq
    hostMoving = true
    let at = -1
    try { at = await asNav(() => land(target)) } finally { if (mine === viewSeq) hostMoving = !entry }
    if (mine !== viewSeq || !entry) return
    if (at < 0) return log('warn', 'goTo: the target did not land, position kept')
    // #1314: a jump to a bookmark's own CFI: that bookmark is the one here, wherever on the screen it landed.
    const cfi = isPosition(target) ? target.cfi : target
    const jumped = entry.highlights.find((h) => placed.has(h.id) && h.cfi === cfi)
    if (jumped) {
      hereId = jumped.id
      postBookmarks()
    }
    if (!chosen) {
      if (isPosition(target)) entry = withPosition(entry, target)
      return
    }
    // A fixed layout's target on the spread already shown is rendered without a relocate, and the renderer's own
    // index keeps the side it had (`goToSpread` re-renders only): `lastLocation` names the side shown before. The
    // place is built from the section the target landed on (#1196 review).
    const loc = view.lastLocation
    const shown = view.isFixedLayout && loc ? { ...loc, cfi: view.getCFI(at), section: { ...loc.section, current: at } } : loc
    const landed = positionOf(shown)
    if (!landed) return log('warn', 'goTo: nothing to save here (no text position)')
    // The save rule's previous place is the one saved: a turn back to the side shown before is a move.
    if (shown !== loc) lastCfi = shown.cfi
    entry = withPosition(entry, landed)
    persist()
  }),
  // The target is read once the previous navigation has landed: two quick taps move two sections.
  section: (delta) => navigate(() => {
    if (!view?.book) return
    const i = (view.lastLocation?.section?.current ?? 0) + delta
    if (i >= 0 && i < view.book.sections.length) return asNav(() => view.goTo(i))
  }),
  // A turn is the reader acting, when it runs (behind a navigation queued before it).
  next: () => navigate(() => { readerActed = true; return view?.next() }),
  prev: () => navigate(() => { readerActed = true; return view?.prev() }),
  // Test-only (formats.check.mjs; the build has no test mode): a navigation of the view on screen that lands after
  // `ms`, or never.
  __testHoldNav: (ms) => void asNav(() => new Promise((done) => { if (ms) setTimeout(done, ms) })),
  __testRestoreDelay: (ms) => { testRestoreDelay = ms },
  // Test-only: the next opens find out where their contents lead `ms` later (#1316: an open never waits for it).
  __testHoldChapters: (ms) => { testHoldChapters = ms },
  // #1260: the whole settings object, read through settings.mjs (closed lists, a clamped size): nothing of the
  // host's reaches the CSS as it came. Applied live; before `opened` it sets what the next open uses.
  settings: (raw) => { look = readSettings(raw); applyLook(); return look },
  // Insets affect the text viewport only; the shell's paper and edge shading remain full-screen.
  insets: (raw) => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const value = raw?.[side]
      if (Number.isFinite(value) && value >= 0 && value <= 256) document.documentElement.style.setProperty(`--reader-safe-${side}`, `${value}px`)
    }
  },
  // The size alone, ±px (the format check's re-layout rows): `settings` with one field changed.
  font: (delta) => window.__fol.settings({ ...look, fontSize: look.fontSize + delta }).fontSize,
  // Switches the live view: foliate re-renders on the attribute, no reload (#1128). Before `opened` it
  // only sets what the next open uses.
  flow: (f) => {
    if (f !== 'paginated' && f !== 'scrolled') return log('warn', `flow ignored: ${String(f).slice(0, 20)}`)
    // A fixed-layout book (CBZ) has no flow to switch: the setting is kept for the next book, but no
    // switch is reported for one that changed nothing. The clock is read, not only the timer: a throttled
    // WebView can fire it late, and a switch past 5:00 must not count (formats.check, late timer).
    if (session && f !== flow && !view.isFixedLayout && Date.now() - session.at < SESSION_MS) session.switched = true
    flow = f
    view?.renderer?.setAttribute('flow', f)
  },
  // #1269: the host is done with the selection (an action ran, its toolbar closed): gone from every shown section,
  // `selection-cleared` at once (none if none was sent). highlightSelection has nothing to fall back on after it.
  clearSelection: () => endSelection(),
  // #1265: the host closes the lightbox (Android back, a host Escape): `lightbox` closed is posted. None open: nothing.
  closeLightbox: () => lightbox.close(),
  // #1267: the host's words for the lightbox (its dialog's name with no alt text, its close button's), sent on `ready`:
  // the page has no i18n. Untrusted shape: lightbox.mjs `readLabels` keeps only non-blank strings, capped.
  labels: (l) => lightbox.labels(l),
  // Test-only (formats.check.mjs): how many drawn highlight ranges the page holds. A count, no book data.
  drawnRanges: () => drawnRanges.size,
  // Test-only (formats.check.mjs): how many bookmarks the page holds as found, and a bookmark pass that throws.
  placedBookmarks: () => placed.size,
  __testBreakBookmarks: (on) => { testBreakBookmarks = !!on },
  /**
   * #1271: the reader's saved words, `[{ word, stage, gloss }]` (read through wordMarks.mjs `readMarkWords`), and whether
   * their glosses show (the reader's setting). Replaces the list held; the section on screen is marked again at once,
   * every later one as it loads. Before `opened` it sets what the next open marks. Not where `annotatable` is false.
   * ponytail: the whole list comes again with every change (a save, a backfilled translation) and the section on screen
   * is matched again; delta calls (`addMarkWord`, `setGloss`) if a large vocabulary makes a save jank.
   */
  markWords: (words, show) => {
    const glosses = !!show !== showGlosses
    vocab = readMarkWords(words)
    showGlosses = !!show
    if (glosses) applyLook()
    if (!view || !annotatable) return
    for (const c of view.renderer?.getContents?.() ?? []) markSection(c, glosses)
  },
  // Test-only (formats.check.mjs): how many saved-word marks the page holds. A count, no book data.
  markedWords: () => [...overlays.values()].filter((a) => a.mark).length,
  // #1426: the book's details and cover, answered with `described` under the host's `id`: the file at `url`, read on
  // its own (the view untouched), or the book on screen.
  describe: (id, url = null) => void describeBook(id, url),
  // #1316: the text of contents entry `tocIndex` (or, in a book with no contents, of spine section `section`),
  // answered with `chapter-text` under the host's `request` id.
  chapterText: (request, tocIndex, section) => void chapterText(request, tocIndex, section),
  /** The host answers a `word` with its translation; drawn above that word. Not where `annotatable` is false. */
  showTranslation: (cfi, index, text) => view && annotatable && annotate({ value: cfi, index, gloss: text }),
  speaking,
  // #1315: search the open book (`search-results`); a new call ends the one running; `search(null)` ends it and
  // removes the hits drawn.
  search,
}

applyLook()
post({ type: 'ready' })
