// The V2 reader page (ADR-029), bundled alone by build.mjs into v2ReaderPage.generated.ts and run in
// the reader's WebView. foliate-js parses AND renders a local EPUB, MOBI/AZW3, FB2 or CBZ (#1128: the
// last three's readers run only when such a book opens, see formatModule); this file adds word tap → host, the
// translation drawn above the word, and the reader data (position + highlights by CFI and quote, one
// entry per book file). The host ↔ page message contract is in README.md.
import './.vendor/foliate-js/view.js'
import { Overlayer } from './.vendor/foliate-js/overlayer.js'
import { EPUB } from './.vendor/foliate-js/epub.js'
import { BlobReader, BlobWriter, TextWriter, ZipReader, configure } from './.vendor/foliate-js/vendor/zip.js'
import { tokenizeVocabWords } from '../../../../../packages/shared/src/text/vocabKey'
import { rangeToLocator } from '../../../../../packages/reader-engine/src/text'
import { mergeOverlay } from './overlays.mjs'
import { createSaveScheduler } from './saveScheduler.mjs'
import { isFractionOnly } from '../../../../../packages/shared/src/reader/fractionPosition'
import { emptyEntry, entryFor, foldText, isPdfPage, isPosition, quoteOf, sha1, sha256Yielding, withHighlight, withPosition } from './store.mjs'
import { uuidV4 } from './uuid.mjs'
import { openableHref, sentenceOf } from './tap.mjs'
import { checkFb2, comicName, fb2AsUtf8, imageType, isTextual, sniffFormat, withoutKf8, zipFormat } from './formats.mjs'

const post = (m) => window.ReactNativeWebView?.postMessage(JSON.stringify(m))
const log = (level, msg) => post({ type: 'log', level, msg })
addEventListener('error', (e) => log('error', String(e.error?.stack ?? e.message)))
addEventListener('unhandledrejection', (e) => log('error', String(e.reason?.stack ?? e.reason)))

let view = null
let fontPx = 18
let flow = 'paginated'   // ADR-029 Decision 1
/** The open book's format (formats.mjs) and whether it has text: a comic book has no words to tap, select or translate. */
let format = null
let textual = true
/** cfi → what is drawn over it; re-added when a section's overlayer is recreated (chapter navigation). */
const overlays = new Map()
/** This file's identity and its entry. No save until the stored one is restored. */
let book = null
let entry = null
/**
 * The host is moving the view: from `open` until its restore has run, and during a host `goTo` (a sync
 * adopt or move). Its relocates save nothing and nothing is echoed back: the host already holds that
 * position (`applyStates` stored it before calling). Only the reader moving saves.
 */
let hostMoving = false
/**
 * The save rule: a relocate saves the position only when the reader moved — its renderer `reason` is not
 * 'anchor' (foliate re-laying the page out: a resize, a font or flow change) AND its CFI differs from the
 * previous relocate's (foliate relocates again where it already is: after a landing, and the 'snap' of
 * every touchend). `lastCfi` follows every relocate of the open book, re-layouts included.
 */
let lastCfi = null
/**
 * The renderer's `reason` for the relocate being handled: foliate's view emits its relocate without it.
 * ponytail: a capture listener on view.renderer (at the target, capture runs before the view's own
 * listener); drop it once the fork's view.js #onRelocate forwards `reason` in its detail (#1182 pin bump).
 */
let rendererReason
let lastSelection = null
/** The open that is allowed to finish: a second openUrl makes the first one give up silently. */
let openSeq = 0
/**
 * The open whose view (and navigation chain) is in use. Set in `open` where they turn over, not when
 * `openSeq` does (before the new book is hashed, while the old view still shows): a call stamped with
 * it never runs on a view it was not made for. While `openSeq !== viewSeq` a newer open is on its way.
 */
let viewSeq = 0
/** The view that finished opening (`opened` posted): a restore is for that view only. */
let readySeq = 0
const saves = createSaveScheduler(post)

// Our reader's own look: generous line-height leaves room above a word for its label.
const css = () => `html, body { font-size: ${fontPx}px !important; line-height: 1.7 !important; }`

const SVG = 'http://www.w3.org/2000/svg'
const GLOSS_COLOR = 'rgba(59, 130, 246, 0.8)'
/**
 * The product's inline translation — saved-word underline + italic label centred
 * above the word (reader-engine LABEL_LOOK, E44). foliate calls it again with fresh rects on every
 * expand (font size, viewport), so the label follows the word without our own layout code.
 */
