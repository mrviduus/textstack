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
import { emptyEntry, entryFor, foldText, sha1, sha256, withHighlight, withPosition } from './store.mjs'

const post = (m) => window.ReactNativeWebView?.postMessage(JSON.stringify(m))
const log = (level, msg) => post({ type: 'log', level, msg })
addEventListener('error', (e) => log('error', String(e.error?.stack ?? e.message)))
addEventListener('unhandledrejection', (e) => log('error', String(e.reason?.stack ?? e.reason)))

let view = null
let fontPx = 18
let flow = 'paginated'   // ADR-029 Decision 1
/** value (cfi) → annotation; re-added when a section's overlayer is recreated (chapter navigation). */
const annotations = new Map()
/** This file's identity and its entry. No save until the stored one is restored. */
let book = null
let entry = null
let restoring = false
let lastSelection = null
let saveTimer = 0

// Our reader's own look: generous line-height leaves room above a word for its label.
const css = () => `html, body { font-size: ${fontPx}px !important; line-height: 1.7 !important; }`

const SVG = 'http://www.w3.org/2000/svg'
const GLOSS_COLOR = 'rgba(59, 130, 246, 0.8)'
/**
 * Foliate draw fn: the product's inline translation — saved-word underline + italic label centred
 * above the word (reader-engine LABEL_LOOK, E44). foliate calls it again with fresh rects on every
 * expand (font size, viewport), so the label follows the word without our own layout code.
 */
function gloss(rects, { text, el }) {
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

function sentenceOf(node, start, end) {
  const block = node.parentElement?.closest('p, li, blockquote, td, h1, h2, h3, h4, h5, h6') ?? node.parentElement
  const r = node.ownerDocument.createRange()
  r.setStart(block, 0)
  r.setEnd(node, start)
  const at = r.toString().length
  const text = block.textContent ?? ''
  const from = Math.max(text.lastIndexOf('. ', at), text.lastIndexOf('! ', at), text.lastIndexOf('? ', at)) + 1
  const ends = ['. ', '! ', '? '].map((s) => text.indexOf(s, at + (end - start))).filter((i) => i >= 0)
  return text.slice(from, ends.length ? Math.min(...ends) + 1 : text.length).replace(/\s+/g, ' ').trim()
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
 * one already revoked. Every navigation of ours runs after the previous one; a failure is reported
 * like any page error, never swallowed.
 */
let navigating = Promise.resolve()
const navigate = (fn) => (navigating = navigating.then(fn).catch((e) => log('error', `navigation: ${e?.stack ?? e}`)))

const flat = (items) => items.flatMap((t) => [{ label: t.label?.trim(), href: t.href }, ...flat(t.subitems ?? [])])

/** Saves the entry through the host (debounced for positions: relocate fires on every scroll). */
function persist(delay = 0) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => post({ type: 'store', key: book.sha256, json: JSON.stringify(entry) }), delay)
}

