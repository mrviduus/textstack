// The V2 reader page (ADR-029), bundled alone by build.mjs into v2ReaderPage.generated.ts and run in
// the reader's WebView. foliate-js parses AND renders a local EPUB; this file adds word tap → host, the
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
import { emptyEntry, entryFor, foldText, sha1, sha256Yielding, withHighlight, withPosition } from './store.mjs'
import { openableHref, sentenceOf } from './tap.mjs'

const post = (m) => window.ReactNativeWebView?.postMessage(JSON.stringify(m))
const log = (level, msg) => post({ type: 'log', level, msg })
addEventListener('error', (e) => log('error', String(e.error?.stack ?? e.message)))
addEventListener('unhandledrejection', (e) => log('error', String(e.reason?.stack ?? e.reason)))

let view = null
let fontPx = 18
let flow = 'paginated'   // ADR-029 Decision 1
/** cfi → what is drawn over it; re-added when a section's overlayer is recreated (chapter navigation). */
const overlays = new Map()
/** This file's identity and its entry. No save until the stored one is restored. */
let book = null
let entry = null
let restoring = false
let lastSelection = null
/** The open that is allowed to finish: a second openUrl makes the first one give up silently. */
let openSeq = 0
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
const navigate = (fn) => (navigating = navigating.then(fn).catch((e) => log('error', `navigation: ${e?.stack ?? e}`)))

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
 * view.js's makeBook for EPUB, plus a SHA-1: foliate's default is crypto.subtle, missing at origin
 * "null", so IDPF-obfuscated fonts would not decode there. An adapter, not a patch.
 */
async function makeEpub(file) {
  configure({ useWebWorkers: false })
  const map = new Map((await new ZipReader(new BlobReader(file)).getEntries()).map((e) => [e.filename, e]))
  return new EPUB({
    loadText: (n) => map.get(n)?.getData(new TextWriter()) ?? null,
    loadBlob: (n, type) => map.get(n)?.getData(new BlobWriter(type)) ?? null,
    getSize: (n) => map.get(n)?.uncompressedSize ?? 0,
    sha1: async (str) => sha1(str),
  }).init()
}

const text = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? String(Object.values(v)[0] ?? '') : '')
const firstAuthor = (m) => { const a = [].concat(m?.author ?? [])[0]; return a?.name ?? a }