function glossOf(rects, text, el) {
  const g = document.createElementNS(SVG, 'g')
  const first = rects[0]
  if (!first) return g
  // The book's size at draw time (options are reused on redraw, so read it here, not when added).
  const fs = parseFloat(el.ownerDocument.defaultView.getComputedStyle(el).fontSize) || 16
  for (const r of rects) {
    const u = document.createElementNS(SVG, 'rect')
    Object.entries({ x: r.left, y: r.bottom - 2, width: r.width, height: 2, fill: GLOSS_COLOR }).forEach(([k, v]) => u.setAttribute(k, v))
    g.append(u)
  }
  const t = document.createElementNS(SVG, 'text')
  t.setAttribute('x', first.left + first.width / 2)
  t.setAttribute('y', first.top - 2)
  t.setAttribute('text-anchor', 'middle')
  t.setAttribute('fill', 'currentColor')
  t.setAttribute('style', `font-style: italic; font-size: ${(fs * 0.42).toFixed(1)}px; opacity: .75`)
  t.textContent = text
  g.append(t)
  return g
}

const HIGHLIGHT_COLOR = '#facc15'
/**
 * Foliate draw fn, called again with fresh rects on every expand (font size, viewport), so both
 * decorations follow the text without our own layout code. One overlay carries both: see overlays.mjs.
 */
function decorate(rects, { hl, gloss, el }) {
  const g = document.createElementNS(SVG, 'g')
  if (hl) g.append(Overlayer.highlight(rects, { color: HIGHLIGHT_COLOR }))
  if (gloss) g.append(glossOf(rects, gloss, el))
  return g
}

function onTap(doc, index, e) {
  if (e.target.closest?.('a[href]')) return   // foliate owns links
  if (!doc.getSelection().isCollapsed) return   // a selection, not a word tap
  const c = doc.caretRangeFromPoint?.(e.clientX, e.clientY)
  const node = c?.startContainer
  if (!node || node.nodeType !== Node.TEXT_NODE) return post({ type: 'tap' })
  // Same word rule as the reader engine's wordAt (soft hyphens kept inside the word).
  const w = tokenizeVocabWords(node.data.replace(/­/g, 'a')).find((t) => t.start <= c.startOffset && c.startOffset <= t.end)
  if (!w || !/\p{L}/u.test(w.word)) return post({ type: 'tap' })
  const range = doc.createRange()
  range.setStart(node, w.start)
  range.setEnd(node, w.end)
  // The caret snaps to the nearest text: a tap in a margin is not a tap on the line's last word.
  const r = range.getBoundingClientRect()
  if (e.clientX < r.left - 4 || e.clientX > r.right + 4 || e.clientY < r.top - 4 || e.clientY > r.bottom + 4) return post({ type: 'tap' })
  const frame = doc.defaultView.frameElement.getBoundingClientRect()
  post({
    type: 'word', index, word: node.data.slice(w.start, w.end).replace(/­/g, ''),
    sentence: sentenceOf(node, w.start, w.end), cfi: view.getCFI(index, range),
    // Host-viewport coordinates of the word (iframe rect + range rect).
    rect: { x: Math.round(frame.left + r.left), y: Math.round(frame.top + r.top), w: Math.round(r.width), h: Math.round(r.height) },
  })
}

function onLoad({ detail: { doc, index } }) {
  // Images only: every tap is a chrome toggle, and nothing is kept for a highlight.
  if (!textual) return doc.addEventListener('click', () => post({ type: 'tap' }))
  doc.addEventListener('click', (e) => onTap(doc, index, e))
  // Kept, not read on demand: tapping a host button may clear the WebView's selection first.
  doc.addEventListener('selectionchange', () => {
    const s = doc.getSelection()
    if (s.rangeCount && !s.isCollapsed) lastSelection = { index, doc, range: s.getRangeAt(0).cloneRange() }
  })
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
 * foliate's goTo resolves with the target it resolved, arrived or not (a locked paginator, a section that
 * failed to load): the renderer is asked whether that section is on screen. A fixed-layout renderer's
 * contents carry no index, and a target in the spread already shown emits no relocate, so it is asked
 * whether the target's spread is the one shown.
 */