function annotate(a) {
  annotations.set(a.value, a)
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

async function open(bytes, name) {
  book = { sha256: sha256(bytes), size: bytes.length, name }
  entry = null
  restoring = true
  lastSelection = null
  view?.close()
  view?.remove()
  annotations.clear()
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
    for (const a of annotations.values()) if (a.index === index) view.addAnnotation(a)
  })
  view.addEventListener('draw-annotation', ({ detail: { draw, annotation: a, range } }) => {
    if (a.kind === 'hl') return draw(Overlayer.highlight, { color: '#facc15' })
    const el = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer
    draw(gloss, { text: a.text, el })
  })
  view.addEventListener('external-link', (e) => { e.preventDefault(); post({ type: 'openLink', href: e.detail.a.href }) })
  await view.open(await makeEpub(new File([bytes], name, { type: 'application/epub+zip' })))
  // A book's <meta http-equiv="refresh"> navigates its own section frame away; CSP does not cover it.
  view.book.transformTarget?.addEventListener('data', ({ detail }) => {
    if (!/html/.test(detail.type)) return
    detail.data = Promise.resolve(detail.data).then((str) => {
      if (typeof str !== 'string' || !/refresh/i.test(str)) return str
      const doc = new DOMParser().parseFromString(str, detail.type)
      for (const m of doc.querySelectorAll('meta[http-equiv]')) if (/refresh/i.test(m.getAttribute('http-equiv'))) m.remove()
      return new XMLSerializer().serializeToString(doc)
    })
  })
  view.renderer.setAttribute('flow', flow)
  view.renderer.setAttribute('margin', '24px')
  view.renderer.setStyles(css())
  await view.init({ showTextStart: true })
  const { book: b } = view
  post({
    type: 'opened', book,
    // Either may be missing, a string, or a language map ({ en: … }); the host falls back to the file name.
    title: text(b.metadata?.title), author: text(firstAuthor(b.metadata)),
    sections: b.sections.length, toc: flat(b.toc ?? []),
  })
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
  const stored = json ? entryFor(json, book) : null
  entry = stored ?? emptyEntry(book)
  const result = { found: !!stored, rejected: !!json && !stored, position: 'none', highlights: [] }
  for (const h of entry.highlights) {
    const { index, text } = await textAt(h.cfi).catch(() => ({ text: '' }))
    const ok = foldText(text) === foldText(h.quote)
    result.highlights.push({ id: h.id, status: ok ? 'restored' : 'quote mismatch, not drawn' })
    if (ok) annotate({ value: h.cfi, index, kind: 'hl', id: h.id })
  }
  const p = entry.position
  if (p) {
    const { text } = await textAt(p.cfi).catch(() => ({ text: '' }))
    if (text && foldText(text).startsWith(foldText(p.quote))) {
      await navigate(() => view.goTo(p.cfi))
      result.position = 'restored'
    } else result.position = 'quote mismatch, stayed at start'
  }
  restoring = false
  post({ type: 'restored', ...result })
  return result
}

/** The last non-empty selection as a highlight: CFI + quote + 30 chars of context, saved. */
function highlightSelection() {
  const s = lastSelection
  if (!s || s.range.collapsed) return null
  const loc = rangeToLocator(s.doc.body, s.range, String(s.index))
  const h = {
    id: `h${Date.now().toString(36)}`, cfi: view.getCFI(s.index, s.range), index: s.index,
    quote: s.range.toString(), prefix: loc?.text?.before ?? '', suffix: loc?.text?.after ?? '', color: 'yellow', at: Date.now(),
  }
  entry = withHighlight(entry, h)
  persist()
  annotate({ value: h.cfi, index: s.index, kind: 'hl', id: h.id })
  s.doc.getSelection().removeAllRanges()
  lastSelection = null
  post({ type: 'highlighted', id: h.id, cfi: h.cfi, quote: h.quote })
  return h
}

const openFailed = (name, error) => post({ type: 'open-failed', name, error })

window.__fol = {
  // The retained file, read by the page itself (file:// origin + allowFileAccessFromFileURLs): no book
  // bytes cross the bridge. `open-failed`: unreadable, or not an EPUB; the host must not keep it.
  openUrl: (url, name) => {
    const x = new XMLHttpRequest()
    x.responseType = 'arraybuffer'
    x.onload = () => ((x.status === 0 || x.status === 200) && x.response
      ? open(new Uint8Array(x.response), name).catch((e) => {
        log('error', `open: ${e?.stack ?? e}`)
        openFailed(name, String(e?.message ?? e).slice(0, 200))
      })
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
  font: (delta) => { fontPx = Math.max(12, Math.min(32, fontPx + delta)); view?.renderer.setStyles(css()); return fontPx },
  flow: (f) => { flow = f; view?.renderer.setAttribute('flow', f) },
  /** The host answers a `word` with its translation; drawn above that word. */
  showTranslation: (cfi, index, text) => view && annotate({ value: cfi, index, text }),
}

/** For the test-only entry (repro.mjs); the production bundle drops this export. */
export const currentView = () => view

post({ type: 'ready' })