async function open(bytes, name, mine) {
  // Nothing of the previous book may land on this one; its entry is gone with the next line.
  saves.cancel()
  book = { sha256: await sha256Yielding(bytes), size: bytes.length, name }
  if (mine !== openSeq) return false
  entry = null
  restoring = true
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
    post({ type: 'relocate', index: d.section?.current, sections: d.section?.total, fraction: d.fraction, toc: d.tocItem?.label ?? null, cfi: d.cfi })
    if (restoring || !entry || !d.range) return
    // The visible range's start: its CFI and the text there, to verify the CFI on restore.
    const quote = d.range.toString().replace(/^\s+/, '').slice(0, 64)
    entry = withPosition(entry, { cfi: d.cfi, quote, index: d.section?.current, fraction: d.fraction, at: Date.now() })
    persist(400)
  })
  view.addEventListener('create-overlay', ({ detail: { index } }) => {
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
  const epub = await makeEpub(new File([bytes], name, { type: 'application/epub+zip' }))
  if (mine !== openSeq) return false
  await view.open(epub)
  // A book's <meta http-equiv="refresh"> navigates its own section frame away; CSP does not cover it.
  // Parsed every time, never pre-matched on the source text: `&#x72;efresh` spells it past a text match.
  view.book.transformTarget?.addEventListener('data', ({ detail }) => {
    if (!/html/.test(detail.type)) return
    detail.data = Promise.resolve(detail.data).then((str) => {
      if (typeof str !== 'string') return str
      const doc = new DOMParser().parseFromString(str, detail.type)
      const refresh = [...doc.querySelectorAll('meta[http-equiv]')].filter((m) => /refresh/i.test(m.getAttribute('http-equiv')))
      if (!refresh.length) return str
      refresh.forEach((m) => m.remove())
      return new XMLSerializer().serializeToString(doc)
    })
  })
  view.renderer.setAttribute('flow', flow)
  view.renderer.setAttribute('margin', '24px')
  view.renderer.setStyles(css())
  await view.init({ showTextStart: true })
  if (mine !== openSeq) return false
  const { book: b } = view
  post({
    type: 'opened', book,
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
async function restore(json) {
  if (!book) return log('warn', 'restore ignored: no book is open')
  try {
    return await restoreInto(json)
  } finally {
    // Whatever happened, the page saves again: a restore that threw used to silence every save.
    restoring = false
  }
}

async function restoreInto(json) {
  const stored = json ? entryFor(json, book) : null
  entry = stored ?? emptyEntry(book)
  const result = { found: !!stored, rejected: !!json && !stored, position: 'none', highlights: [] }
  for (const h of entry.highlights) {
    const { index, text } = await textAt(h.cfi).catch(() => ({ text: '' }))
    const ok = foldText(text) === foldText(h.quote)
    result.highlights.push({ id: h.id, status: ok ? 'restored' : 'quote mismatch, not drawn' })
    if (ok) annotate({ value: h.cfi, index, hl: { id: h.id } })
  }
  const p = entry.position
  if (p) {
    const { index, text } = await textAt(p.cfi).catch(() => ({ text: '' }))
    if (!text || !foldText(text).startsWith(foldText(p.quote))) result.position = 'quote mismatch, stayed at start'
    else {
      await navigate(() => view.goTo(p.cfi))
      // goTo reports nothing when it fails, so the renderer is asked where the book actually is.
      const landed = view.renderer?.getContents?.().some((c) => c.index === index)
      result.position = landed ? 'restored' : 'navigation failed, stayed at start'
    }
  }
  post({ type: 'restored', ...result })
  return result
}

/** The last non-empty selection as a highlight: CFI + quote + 30 chars of context, saved. */
function highlightSelection() {
  const s = lastSelection
  if (!s || s.range.collapsed) return null
  // Before `restored` there is nothing to add to, and saving now would overwrite the stored entry.
  if (!entry) return log('warn', 'highlightSelection ignored: the stored entry is not restored yet')
  const loc = rangeToLocator(s.doc.body, s.range, String(s.index))
  const h = {
    id: `h${Date.now().toString(36)}`, cfi: view.getCFI(s.index, s.range), index: s.index,
    quote: s.range.toString(), prefix: loc?.text?.before ?? '', suffix: loc?.text?.after ?? '', color: 'yellow', at: Date.now(),
  }
  entry = withHighlight(entry, h)
  persist()
  annotate({ value: h.cfi, index: s.index, hl: { id: h.id } })
  s.doc.getSelection().removeAllRanges()
  lastSelection = null
  post({ type: 'highlighted', id: h.id, cfi: h.cfi, quote: h.quote })
  return h
}

const openFailed = (name, error) => post({ type: 'open-failed', name, error })

/** One `opened` or one `open-failed` per call — unless a newer openUrl took over, and then neither. */
function openFor(bytes, name) {
  const mine = ++openSeq
  return open(bytes, name, mine).catch((e) => {
    log('error', `open: ${e?.stack ?? e}`)
    if (mine === openSeq) openFailed(name, String(e?.message ?? e).slice(0, 200))
  })
}

window.__fol = {
  // The retained file, read by the page itself (file:// origin + allowFileAccessFromFileURLs): no book
  // bytes cross the bridge. `open-failed`: unreadable, or not an EPUB; the host must not keep it.
  openUrl: (url, name) => {
    const x = new XMLHttpRequest()
    x.responseType = 'arraybuffer'
    x.onload = () => ((x.status === 0 || x.status === 200) && x.response
      ? openFor(new Uint8Array(x.response), name)
      : openFailed(name, `cannot read the file (status ${x.status})`))
    x.onerror = () => openFailed(name, 'cannot read the file')
    x.open('GET', url)
    x.send()
  },
  restore: (json) => restore(json).catch((e) => log('error', `restore: ${e?.stack ?? e}`)),
  highlightSelection,
  goTo: (target) => navigate(() => view?.goTo(target)),
  // The target is read once the previous navigation has landed: two quick taps move two sections.
  section: (delta) => navigate(() => {
    if (!view?.book) return
    const i = (view.lastLocation?.section?.current ?? 0) + delta
    if (i >= 0 && i < view.book.sections.length) return view.goTo(i)
  }),
  next: () => navigate(() => view?.next()),
  prev: () => navigate(() => view?.prev()),
  // The renderer exists only once view.open() has resolved: both are no-ops between openUrl and opened.
  font: (delta) => { fontPx = Math.max(12, Math.min(32, fontPx + delta)); view?.renderer?.setStyles(css()); return fontPx },
  flow: (f) => { flow = f; view?.renderer?.setAttribute('flow', f) },
  /** The host answers a `word` with its translation; drawn above that word. */
  showTranslation: (cfi, index, text) => view && annotate({ value: cfi, index, gloss: text }),
}

post({ type: 'ready' })
