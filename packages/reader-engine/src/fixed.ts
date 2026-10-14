// Fixed layout (PDF, ADR-012) behind the engine API (ADR-025, Phase 5): the port of the mobile viewer
// (apps/web/scripts/pdfViewer/entry.ts). The host brings pdf.js — `createEngine(root, { fixed:
// fixedLayout(pdfjs) })` — so the engine never imports it (the mobile bundle's 64 KB budget).
//
// - A column of page boxes, each its own shape, fit to the width. Only pages near the screen have a canvas
//   (the shared rings): a long PDF cannot keep every page in memory.
// - The place is a page (`locations.position`). A jump lands once the sizes of every page above its
//   target are known (they stream in), or after a deadline; a newer op or the reader's own gesture ends it.
// - Every open / goTo / setStyle emits exactly one `relocated` with its opId; 'scroll' is the reader
//   reaching another page, never the engine's own scroll.
// - Bytes come from the host: `data`, or `read(begin, end)` behind pdf.js's range transport.
// - Zoom = fit × `Style.zoom`. Each drawn page has pdf.js's text layer; a selection on it is a page and
//   rects (today's `PdfAnchor`). Decorations are painted from those rects, over the text; taps on them
//   are found by geometry, so a selection can start through them.
import type { ChapterDoc, EngineOptions, GoToResult, Locator, Reason, ReaderEngine, Rect } from './api'
import { emitter, seams, DOUBLE_TAP_MS, HOLD_MS, HOLD_SLOP_PX, SCROLL_DOWN_PX, SCROLL_UP_PX, SELECTION_MAX_CHARS, SELECTION_SETTLE_MS, sentenceAround } from './engine'
import { capturePageAnchor, clampPage, computePageRings, dimsReadyUpTo, readingPage, scrollDeltaForAnchor, type PageRect } from '../../shared/src/reader/pdfPageWindow'
import { buildPdfAnchor, paintRect, type PdfRect } from '../../shared/src/reader/pdfHighlightAnchor'
import { tokenizeVocabWords } from '../../shared/src/text/vocabKey'

/** The part of pdf.js the fixed layout uses. The host passes the real module; tests a fake. */
export interface PdfJs {
  /** Called with `{ data: Uint8Array }` or `{ range: PdfRangeTransport }`; typed `never` so the real module fits. */
  getDocument(src: never): { promise: Promise<PdfDoc>; destroy(): Promise<void> }
  PDFDataRangeTransport: new (length: number, initialData: Uint8Array | null) => PdfRangeTransport
  /** Called with `{ textContentSource, container, viewport }`; typed `never` so the real module fits. */
  TextLayer: new (o: never) => { render(): Promise<void>; cancel(): void }
}
export interface PdfRangeTransport {
  requestDataRange(begin: number, end: number): void
  onDataRange(begin: number, chunk: Uint8Array | null): void
}
export interface PdfDoc {
  numPages: number
  getPage(n: number): Promise<PdfPage>
}
export interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number }
  streamTextContent(): unknown
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number }; transform?: number[] }): { promise: Promise<void>; cancel(): void }
}

interface Dim { w: number; h: number }
interface Slot {
  el: HTMLElement
  canvas: HTMLCanvasElement | null
  text: HTMLElement | null                  // pdf.js's text layer, drawn with the canvas
  marks: HTMLElement | null                 // decorations, painted from rects
  drawn: number | null
  drawing: number | null
  gen: number                               // bumped by every free: a draw from before it bails
  task: { cancel(): void } | null
}
type Group = 'highlight' | 'search'
type Item = Parameters<ReaderEngine['decorate']>[1][number]
/** A selection the host has: its page and rects, and how it was made. */
interface Sent { page: number; rects: PdfRect[]; text: string; source: 'hold' | 'drag' }
interface Op { page: number; reason: Reason; opId?: string; result: GoToResult; done: (r: GoToResult) => void }

