// The engine page (ADR-025 Phase 3): runs INSIDE the reader WebView.
// It speaks the old page's protocol to RN — the same `window.__textstack*` calls in, the same
// messages out (`progress`, `restored`, `tap`, `chapterEnd`) — so the RN side, `useReaderPersistence`
// and its ADR-019 write gate, does not change. The engine renders and keeps the place; this file only
// translates. Bundled as an IIFE into readerEngineScript.generated.ts (apps/web/scripts/mobile-bundles.mjs).
// Slices 3–4 (PR B): selection, word hold, highlights, vocab, images and links, on the same protocol.
import type { EngineEvents, Locator } from '../../../../packages/reader-engine/src/api'
import { createEngine } from '../../../../packages/reader-engine/src/engine'
import { locatorToPosition, positionToLocator } from '../../../../packages/reader-engine/src/mappers'
import { HIGHLIGHT_BG as HL, VOCAB_STAGE_COLORS as STAGE } from './readerColors'

type Page = Window & {
  ReactNativeWebView: { postMessage(s: string): void }
  __textstackRestoreAnchor(json: string, restoreId: number): void
  __textstackRestoreScroll(offsetY: number, restoreId: number): void
  __textstackRestorePercent(fraction: number, restoreId: number): void
  __textstackApplyTypography(css: string, restoreId: number): void
  __tsSetChapterEnd(model: ChapterEndModel | null): void
  __tsClearSelection(token: number | null, markOnly?: boolean): void
  __textstackScrollToHighlight(anchorJson: string): void
  /** The lightbox, a plain script beside this bundle (readerHtml IMAGE_LIGHTBOX). */
  __tsOpenImage(src: string, alt: string): void
  renderHighlight(id: string, anchorJson: string, color: string, text: string): void
  removeHighlight(id: string): void
  markVocabWords(map: Record<string, Vocab> | null): void
  addVocabWord(word: string, stage: number): void
  setShowInlineTranslations(show: boolean): void
}

interface Vocab { stage: number; translation?: string | null }

/** RN builds it (labels localized, which buttons apply); taps go back as `chapterEnd` actions. */
interface ChapterEndModel {
  title: string
  finished?: boolean
  busy?: boolean
  next?: { label: string; counter?: string }
  prev?: { label: string }
  error?: string
  retry?: string
  discuss?: string
  reviewWords?: string
  library?: string
}

const page = window as unknown as Page
const post = (m: object) => page.ReactNativeWebView.postMessage(JSON.stringify(m))

const root = document.getElementById('ts-root')!
const href = root.dataset.slug ?? ''
const engine = createEngine(root)
const footer = document.createElement('div')
footer.id = 'ts-chapter-end'
footer.className = 'ts-end'
engine.setFooter(footer)
const typography = document.head.appendChild(document.createElement('style'))
typography.id = 'ts-typography'

/** RN's restore ids ride the engine's op ids: the op's ack is the restore's ack. */
const OP = 'restore:'

/** The chapter on the page, without the chapter-end block below it: what progress is measured on. */
function bounds() {
  const r = (root.firstElementChild as HTMLElement).getBoundingClientRect()
  return { top: r.top + scrollY, bottom: r.bottom + scrollY }
}

/** Progress within the chapter and the chapter-relative scrollY, as the old page reported them. */
function place() {
  const b = bounds()
  const rel = Math.max(0, scrollY - b.top)
  const span = b.bottom - b.top - innerHeight
  // A chapter shorter than the screen is finished the moment it is shown.
  return { progress: span > 0 ? Math.min(rel / span, 1) : 1, scrollY: Math.round(rel) }
}

let lastProgress = -1

function report(locator: Locator, force: boolean) {
  // An empty chapter has nothing to read: no progress, or it would bank 100% unread.
  if (!(root.firstElementChild?.textContent ?? '').trim()) return
  const p = place()
  // The reader's own scroll is reported in steps, like before; every op's landing always is.
  if (!force && Math.abs(p.progress - lastProgress) <= 0.005) return
  lastProgress = p.progress
  const json = locatorToPosition(locator)
  post({ type: 'progress', progress: p.progress, chapterSlug: href, scrollY: p.scrollY, position: json ? JSON.parse(json) : null })
}

