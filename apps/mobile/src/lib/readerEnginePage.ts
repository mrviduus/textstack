// The engine page (ADR-025 Phase 3): runs INSIDE the reader WebView when EXPO_PUBLIC_READER_ENGINE is
// on. It speaks the old page's protocol to RN — the same `window.__textstack*` calls in, the same
// messages out (`progress`, `restored`, `tap`, `chapterEnd`) — so the RN side, `useReaderPersistence`
// and its ADR-019 write gate, does not change. The engine renders and keeps the place; this file only
// translates. Bundled as an IIFE into readerEngineScript.generated.ts (apps/web/scripts/mobile-bundles.mjs).
//
// Not here yet (Phase 3 slices 3–4): selection, word hold, highlights, vocab, the image lightbox.
import type { EngineEvents, Locator } from '../../../../packages/reader-engine/src/api'
import { createEngine } from '../../../../packages/reader-engine/src/engine'
import { locatorToPosition, positionToLocator } from '../../../../packages/reader-engine/src/mappers'

type Page = Window & {
  ReactNativeWebView: { postMessage(s: string): void }
  __textstackRestoreAnchor(json: string, restoreId: number): void
  __textstackRestoreScroll(offsetY: number, restoreId: number): void
  __textstackRestorePercent(fraction: number, restoreId: number): void
  __textstackApplyTypography(css: string, restoreId: number): void
  __tsSetChapterEnd(model: ChapterEndModel | null): void
}

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

/** A move to a content y, as the restore's op: chapter-relative offsets and fractions are the old page's. */
function goToY(y: number, restoreId: number) {
  void engine.goTo({ href, type: 'text/html', locations: { legacyScrollY: Math.max(1, Math.round(y)) } }, { opId: OP + restoreId })
}

page.__textstackRestoreAnchor = (json, restoreId) => {
  const loc = positionToLocator(json)
  // Unreadable: ack where the reader is. Another chapter's: the engine stays put and acks (D1); RN
  // routes to that chapter, which this document cannot do.
  if (!loc) { ack(restoreId); return }
  void engine.goTo(loc, { opId: OP + restoreId })
}

page.__textstackRestoreScroll = (offsetY, restoreId) => goToY(bounds().top + Math.max(0, Math.floor(offsetY) || 0), restoreId)

page.__textstackRestorePercent = (fraction, restoreId) => {
  const b = bounds()
  const f = Math.min(1, Math.max(0, Number(fraction) || 0))
  goToY(b.top + Math.max(0, b.bottom - b.top - innerHeight) * f, restoreId)
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

const chapter = document.getElementById('ts-chapter') as HTMLTemplateElement
void engine.open({ href, layout: 'reflow', html: chapter.innerHTML })