function arrivedAt(index) {
  const r = view.renderer
  if (!view.isFixedLayout) return !!r?.getContents?.().some((c) => c.index === index)
  const spreadOf = (i) => r?.getSpreadOf?.(view.book.sections[i])?.index
  return spreadOf(index) != null && spreadOf(index) === spreadOf(r.index)
}

/**
 * Goes to a goTo target or a stored position and answers whether the view arrived. A fraction-only one
 * (#1187) by its fraction, 0 being the text start (not a cover before it); any other position by its CFI.
 */
async function land(target) {
  const resolved = await (isFractionOnly(target)
    ? (target.fraction === 0 ? view.goToTextStart() : view.goTo({ fraction: target.fraction }))
    : view.goTo(isPdfPage(target) ? target.page - 1 : isPosition(target) ? target.cfi : target))
  return !!resolved && arrivedAt(resolved.index)
}

/**
 * The place a relocate (or `view.lastLocation`) shows, as the entry's position: the one builder for
 * every save. The visible range's start: its CFI and the text there, to verify the CFI on restore. An
 * image page has no text and so no quote: its entry name in the archive (`page`) is what restore checks.
 * Null where there is nothing to build from: a text book's location without a range (a pre-paginated
 * EPUB: foliate's fixed-layout renderer reports none), so such a book saves no position at all.
 */
function positionOf(d) {
  // A PDF page: `pdf-page` (ADR-032 Decision 7), the section index + 1. Never a CFI.
  if (d && format === 'pdf') return Number.isInteger(d.section?.current) ? { page: d.section.current + 1, index: d.section.current, fraction: d.fraction, at: Date.now() } : null
  if (!d || (textual && !d.range)) return null
  const at = { cfi: d.cfi, index: d.section?.current, fraction: d.fraction, at: Date.now() }
  return textual ? { ...at, quote: quoteOf(d.range.toString().replace(/^\s+/, '')) } : { ...at, page: String(view.book.sections[at.index]?.id ?? '') }
}