function ack(restoreId: number) {
  post({ type: 'restored', restoreId, scrollY: place().scrollY })
}

engine.on('relocated', (e: EngineEvents['relocated']) => {
  // The ack first, then the place it landed on (R4: a landing is always reported).
  if (e.opId?.startsWith(OP)) ack(Number(e.opId.slice(OP.length)))
  report(e.locator, e.reason !== 'scroll')
})
engine.on('tap', () => post({ type: 'tap' }))
// Bars follow the old page's own scroll detector (SCROLL_DIR_DETECTOR, loaded beside this): it reveals
// on any upward move and RN resyncs it with __tsSetBars. The engine's `scrollDir` has neither yet.
engine.on('chapterEnd', () => post({ type: 'chapterEnd', action: 'visible' }))
engine.on('error', (e) => post({ type: 'log', level: 'warn', msg: `[engine] ${e.code}: ${e.detail ?? ''}` }))
// A page that breaks is a blank reader: say why in RN's log (the old page's bridge did the same).
addEventListener('error', (e) => post({ type: 'log', level: 'error', msg: `[engine page] ${e.message}` }))
addEventListener('unhandledrejection', (e) => post({ type: 'log', level: 'error', msg: `[engine page] ${String(e.reason)}` }))


page.__textstackRestoreAnchor = (json, restoreId) => {
  const loc = positionToLocator(json)
  // Unreadable: ack where the reader is. Another chapter's: the engine stays put and acks (D1); RN
  // routes to that chapter, which this document cannot do.
  if (!loc) {
    ack(restoreId)
    const here = engine.current()
    if (here) report(here, true)   // R4: a landing is always reported, even one that did not move
    return
  }
  void engine.goTo(loc, { opId: OP + restoreId })
}

// The old page's offsets are chapter-relative: the chapter's top (the page padding) goes back on.
page.__textstackRestoreScroll = (offsetY, restoreId) => {
  const y = Math.round(bounds().top + Math.max(0, Math.floor(offsetY) || 0))
  void engine.goTo({ href, type: 'text/html', locations: { legacyScrollY: Math.max(1, y) } }, { opId: OP + restoreId })
}

// The engine's fraction is the chapter's own, like the old page's: resolved when the move lands.
page.__textstackRestorePercent = (fraction, restoreId) => {
  void engine.goTo({ href, type: 'text/html', locations: { progression: Math.min(1, Math.max(0, Number(fraction) || 0)) } }, { opId: OP + restoreId })
}

page.__textstackApplyTypography = (css, restoreId) => {
  engine.setStyle({}, OP + restoreId)   // reads the place first…
  typography.textContent = css          // …then the text reflows, and the engine puts that place back
}

page.__tsSetChapterEnd = (m) => {
  footer.replaceChildren()
  if (!m) return
  const el = (tag: string, cls: string | null, text?: string) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  const button = (cls: string, text: string, action: string, sub?: string) => {
    const b = el('button', cls, text) as HTMLButtonElement
    b.type = 'button'
    if (sub) b.append(el('small', null, sub))
    b.disabled = !!m.busy
    b.addEventListener('click', (e) => { e.preventDefault(); post({ type: 'chapterEnd', action }) })
    return b
  }
  footer.append(el('hr', null), el('div', `ts-end__title${m.finished ? ' done' : ''}`, m.title))
  if (m.next) footer.append(button('ts-end__next', m.next.label, 'next', m.next.counter))
  if (m.error) footer.append(el('div', 'ts-end__error', m.error), button('ts-end__alt', m.retry ?? '', 'retry'))
  if (m.discuss) footer.append(button('ts-end__alt', m.discuss, 'discuss'))
  if (m.reviewWords) footer.append(button('ts-end__alt', m.reviewWords, 'review'))
  if (m.library) footer.append(button('ts-end__alt', m.library, 'library'))
  if (m.prev) footer.append(button('ts-end__prev', m.prev.label, 'prev'))
}