const FALLBACK: Dim = { w: 612, h: 792 }   // US Letter at 72 dpi, until page 1's size is known
const PAD = 24
/** A jump never waits longer than this for the sizes above its target (a slow stream, a read that never returns). */
const JUMP_DEADLINE_MS = 8000
/** No reader scroll for this long (and no finger down) = the scroll, fling included, is over. */
const SCROLL_IDLE_MS = 150
/** Pages this close to the screen count as visible: drawn before they arrive. */
const RENDER_MARGIN_PX = 300
/** Keys that scroll the page: only they end a travelling jump (not Escape, not a modifier). */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', ' ', 'Spacebar', 'Home', 'End'])

/** A key the reader scrolls the page with (E36): a scroll key, not typed into a field. Hosts use it too. */
export function isReaderScrollKey(e: KeyboardEvent): boolean {
  const typing = (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  return SCROLL_KEYS.has(e.key) && !typing
}
const MIN_SCALE = 0.2
const MAX_SCALE = 5
const COLORS = {
  highlight: 'var(--reader-highlight, rgba(254, 240, 138, 0.5))',
  search: 'var(--reader-search, rgba(250, 204, 21, 0.35))',
  selection: 'var(--reader-selection, rgba(196, 112, 75, 0.35))',
}
/** pdf.js's text layer needs these (its own `pdf_viewer.css`, cut to what a page uses); the marks sit above it. */
const CSS = `.pdf-page .textLayer{position:absolute;inset:0;overflow:clip;opacity:1;line-height:1;text-align:initial;-webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;z-index:1}
.pdf-page .textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
.pdf-page .textLayer span.markedContent{top:0;height:0}
.pdf-page .textLayer ::selection{background:var(--reader-pdf-selection,rgba(37,99,235,.3))}
.pdf-page .textLayer br::selection{background:transparent}
.pdf-marks{position:absolute;inset:0;z-index:2;pointer-events:none}
.pdf-marks>div{position:absolute;pointer-events:none;border-radius:2px;mix-blend-mode:multiply}`

/** The fixed layout with the host's pdf.js, for `createEngine(root, { fixed })`. */
export function fixedLayout(pdfjs: PdfJs): (root: HTMLElement, opts: EngineOptions) => ReaderEngine {
  return (root, opts) => createFixed(root, opts, pdfjs)
}

function createFixed(root: HTMLElement, opts: EngineOptions, pdfjs: PdfJs): ReaderEngine {
  const { doc, win, page, scroller, measure, viewport, schedule, observeResize, caretAt } = seams(root, opts)

  if (!doc.getElementById('ts-pdf-css')) {
    const css = doc.createElement('style')
    css.id = 'ts-pdf-css'
    css.textContent = CSS
    doc.head.append(css)
  }

  const column = doc.createElement('div')
  column.className = 'pdf-pages'
  // Pages centre by their auto margins, not `align-items`: a page wider than the screen (zoom) then
  // overflows to the right and scrolls sideways, instead of being cut off on the left (E38).
  Object.assign(column.style, { display: 'flex', flexDirection: 'column' })
  root.replaceChildren(column)
  // The engine alone keeps the place when page sizes change (E37): the browser's scroll anchoring
  // would be a second hand on the scroll.
  const anchorWas = scroller.style.overflowAnchor
  scroller.style.overflowAnchor = 'none'

  let alive = true
  let docSeq = 0
  let task: { destroy(): Promise<void> } | null = null
  let pdf: PdfDoc | null = null
  let numPages = 0
  let scale = 1
  let zoom = 1
  let insetTop = 0                        // the host's bars over the top of the screen (E42)
  const decorations: Record<Group, Item[]> = { highlight: [], search: [] }
  let held: { page: number; rects: PdfRect[] } | null = null   // the held word, marked until clearSelection
  let sent: Sent | null = null                                 // the selection the host has
  let selTimer = 0
  let holdTimer = 0
  let down: { x: number; y: number } | null = null
  let swallowClick = false
  let lastTap = -Infinity
  let dir: 'up' | 'down' | null = null
  let dirBase = 0
  let dims: (Dim | undefined)[] = []
  let slots: Slot[] = []
  let op: Op | null = null
  let last = 1                            // the page last reported
  let ownTop: number | null = null        // the scrollTop we set; its scroll event is not reading
  let readerMoved = false
  let scrollQueued = false
  let touchDown = false
  let lastScrollAt = 0
  let deferred: number | null = null      // a size change waiting for the reader's scroll to stop
  let deferTimer = 0
  let deadline = 0
  let failed = new Set<string>()          // error codes sent for this document
  let failLoad: ((e: unknown) => void) | null = null
  const { emit, on, clear } = emitter()

  const at = (n: number): Locator => ({ type: 'application/pdf', locations: { position: n } })
  const here = () => op?.page ?? last

  /** Fit to the width, times the reader's zoom. */
  const fit = () => Math.min(MAX_SCALE, Math.max(MIN_SCALE, (((root.clientWidth || 360) - PAD) / (dims[0] ?? FALLBACK).w) * zoom))

  function box(n: number): Dim {
    const d = dims[n - 1] ?? dims[0] ?? FALLBACK
    return { w: Math.round(d.w * scale), h: Math.round(d.h * scale) }
  }

  /** Every page's extent, relative to the top of the screen. */
  function rects(): PageRect[] {
    // ponytail: O(pages) reads per call; binary-search the column if a huge PDF shows in a scroll profile.
    const top = scroller.scrollTop
    return slots.map((s, i) => {
      const m = measure(s.el)
      return { page: i + 1, top: m.top - top, bottom: m.top - top + m.height }
    })
  }

  function scrollTo(y: number) {
    scroller.scrollTop = Math.max(0, y)
    dirBase = ownTop = scroller.scrollTop
  }

  function scrollToPage(n: number) {
    const s = slots[n - 1]
    if (s) scrollTo(measure(s.el).top - insetTop)   // E42: below the host's bars
  }

  /** The page being read: the one filling most of the screen (QA-007 #3), the last one at the very end. */
  function reading(): number {
    const vh = viewport().height
    return readingPage(rects(), 0, vh, scroller.scrollTop + vh >= scroller.scrollHeight - 2) ?? last
  }

  const readerScrolling = () => touchDown || Date.now() - lastScrollAt < SCROLL_IDLE_MS

  /**
   * Every change to the column's sizes — a measured page, a re-fit, a zoom — goes through here and keeps
   * the reader where they are: a travelling jump stays aimed at its target, else the page under the top
   * line at the same fraction (the shared zoom anchor; at the very top the reader stays at the top).
   * Not while the reader scrolls: a scroll from code stops a fling. The change waits (newest wins);
   * `now`: a zoom, the reader's own command.
   */
  function applySizes(next = deferred ?? scale, now = false) {
    if (!now && !op && readerScrolling()) {
      deferred = next
      if (!deferTimer) deferTimer = win.setTimeout(applyDeferred, SCROLL_IDLE_MS)
      return
    }
    deferred = null
    const keep = op || scroller.scrollTop < 1 ? null : capturePageAnchor(rects(), 0)
    const rescaled = next !== scale
    if (rescaled) slots.forEach(free)   // drawn at the old scale
    scale = next
    slots.forEach((s, i) => {
      const b = box(i + 1)
      s.el.style.width = `${b.w}px`
      s.el.style.height = `${b.h}px`
    })
    if (op) scrollToPage(op.page)
    else if (keep) {
      const d = scrollDeltaForAnchor(keep, rects(), 0)
      // Only when something above moved: a no-op scroll would still stop a fling.
      if (d !== null && Math.abs(d) >= 1) scrollTo(scroller.scrollTop + d)
    }
    if (rescaled) paint()
    sync()
  }

  function applyDeferred() {
    deferTimer = 0
    if (deferred !== null) applySizes(deferred)   // waits again if the reader is still scrolling
  }

  function free(s: Slot) {
    s.task?.cancel()
    s.task = null
    s.text?.remove()
    s.text = null
    if (s.canvas) {
      s.canvas.width = s.canvas.height = 0   // gives the bitmap back now, not at the next GC
      s.canvas.remove()
      s.canvas = null
    }
    s.drawn = s.drawing = null
    s.gen++
  }

  async function draw(n: number, s: Slot) {
    const sc = scale
    if (s.drawn === sc || s.drawing === sc) return
    free(s)
    s.drawing = sc
    const gen = s.gen
    try {
      const p = await pdf!.getPage(n)
      if (s.gen !== gen) return
      const vp = p.getViewport({ scale: sc })
      const dpr = win.devicePixelRatio || 1
      const canvas = doc.createElement('canvas')
      canvas.className = 'pdf-page__canvas'
      canvas.width = Math.floor(vp.width * dpr)
      canvas.height = Math.floor(vp.height * dpr)
      Object.assign(canvas.style, { display: 'block', width: `${Math.floor(vp.width)}px`, height: `${Math.floor(vp.height)}px` })
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        s.drawing = null   // the next sync tries again
        return emit('error', { code: 'render', detail: `page ${n}: no 2d canvas context` })
      }
      s.el.append(canvas)
      s.canvas = canvas
      const t = p.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
      s.task = t
      await t.promise
      if (s.gen !== gen) return
      const text = doc.createElement('div')
      text.className = 'textLayer'
      text.style.setProperty('--scale-factor', String(sc))
      s.el.append(text)
      s.text = text
      const layer = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: text, viewport: vp } as never)
      s.task = layer
      await layer.render()
      if (s.gen !== gen) return
      s.task = null
      s.drawing = null
      s.drawn = sc
    } catch (e) {
      // A cancelled render is scroll churn, not an error.
      if (!/Cancel|Abort/i.test((e as { name?: string })?.name ?? '')) emit('error', { code: 'render', detail: `page ${n}: ${(e as Error)?.message}` })
    }
  }

  /** Root-relative boxes as one box on screen, from page-relative rects at the live scale. */
  function onScreen(page: number, rs: PdfRect[]): Rect {
    const p = slots[page - 1]?.el.getBoundingClientRect()
    const boxes = rs.map((r) => paintRect(r, scale))
    if (!p || !boxes.length) return { x: 0, y: 0, width: 0, height: 0 }
    const left = Math.min(...boxes.map((b) => b.left))
    const top = Math.min(...boxes.map((b) => b.top))
    return { x: p.left + left, y: p.top + top, width: Math.max(...boxes.map((b) => b.left + b.width)) - left, height: Math.max(...boxes.map((b) => b.top + b.height)) - top }
  }

  /** Every decoration on its page from its rects, at the live scale: search, then highlights, then the held word. */
  function paint() {
    for (const s of slots) { s.marks?.remove(); s.marks = null }
    const add = (group: Group | 'selection', id: string, page: number | undefined, rs: PdfRect[] | undefined, style?: string) => {
      const s = page ? slots[page - 1] : undefined
      if (!s || !rs?.length) return
      if (!s.marks) {
        s.marks = doc.createElement('div')
        s.marks.className = 'pdf-marks'
        s.marks.style.pointerEvents = 'none'   // a selection starts through a highlight; taps are found by geometry
        s.el.append(s.marks)
      }
      const mark = (box: { left: number; top: number; width: number; height: number }) => {
        const el = doc.createElement('div')
        el.dataset.group = group
        el.dataset.id = id
        Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` })
        s.marks!.append(el)
        return el
      }
      if (style === 'dot') {
        // E31 on a page: a dot just after the last rect, no fill.
        const last = paintRect(rs[rs.length - 1], scale)
        const d = Math.max(5, Math.min(8, last.height * 0.3))
        const el = mark({ left: last.left + last.width + 1, top: last.top, width: d, height: d })
        el.dataset.dot = 'true'
        Object.assign(el.style, { borderRadius: '50%', background: 'var(--reader-reviewed-dot, #16a34a)', mixBlendMode: 'normal' })
        return
      }
      for (const r of rs) mark(paintRect(r, scale)).style.background = style ?? COLORS[group]
    }
    for (const group of ['search', 'highlight'] as const) {
      for (const d of decorations[group]) add(group, d.id, d.locator.locations.position, d.locator.ext?.rects, d.style)
    }
    if (held) add('selection', 'selection', held.page, held.rects)
  }

  /** The page a DOM node is on, if it is in this column. */
  function pageOf(node: Node | null): HTMLElement | null {
    const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)
    const p = el?.closest<HTMLElement>('[data-page]')
    return p && column.contains(p) ? p : null
  }

  /**
   * A range on a page's text as a `selection` (E40): its page and its rects, page-relative at scale 1
   * (`buildPdfAnchor`: a selection onto the next page keeps the start page's part). Null: not on a page.
   */
  function select(range: Range, source: 'hold' | 'drag') {
    const pageEl = pageOf(range.startContainer)
    const textEl = pageEl && slots[Number(pageEl.dataset.page) - 1]?.text
    if (!pageEl || !textEl) return
    const n = Number(pageEl.dataset.page)
    // A drag onto the next page keeps the start page's part (E40): its text, like its rects.
    if (!textEl.contains(range.endContainer)) {
      range = range.cloneRange()
      range.setEnd(textEl, textEl.childNodes.length)
    }
    const raw = range.toString()
    const exact = raw.trim()
    const anchor = buildPdfAnchor(n, pageEl.getBoundingClientRect(), Array.from(range.getClientRects()), scale, exact)
    if (!exact || !anchor.rects.length) return
    // The same text again (iOS re-fires): the host has it.
    if (sent && sent.page === n && sent.text === exact && JSON.stringify(sent.rects) === JSON.stringify(anchor.rects)) return
    sent = { page: n, rects: anchor.rects, text: exact, source }
    held = source === 'hold' ? { page: n, rects: anchor.rects } : null
    paint()
    // Where it starts in the page's text: the same words may stand on another line.
    const before = doc.createRange()
    before.setStart(textEl, 0)
    before.setEnd(range.startContainer, range.startOffset)
    const all = textEl.textContent ?? ''
    const at = before.toString().length + raw.length - raw.trimStart().length
    emit('selection', {
      locator: { type: 'application/pdf', locations: { position: n }, text: { highlight: exact }, ext: { rects: anchor.rects } },
      text: exact,
      sentence: sentenceAround(all, 0, all.length, at, at + exact.length),
      source,
      tooLong: exact.length > SELECTION_MAX_CHARS,
      rect: onScreen(n, anchor.rects),
    })
  }

  function unselect() {
    if (!sent) return
    sent = held = null
    paint()
    emit('selection', null)
  }

  function onSelectionChange() {
    win.clearTimeout(selTimer)
    selTimer = win.setTimeout(() => {
      if (!numPages) return
      const sel = doc.getSelection()
      const r = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null
      if (r && pageOf(r.startContainer)) return select(r, 'drag')
      // A hold never makes a page selection: a collapse after one is the platform's noise.
      if (sent?.source === 'drag') unselect()
    }, SELECTION_SETTLE_MS)
  }

  /** The word under a point on screen as a range in its text node; null off the text or on no letter. */
  function wordAt(x: number, y: number): Range | null {
    const c = caretAt(x, y)
    if (!c || c.node.nodeType !== Node.TEXT_NODE || !pageOf(c.node)) return null
    const data = (c.node as Text).data
    const w = tokenizeVocabWords(data.replace(/\u00AD/g, 'a')).find((t) => t.start <= c.offset && c.offset <= t.end)
    if (!w || !/\p{L}/u.test(w.word)) return null
    const r = doc.createRange()
    r.setStart(c.node, w.start)
    r.setEnd(c.node, w.end)
    return r
  }

  function cancelHold() {
    win.clearTimeout(holdTimer)
    down = null
  }

  function onPointerDown(e: PointerEvent) {
    cancelHold()
    swallowClick = false
    if (e.pointerType === 'mouse' || !(e.target as Element).closest?.('.textLayer')) return   // a mouse drags to select
    const at = { x: e.clientX, y: e.clientY }
    down = at
    holdTimer = win.setTimeout(() => {
      down = null
      const word = wordAt(at.x, at.y)
      if (!word) return
      swallowClick = true
      emit('hold', at)   // first: the host's haptic
      // Drawn, never put in the page's selection: Android would open its own menu over the host's.
      select(word, 'hold')
    }, HOLD_MS)
  }

  function onPointerMove(e: PointerEvent) {
    if (down && (Math.abs(e.clientX - down.x) > HOLD_SLOP_PX || Math.abs(e.clientY - down.y) > HOLD_SLOP_PX)) cancelHold()
  }

  /** One event per tap: a painted highlight or search hit (highlights on top, found by geometry), else a tap. */
  function onClick(e: MouseEvent) {
    if (swallowClick) { swallowClick = false; return }
    if (doc.getSelection()?.isCollapsed === false) return   // the end of a drag selection
    const now = win.performance.now()
    const quick = now - lastTap < DOUBLE_TAP_MS
    lastTap = now
    if (quick) return
    for (const group of ['highlight', 'search'] as const) {
      const items = decorations[group]
      for (let i = items.length - 1; i >= 0; i--) {
        const { id, locator } = items[i]
        const n = locator.locations.position
        const p = n ? slots[n - 1]?.el.getBoundingClientRect() : undefined
        const rs = locator.ext?.rects ?? []
        if (!p || !n) continue
        const hit = rs.some((r) => {
          const b = paintRect(r, scale)
          const x = e.clientX - p.left
          const y = e.clientY - p.top
          return x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height
        })
        if (hit) return emit('decorationTap', { group, id, rect: onScreen(n, rs) })
      }
    }
    emit('tap', { x: e.clientX, y: e.clientY })
  }

  /** Canvases for the pages near the screen, none past the keep ring. */
  function sync() {
    if (!numPages) return
    const vh = viewport().height
    const visible = rects().filter((r) => r.bottom > -RENDER_MARGIN_PX && r.top < vh + RENDER_MARGIN_PX).map((r) => r.page)
    const rings = computePageRings(visible, numPages)
    slots.forEach((s, i) => { if (!rings.keep.has(i + 1) && (s.canvas || s.drawing !== null)) free(s) })
    rings.render.forEach((n) => { void draw(n, slots[n - 1]) })
  }

  /** The op ends: on its page (`arrived`), or where the reader is (their gesture, a failed load). One ack. */
  function land(arrived: boolean) {
    const o = op
    if (!o) return
    win.clearTimeout(deadline)
    op = null
    if (arrived) scrollToPage(o.page)
    last = arrived || !numPages ? o.page : reading()
    sync()
    emit('relocated', { locator: at(last), reason: o.reason, opId: o.opId })
    o.done(arrived ? o.result : 'superseded')
  }

  function settleIfReady() {
    if (op && numPages && dimsReadyUpTo(dims, op.page)) {
      applySizes()
      land(true)
    }
  }

  /** Starts a jump; one still travelling is superseded (acked with the new target). */
  function begin(n: number | undefined, reason: Reason, opId?: string): Promise<GoToResult> {
    const prev = op
    const p = new Promise<GoToResult>((done) => {
      op = { page: n === undefined ? 1 : clampPage(n, numPages), reason, opId, result: n === undefined ? 'start' : 'exact', done }
    })
    if (prev) {
      emit('relocated', { locator: at(op!.page), reason: prev.reason, opId: prev.opId })
      prev.done('superseded')
    }
    if (numPages) travel()
    return p
  }

  function travel() {
    win.clearTimeout(deadline)
    // Sizes that arrive after the deadline keep the landed page under the top (applySizes).
    deadline = win.setTimeout(() => { applySizes(); land(true) }, JUMP_DEADLINE_MS)
    scrollToPage(op!.page)
    settleIfReady()
  }

  function fail(e: unknown) {
    const code = (e as { code?: string })?.code === 'pdf-auth' ? 'pdf-auth' : 'pdf-load'
    if (!failed.has(code)) {
      failed.add(code)
      emit('error', { code, detail: (e as { message?: string })?.message ?? code })
    }
    failLoad?.(e)
  }

  /** pdf.js asks for byte ranges; the host reads them. */
  function transport(src: { length: number; read(begin: number, end: number): Promise<Uint8Array> }, mine: number) {
    const t = new pdfjs.PDFDataRangeTransport(src.length, null)
    t.requestDataRange = (begin, end) => {
      src.read(begin, end).then(
        (chunk) => { if (mine === docSeq) t.onDataRange(begin, chunk) },
        (e) => { if (mine === docSeq) fail(e) },
      )
    }
    return t
  }

  function close() {
    win.clearTimeout(deadline)
    win.clearTimeout(deferTimer)
    deferTimer = 0
    deferred = null
    slots.forEach(free)
    slots = []
    column.replaceChildren()
    dims = []
    numPages = 0
    pdf = null
    failed = new Set()
    failLoad = null
    cancelHold()
    win.clearTimeout(selTimer)
    sent = held = null
    last = 1
    dir = null
    lastTap = -Infinity
    ownTop = null
    void task?.destroy()
    task = null
  }

  async function load(d: ChapterDoc, opId: string | undefined, mine: number) {
    const src = d.pdf!
    // A copy: pdf.js hands `data` to its worker, and the host's buffer would be emptied.
    const loading = pdfjs.getDocument(('data' in src ? { data: new Uint8Array(src.data.slice(0)) } : { range: transport(src, mine) }) as never)
    task = loading
    let loaded: PdfDoc
    try {
      // A failed read never rejects pdf.js's promise (it waits for the bytes): `fail` does.
      const failure = new Promise<never>((_, reject) => { failLoad = reject })
      loaded = await Promise.race([loading.promise, failure])
      // Page 1's size first: the boxes and the first draws are then at the real fit, not the estimate.
      const first = (await Promise.race([loaded.getPage(1), failure])).getViewport({ scale: 1 })
      dims[0] = { w: first.width, h: first.height }
    } catch (e) {
      if (mine !== docSeq) return
      fail(e)
      void loading.destroy()
      task = null
      land(false)
      return
    }
    if (mine !== docSeq) return
    failLoad = null
    pdf = loaded
    numPages = loaded.numPages
    scale = fit()
    for (let n = 1; n <= numPages; n++) {
      const el = doc.createElement('div')
      el.className = 'pdf-page'
      el.dataset.page = String(n)
      Object.assign(el.style, { position: 'relative', margin: '6px auto', overflow: 'hidden', background: '#fff' })
      slots.push({ el, canvas: null, text: null, marks: null, drawn: null, drawing: null, gen: 0, task: null })
    }
    column.append(...slots.map((s) => s.el))
    applySizes(scale)
    paint()
    emit('ready', { opId: opId ?? '', href: d.href, pageCount: numPages })   // even when a goTo overtook the open
    if (op) {
      op.page = clampPage(op.page, numPages)
      travel()
    }
    // Sizes, in page order: a jump lands once every page above its target is measured.
    for (let n = 1; n <= numPages; n++) {
      try {
        const v = (await loaded.getPage(n)).getViewport({ scale: 1 })
        if (mine !== docSeq) return
        dims[n - 1] = { w: v.width, h: v.height }
        if (n === 1) applySizes(fit())   // the fit for this document
        else if (n % 10 === 0) applySizes()
      } catch {
        if (mine !== docSeq) return
        // Kept at the estimate it is drawn at, and recorded: a jump past it can still land.
        dims[n - 1] = dims[0] ?? FALLBACK
      }
      settleIfReady()
    }
    applySizes()
  }

  function onScroll() {
    if (scroller.scrollTop !== ownTop) {
      ownTop = null
      lastScrollAt = Date.now()
      readerMoved = true
      const d = scroller.scrollTop - dirBase
      const next = d >= SCROLL_DOWN_PX ? 'down' : d <= -SCROLL_UP_PX ? 'up' : null
      if (next) {
        dirBase = scroller.scrollTop
        if (next !== dir) emit('scrollDir', (dir = next))
      }
    }
    if (scrollQueued) return
    scrollQueued = true
    schedule(() => {
      scrollQueued = false
      if (!alive || !numPages) return
      sync()
      const moved = readerMoved
      readerMoved = false
      if (!moved || op) return
      const n = reading()
      if (n === last) return
      last = n
      emit('relocated', { locator: at(n), reason: 'scroll' })
    })
  }

  // The reader's own gesture ends a travelling jump where they are; a late landing must not snap them
  // back. Input events, not `scroll`: sizes streaming in move the scroll with no reader.
  const onGesture = (e: Event) => {
    if (op && numPages && (!(e instanceof KeyboardEvent) || isReaderScrollKey(e))) land(false)
  }
  const onTouchStart = () => { touchDown = true }
  const onTouchEnd = () => { touchDown = false; lastScrollAt = Date.now() }

  function onResize() {
    if (!numPages) return
    const next = fit()
    if (Math.abs(next - scale) >= 0.001) applySizes(next)
  }

  const scrollSource: EventTarget = scroller === page ? doc : scroller
  scrollSource.addEventListener('scroll', onScroll, { passive: true })
  const GESTURES = ['touchmove', 'wheel', 'keydown']
  for (const t of GESTURES) win.addEventListener(t, onGesture, { passive: true })
  win.addEventListener('touchstart', onTouchStart, { passive: true })
  for (const t of ['touchend', 'touchcancel']) win.addEventListener(t, onTouchEnd, { passive: true })
  const unobserve = observeResize(root, onResize)
  root.addEventListener('click', onClick)
  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('pointermove', onPointerMove)
  root.addEventListener('pointerup', cancelHold)
  root.addEventListener('pointercancel', cancelHold)
  doc.addEventListener('selectionchange', onSelectionChange)

  return {
    async open(d, loc, opId) {
      if (d.layout !== 'fixed' || !d.pdf) throw new Error('reader-engine: this engine was made with `fixed`: it opens PDFs, not reflow chapters')
      const mine = ++docSeq
      close()
      const ack = begin(loc?.locations.position, 'open', opId)
      void load(d, opId, mine)
      return ack
    },

    async goTo(loc, o) {
      if (loc.locations.position === undefined) {
        emit('error', { code: 'anchor-miss', detail: 'a PDF place is a page: the locator has no position' })
        emit('relocated', { locator: at(here()), reason: 'goTo', opId: o?.opId })
        return 'superseded'
      }
      if (!numPages && !task) {
        // Nothing open and nothing opening (before an open, after a failed one): it cannot land.
        emit('relocated', { locator: at(here()), reason: 'goTo', opId: o?.opId })
        return 'superseded'
      }
      return begin(loc.locations.position, 'goTo', o?.opId)
    },

    // E38: zoom is the only style a PDF has (its colours are the scan's).
    setStyle(s, opId) {
      if (s.insets) insetTop = Math.max(0, s.insets.top)   // for the next landing; the reader is not moved
      if (s.zoom !== undefined) {
        zoom = s.zoom === 'fit' ? 1 : s.zoom
        if (numPages) applySizes(fit(), true)
      }
      schedule(() => {
        if (!alive) return
        if (!op && numPages) last = reading()   // the page read after the zoom
        emit('relocated', { locator: at(here()), reason: 'style', opId })
      })
    },

    current: () => (numPages || op ? at(here()) : null),

    decorate(group, items) {
      decorations[group] = items
      paint()
    },

    clearSelection() {
      sent = held = null
      paint()
      const sel = doc.getSelection()
      if (sel?.anchorNode && column.contains(sel.anchorNode)) sel.removeAllRanges()
    },

    // No PDF use (Phase 5: no chapter-end block, no in-PDF find, no vocab on a PDF); the API stays whole.
    setFooter() {},
    markWords() {},
    find: () => [],

    on,

    destroy() {
      alive = false
      clear()
      const o = op
      op = null
      o?.done('superseded')
      docSeq++
      close()
      scrollSource.removeEventListener('scroll', onScroll)
      for (const t of GESTURES) win.removeEventListener(t, onGesture)
      win.removeEventListener('touchstart', onTouchStart)
      for (const t of ['touchend', 'touchcancel']) win.removeEventListener(t, onTouchEnd)
      unobserve()
      root.removeEventListener('click', onClick)
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerup', cancelHold)
      root.removeEventListener('pointercancel', cancelHold)
      doc.removeEventListener('selectionchange', onSelectionChange)
      win.clearTimeout(selTimer)
      root.replaceChildren()
      scroller.style.overflowAnchor = anchorWas
    },
  }
}