const flat = (items) => items.flatMap((t) => [{ label: t.label?.trim(), href: t.href }, ...flat(t.subitems ?? [])])

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
    // pdf.js runs on the main thread (build.mjs FORMATS.pdf): no Worker, no wasm (CSP has no
    // 'wasm-unsafe-eval'), nothing fetched: cMaps come from the page's own chunk (PdfCMaps), standard-font
    // data not at all (system fonts).
    const { makePDF, css } = formatModule('pdf')
    const book = await makePDF(new File([bytes], name), { css, params: { useWasm: false, CMapReaderFactory: PdfCMaps } })
    // One page per screen, never foliate's two-page spreads: within a spread a page step or goTo shows the
    // other page without a relocate, so the saved page would be the spread's first.
    book.rendition.spread = 'none'
    return { format: 'pdf', book }
  }
  if (kind === 'mobi') {
    const { MOBI, unzlibSync } = formatModule('mobi')
    // A MOBI/KF8 combo is read as its MOBI6 half: KF8 is refused (formats.mjs).
    return { format: 'mobi', book: await new MOBI({ unzlib: unzlibSync }).open(new File([withoutKf8(bytes)], name)) }
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
 * PDF names one: a CJK font without them draws a blank page and extracts no text.
 */
class PdfCMaps {
  async fetch({ name }) {
    const b64 = formatModule('pdfcmaps')[name]
    if (!b64) throw new Error('unknown CMap')
    return { cMapData: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), isCompressed: true }
  }
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
  // Nothing of the previous book may land on this one; its entry is gone with the next line.
  saves.cancel()
  const sha256 = await sha256Yielding(bytes)
  // Checked BEFORE book is assigned: a superseded open must not re-key the current book's saves (#1168).
  if (mine !== openSeq) return false
  endSession()
  book = { sha256, size: bytes.length, name }
  entry = null
  hostMoving = true
  lastCfi = null
  rendererReason = undefined
  viewSeq = mine
  navigating = Promise.resolve()
  lastSelection = null
  // A view that never rendered a section (a spine of linear="no", a book that failed to open) throws
  // from close(); letting that through would wedge the page and fail this good book instead.
  try { view?.close() } catch (e) { log('warn', `closing the previous book: ${e?.message ?? e}`) }
  view?.remove()
  overlays.clear()
  view = document.createElement('foliate-view')
  document.body.append(view)
  view.addEventListener('load', onLoad)
  view.addEventListener('relocate', ({ detail: d }) => {
    // Each view's listeners carry the seq of the open that made them: once a newer open has taken
    // over, a dying view's events — close() still fires relocate — are dropped, not posted (#1168).
    if (mine !== openSeq) return
    post({ type: 'relocate', index: d.section?.current, sections: d.section?.total, fraction: d.fraction, toc: d.tocItem?.label ?? null, cfi: d.cfi })
    const moved = rendererReason !== 'anchor' && d.cfi !== lastCfi
    lastCfi = d.cfi
    const position = moved && !hostMoving && entry ? positionOf(d) : null
    if (!position) return
    entry = withPosition(entry, position)
    persist(400)
  })
  view.addEventListener('create-overlay', ({ detail: { index } }) => {
    if (mine !== openSeq) return
    for (const a of overlays.values()) if (a.index === index) view.addAnnotation(a)
  })
  view.addEventListener('draw-annotation', ({ detail: { draw, annotation: a, range } }) => {
    const el = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer
    draw(decorate, { hl: a.hl, gloss: a.gloss, el })
  })
  view.addEventListener('external-link', (e) => {
    e.preventDefault()
    const href = openableHref(e.detail.a)
    if (href) post({ type: 'openLink', href })
    else log('warn', `link not opened, not http(s): ${String(e.detail.a.getAttribute('href')).slice(0, 80)}`)
  })
  const made = await makeBookFor(bytes, name, kind)
  if (mine !== openSeq) return false
  format = made.format
  textual = isTextual(format)
  // A book's <meta http-equiv="refresh"> is dropped before its section renders. Parsed every time,
  // never pre-matched on the source text: `&#x72;efresh` spells it past a text match. EPUB hands each
  // section through transformTarget; MOBI6 has none, so its section documents are cleaned where they
  // are made. (KF8's sections bypass its transformTarget: one reason KF8 is refused, formats.mjs.) FB2
  // and CBZ sections are built by foliate from whitelisted elements only.
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
  // Capture: at the target it runs before the view's own listener, which emits the view's relocate.
  view.renderer.addEventListener('relocate', ({ detail }) => { rendererReason = detail.reason }, true)
  view.renderer.setAttribute('flow', flow)
  view.renderer.setAttribute('margin', '24px')
  // The fixed-layout renderer (CBZ, a pre-paginated EPUB) has no styles to set.
  view.renderer.setStyles?.(css())
  await view.init({ showTextStart: true })
  if (mine !== openSeq) return false
  const { book: b } = view
  session = { at: Date.now(), switched: false, timer: setTimeout(endSession, SESSION_MS) }
  readySeq = mine
  post({
    // reflowable: false for a fixed-layout book (CBZ, a pre-paginated EPUB), where flow() changes nothing.
    type: 'opened', book, format, textual, reflowable: !view.isFixedLayout,
    // Either may be missing, a string, or a language map ({ en: … }); the host falls back to the file name.
    title: text(b.metadata?.title), author: text(firstAuthor(b.metadata)),
    sections: b.sections.length, toc: flat(b.toc ?? []),
  })
  return true
}

/** The text a CFI points at in this book's own section document (not the rendered one): verification. */
async function textAt(cfi) {
  const { index, anchor } = view.resolveCFI(cfi)
  const doc = await view.book.sections[index].createDocument()
  return { index, text: anchor(doc)?.toString() ?? '' }
}

/**
 * The host's stored entry for this file (or null). A CFI is used only while the text there is still
 * the saved quote; otherwise that item is reported and left out, never drawn somewhere else.
 */
function restore(json) {
  // Only for the view that answered `opened` and is still the latest open: not a view still opening
  // (a restore meant for an earlier `opened` of the same file), not one a newer openUrl is replacing.
  if (!book || readySeq !== viewSeq || openSeq !== viewSeq) return log('warn', 'restore ignored: no book is ready for it')
  const mine = viewSeq
  // One slot of the navigation chain, taken when called: a host goTo made meanwhile runs after it and wins.
  return navigate(async () => {
    try {
      return await restoreInto(json, () => mine !== viewSeq)
    } finally {
      // Whatever happened, the page saves again: a restore that threw used to silence every save. Not
      // for a view opened since: that one is still restoring.
      if (mine === viewSeq) hostMoving = false
    }
  })
}