// Selection (slice 3). RN hands a selection's token back to clear it; a newer selection makes that
// clear stale (SEL-1). Random base: a clear meant for the previous chapter's page never matches.
let token = Math.floor(Math.random() * 1e12)
engine.on('hold', () => post({ type: 'wordEngage' }))   // the haptic, before the word
engine.on('selection', (s) => {
  token++
  if (!s) return post({ type: 'selection', text: '' })
  const q = s.locator.text!
  // mode 'tap' = a held word: RN always opens the WordCard for it. The anchor is the old bridge's shape.
  post({ type: 'selection', mode: s.source === 'hold' ? 'tap' : 'drag', text: s.text, sentence: s.sentence, anchor: { prefix: q.before, exact: q.highlight, suffix: q.after }, tooLong: s.tooLong, token })
})
// markOnly (E47): only the held mark goes, before RN paints the text as a highlight; a failed save keeps the selection.
page.__tsClearSelection = (t, markOnly) => { if (typeof t !== 'number' || t === token) engine.clearSelection({ markOnly: !!markOnly }) }

engine.on('imageTap', (e) => page.__tsOpenImage(e.src, e.alt || ''))
// A footnote stays a link (ADR-025 answer 3): it jumps to its note; a web link opens outside.
// `#n1` or `ch03.xhtml#n1` (EPUBs name their own file, #814): jump when the note is in this chapter, like web.
engine.on('linkClick', ({ href: h, internal }) => {
  if (/^https?:/i.test(h)) return post({ type: 'openLink', href: h })
  if (!internal || !h.includes('#')) return
  let id = h.slice(h.indexOf('#') + 1)
  try { id = decodeURIComponent(id) } catch { /* a malformed % stays as written */ }
  const note = document.getElementById(id)
  if (note && root.contains(note)) note.scrollIntoView()
})

// Highlights (slice 4), drawn by the engine: RN still adds and removes them one at a time.
const highlights = new Map<string, { id: string; locator: Locator; style: string }>()
const drawHighlights = () => engine.decorate('highlight', [...highlights.values()])
/** A stored TextAnchor as a locator in this chapter (mappers' anchorToLocator, without its bytes). */
function quote(json: string, text = ''): Locator | null {
  let a
  try { a = JSON.parse(json) } catch { a = {} }   // not JSON: the highlight's text alone, as the old page did
  const exact = a && a.kind !== 'pdf' && (a.exact || text)
  return exact ? { href, type: 'text/html', locations: { charOffset: a.startOffset }, text: { before: a.prefix, highlight: exact, after: a.suffix } } : null
}
page.renderHighlight = (id, json, color, text) => {
  const locator = quote(json, text)
  if (locator) highlights.set(id, { id, locator, style: HL[color] || HL.yellow })
  drawHighlights()
}
page.removeHighlight = (id) => { highlights.delete(id); drawHighlights() }
engine.on('decorationTap', (e) => { if (e.group === 'highlight') post({ type: 'highlightTap', highlightId: e.id }) })
page.__textstackScrollToHighlight = (json) => {
  const at = quote(json)
  // Only to text that is here: a quote the engine can't find would land at the chapter's top.
  if (at && engine.find(at.text!.highlight!).length) void engine.goTo(at, { align: 'center' })
}

// Saved words: underlined by SRS stage, their translations above them (on by default, as before).
let vocab: Record<string, Vocab> = {}
let glosses = true
const paintWords = () => engine.markWords(
  Object.entries(vocab).map(([word, v]) => ({ word, style: STAGE[v.stage] || STAGE[0], translation: v.translation || undefined })), glosses)
page.markVocabWords = (m) => { vocab = m || {}; paintWords() }
page.addVocabWord = (w, stage) => { const k = w.toLowerCase(); vocab[k] = { stage, translation: vocab[k] && vocab[k].translation }; paintWords() }
page.setShowInlineTranslations = (show) => { glosses = !!show; paintWords() }

const chapter = document.getElementById('ts-chapter') as HTMLTemplateElement
void engine.open({ href, layout: 'reflow', html: chapter.innerHTML })