/** `stale()`: another view took over during an await; nothing more is done or answered for this one. */
async function restoreInto(json, stale) {
  const stored = json ? entryFor(json, book) : null
  entry = stored ?? emptyEntry(book)
  const result = { found: !!stored, rejected: !!json && !stored, position: 'none', highlights: [] }
  for (const h of entry.highlights) {
    const { index, text } = await textAt(h.cfi).catch(() => ({ text: '' }))
    if (stale()) return result
    // An entry written before selectedText (#1078) kept the whole selection in quote.
    const ok = foldText(text) === foldText(h.selectedText ?? h.quote)
    result.highlights.push({ id: h.id, status: ok ? 'restored' : 'quote mismatch, not drawn' })
    if (ok) annotate({ value: h.cfi, index, hl: { id: h.id } })
  }
  const p = entry.position
  if (p && !isFractionOnly(p) && (format === 'pdf') !== isPdfPage(p)) {
    // The scheme fits the file (v2-sync-protocol.md): a page number only on a PDF, a CFI never on one.
    result.position = 'wrong position kind, stayed at start'
  } else if (p && format === 'pdf') {
    if (p.page > view.book.sections.length) result.position = 'page not found, stayed at start'
    else {
      const arrived = await land(p)
      if (stale()) return result
      result.position = arrived ? 'restored' : 'navigation failed, stayed at start'
    }
  } else if (isFractionOnly(p)) {
    // A transitional server locator (#1187): no CFI and no quote to check, only where in the book.
    // Approximate (the legacy fraction counts words, foliate's bytes). Fraction 0 (never read on the other
    // device) is the text start init already shows: no navigation. The entry keeps the fraction until
    // the reader moves (the save rule).
    const arrived = p.fraction === 0 || (await land(p))
    if (stale()) return result
    result.position = arrived ? 'restored by fraction' : 'navigation failed, stayed at start'
  } else if (p && !textual) {
    // An image page: the stored entry name must still be a page of this book.
    const index = p.page ? view.book.sections.findIndex((s) => String(s.id) === p.page) : -1
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
  // A newer openUrl is on its way (its bytes still hashing): the host is waiting for that book's
  // `restored`, so this answer, for the view still showing, goes to nobody.
  if (openSeq === viewSeq) post({ type: 'restored', ...result })
  return result
}

/**
 * SyncLimits.MaxSelectedText (backend/src/Contracts/V2/SyncLimits.cs), checked in UTF-16 units by
 * SyncValidation.Text: a longer selection could never sync.
 */
const MAX_SELECTED_TEXT = 4000

/** The last non-empty selection as a highlight: CFI + selection (+ its ≤64-code-point quote) + 30 chars of context, saved. */
function highlightSelection() {
  if (!textual) return log('warn', 'highlightSelection ignored: this book has no text')
  // A PDF highlight is a `pdf-page` PdfAnchor (page + rects), not a CFI: not built yet (#1128 S5).
  if (format === 'pdf') return log('warn', 'highlightSelection ignored: PDF highlights are not supported yet')
  const s = lastSelection
  if (!s || s.range.collapsed) return null
  // Before `restored` there is nothing to add to, and saving now would overwrite the stored entry.
  if (!entry) return log('warn', 'highlightSelection ignored: the stored entry is not restored yet')
  const selectedText = s.range.toString()
  // An image-only or whitespace-only selection (a paragraph break) has no text: the server refuses
  // it (SyncValidation.RequiredText), and the page would draw a highlight that can never sync.
  if (!selectedText.trim()) return log('warn', 'highlightSelection ignored: the selection has no text')
  // Refused, not cut: a cut selectedText no longer reads as the text at the CFI, so it would never restore.
  if (selectedText.length > MAX_SELECTED_TEXT) return log('warn', `highlightSelection ignored: over ${MAX_SELECTED_TEXT} characters`)
  const loc = rangeToLocator(s.doc.body, s.range, String(s.index))
  const h = {
    id: uuidV4(), cfi: view.getCFI(s.index, s.range), index: s.index,
    quote: quoteOf(selectedText), selectedText, prefix: loc?.text?.before ?? '', suffix: loc?.text?.after ?? '', color: 'yellow', at: Date.now(),
  }
  entry = withHighlight(entry, h)
  persist()
  annotate({ value: h.cfi, index: s.index, hl: { id: h.id } })
  s.doc.getSelection().removeAllRanges()
  lastSelection = null
  post({ type: 'highlighted', id: h.id, cfi: h.cfi, quote: h.quote, selectedText })
  return h
}

const openFailed = (name, error) => post({ type: 'open-failed', name, error })

/** One `opened` or one `open-failed` per call — unless a newer openUrl took over, and then neither. */
function openFor(bytes, name) {
  // Refused before anything is touched: a PDF picked by mistake, a DRM book or an unknown file leaves
  // the open book reading, reporting and saving, like a failed read (#1168). No seq turnover, no session end.
  let kind
  try { kind = sniffFormat(bytes) } catch (e) { return openFailed(name, String(e?.message ?? e).slice(0, 200)) }
  const mine = ++openSeq
  return open(bytes, name, kind, mine).catch((e) => {
    log('error', `open: ${e?.stack ?? e}`)
    if (mine === openSeq) openFailed(name, String(e?.message ?? e).slice(0, 200))
  })
}

window.__fol = {
  // The retained file, read by the page itself (file:// origin + allowFileAccessFromFileURLs): no book
  // bytes cross the bridge. `open-failed`: unreadable, not a book this page reads, or DRM-protected; the host must not keep it.
  openUrl: (url, name) => {
    // The seq turns over in openFor, once the bytes are in hand: a failed READ leaves the previous
    // book open, and its view must keep reporting and saving as if nothing happened (#1168).
    const x = new XMLHttpRequest()
    x.responseType = 'arraybuffer'
    x.onload = () => ((x.status === 0 || x.status === 200) && x.response
      ? openFor(new Uint8Array(x.response), name)
      : openFailed(name, `cannot read the file (status ${x.status})`))
    x.onerror = () => openFailed(name, 'cannot read the file')
    x.open('GET', url)
    x.send()
  },
  restore: (json) => restore(json)?.catch((e) => log('error', `restore: ${e?.stack ?? e}`)),
  highlightSelection,
  // A position (as stored: CFI, page or fraction-only, #1187), a CFI, an href or a section index. Not
  // `chosen` (the host moving the view: a sync adopt or move) nothing is saved or echoed back, the host
  // already holds that position; a position becomes the entry's own, so a later save (a highlight) does
  // not write the old place back. `chosen` (the reader's own choice: a taken offer) the place it landed
  // on is saved, built as a relocate's save is. Not arrived: nothing changes.
  goTo: (target, chosen = false) => navigate(async () => {
    if (!view?.book) return
    if (target && typeof target === 'object' && !isPosition(target)) return log('warn', 'goTo ignored: not a position')
    const mine = viewSeq
    hostMoving = true
    let arrived = false
    try { arrived = await land(target) } finally { if (mine === viewSeq) hostMoving = !entry }
    if (mine !== viewSeq || !entry) return
    if (!arrived) return log('warn', 'goTo: the target did not land, position kept')
    if (!chosen) {
      if (isPosition(target)) entry = withPosition(entry, target)
      return
    }
    const landed = positionOf(view.lastLocation)
    if (!landed) return log('warn', 'goTo: nothing to save here (no text position)')
    entry = withPosition(entry, landed)
    persist()
  }),
  // The target is read once the previous navigation has landed: two quick taps move two sections.
  section: (delta) => navigate(() => {
    if (!view?.book) return
    const i = (view.lastLocation?.section?.current ?? 0) + delta
    if (i >= 0 && i < view.book.sections.length) return view.goTo(i)
  }),
  next: () => navigate(() => view?.next()),
  prev: () => navigate(() => view?.prev()),
  // The renderer exists only once view.open() has resolved: both are no-ops between openUrl and opened.
  font: (delta) => { fontPx = Math.max(12, Math.min(32, fontPx + delta)); view?.renderer?.setStyles?.(css()); return fontPx },
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
  /** The host answers a `word` with its translation; drawn above that word. Not on an image-only book. */
  // Not on a PDF: foliate's fixed-layout renderer has no overlayer to draw on (#1128 S5).
  showTranslation: (cfi, index, text) => view && textual && format !== 'pdf' && annotate({ value: cfi, index, gloss: text }),
}

post({ type: 'ready' })
