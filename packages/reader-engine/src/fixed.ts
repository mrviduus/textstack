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
import type { ChapterDoc, EngineEvents, EngineOptions, GoToResult, Locator, Reason, ReaderEngine } from './api'
import { clampPage, computePageRings, dimsReadyUpTo, pageAtViewportTop, readingPage, type PageRect } from '../../shared/src/reader/pdfPageWindow'

/** The part of pdf.js the fixed layout uses. The host passes the real module; tests a fake. */
export interface PdfJs {
  getDocument(src: { data: Uint8Array } | { range: PdfRangeTransport }): { promise: Promise<PdfDoc>; destroy(): Promise<void> }
  PDFDataRangeTransport: new (length: number, initialData: Uint8Array | null) => PdfRangeTransport
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
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number }; transform?: number[] }): { promise: Promise<void>; cancel(): void }
}

interface Dim { w: number; h: number }
interface Slot { el: HTMLElement; canvas: HTMLCanvasElement | null; drawn: number | null; drawing: number | null; task: { cancel(): void } | null }
interface Op { page: number; reason: Reason; opId?: string; result: GoToResult; done: (r: GoToResult) => void }

const FALLBACK: Dim = { w: 612, h: 792 }   // US Letter at 72 dpi, until page 1's size is known
const PAD = 24
/** A jump never waits longer than this for the sizes above its target (a slow stream, a read that never returns). */
const JUMP_DEADLINE_MS = 8000
/** No reader scroll for this long (and no finger down) = the scroll, fling included, is over. */
const SCROLL_IDLE_MS = 150
/** Pages this close to the screen count as visible: drawn before they arrive. */
const RENDER_MARGIN_PX = 300

/** The fixed layout with the host's pdf.js, for `createEngine(root, { fixed })`. */
export function fixedLayout(pdfjs: PdfJs): (root: HTMLElement, opts: EngineOptions) => ReaderEngine {
  return (root, opts) => createFixed(root, opts, pdfjs)
}

function createFixed(root: HTMLElement, opts: EngineOptions, pdfjs: PdfJs): ReaderEngine {
  const doc = root.ownerDocument
  const win = doc.defaultView!
  const page = doc.scrollingElement as HTMLElement
  const scroller = opts.scroller ?? page
  const measure = opts.measure ?? ((el: Element) => {
    const r = el.getBoundingClientRect()
    const origin = scroller === page ? 0 : scroller.getBoundingClientRect().top
    return { top: r.top - origin + scroller.scrollTop, height: r.height }
  })
  const viewport = opts.viewport ?? (() => ({ height: scroller === page ? win.innerHeight : scroller.clientHeight }))
  const schedule = opts.schedule ?? ((cb: () => void) => { win.requestAnimationFrame(() => cb()) })
  const observeResize = opts.observeResize ?? ((el: Element, cb: () => void) => {
    const ro = new win.ResizeObserver(() => cb())
    ro.observe(el)
    return () => ro.disconnect()
  })

  const column = doc.createElement('div')
  column.className = 'pdf-pages'
  Object.assign(column.style, { display: 'flex', flexDirection: 'column', alignItems: 'center' })
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
  const listeners = new Map<keyof EngineEvents, Set<(p: never) => void>>()

  function emit<K extends keyof EngineEvents>(e: K, p: EngineEvents[K]) {
    for (const cb of [...(listeners.get(e) ?? [])]) (cb as (p: EngineEvents[K]) => void)(p)
  }

  const at = (n: number): Locator => ({ type: 'application/pdf', locations: { position: n } })
  const here = () => op?.page ?? last

  const fit = () => Math.min(5, Math.max(0.2, ((root.clientWidth || 360) - PAD) / (dims[0] ?? FALLBACK).w))

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
    ownTop = scroller.scrollTop
  }

  function scrollToPage(n: number) {
    const s = slots[n - 1]
    if (s) scrollTo(measure(s.el).top)
  }

  /** The page being read: the one filling most of the screen (QA-007 #3), the last one at the very end. */
  function reading(): number {
    const vh = viewport().height
    return readingPage(rects(), 0, vh, scroller.scrollTop + vh >= scroller.scrollHeight - 2) ?? last
  }

  const readerScrolling = () => touchDown || Date.now() - lastScrollAt < SCROLL_IDLE_MS

  /**
   * Where the top line sits on the page under it: inside the page a fraction (a re-fit keeps the line),
   * above it (margin, gap) px. Null at the very top: the reader there stays there.
   */
  function spot(): { page: number; offset: number; fraction: number | null } | null {
    if (scroller.scrollTop < 1) return null
    const rs = rects()
    const n = pageAtViewportTop(rs, 0)
    const r = rs.find((x) => x.page === n)
    if (!r) return null
    const h = r.bottom - r.top
    return { page: r.page, offset: -r.top, fraction: -r.top >= 0 && h > 0 ? -r.top / h : null }
  }

  /**
   * Every change to the column's sizes — a measured page, a re-fit — goes through here and keeps the
   * reader where they are: a travelling jump stays aimed at its target, else the spot under the top line.
   * Not while the reader scrolls: a scroll from code stops a fling. The change waits (newest wins).
   */
  function applySizes(next = deferred ?? scale) {
    if (!op && readerScrolling()) {
      deferred = next
      if (!deferTimer) deferTimer = win.setTimeout(applyDeferred, SCROLL_IDLE_MS)
      return
    }
    deferred = null
    const keep = op ? null : spot()
    if (next !== scale) slots.forEach(free)   // drawn at the old scale
    scale = next
    slots.forEach((s, i) => {
      const b = box(i + 1)
      s.el.style.width = `${b.w}px`
      s.el.style.height = `${b.h}px`
    })
    if (op) scrollToPage(op.page)
    else if (keep) {
      const m = measure(slots[keep.page - 1].el)
      const d = m.top - scroller.scrollTop + (keep.fraction === null ? keep.offset : keep.fraction * m.height)
      // Only when something above moved: a no-op scroll would still stop a fling.
      if (Math.abs(d) >= 1) scrollTo(scroller.scrollTop + d)
    }
    sync()
  }

  function applyDeferred() {
    deferTimer = 0
    if (deferred !== null) applySizes(deferred)   // waits again if the reader is still scrolling
  }

  function free(s: Slot) {
    s.task?.cancel()
    s.task = null
    if (s.canvas) {
      s.canvas.width = s.canvas.height = 0   // gives the bitmap back now, not at the next GC
      s.canvas.remove()
      s.canvas = null
    }
    s.drawn = s.drawing = null
  }

  async function draw(n: number, s: Slot) {
    const sc = scale
    if (s.drawn === sc || s.drawing === sc) return
    free(s)
    s.drawing = sc
    try {
      const p = await pdf!.getPage(n)
      if (s.drawing !== sc) return
      const vp = p.getViewport({ scale: sc })
      const dpr = win.devicePixelRatio || 1
      const canvas = doc.createElement('canvas')
      canvas.className = 'pdf-page__canvas'
      canvas.width = Math.floor(vp.width * dpr)
      canvas.height = Math.floor(vp.height * dpr)
      Object.assign(canvas.style, { display: 'block', width: `${Math.floor(vp.width)}px`, height: `${Math.floor(vp.height)}px` })
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      s.el.append(canvas)
      s.canvas = canvas
      const t = p.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
      s.task = t
      await t.promise
      if (s.drawing !== sc) return
      s.task = null
      s.drawing = null
      s.drawn = sc
    } catch (e) {
      // A cancelled render is scroll churn, not an error.
      if (!/Cancel|Abort/i.test((e as { name?: string })?.name ?? '')) emit('error', { code: 'render', detail: `page ${n}: ${(e as Error)?.message}` })
    }
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
    void task?.destroy()
    task = null
  }

  async function load(d: ChapterDoc, opId: string | undefined, mine: number) {
    const src = d.pdf!
    // A copy: pdf.js hands `data` to its worker, and the host's buffer would be emptied.
    const loading = pdfjs.getDocument('data' in src ? { data: new Uint8Array(src.data.slice(0)) } : { range: transport(src, mine) })
    task = loading
    let loaded: PdfDoc
    try {
      // A failed read never rejects pdf.js's promise (it waits for the bytes): `fail` does.
      loaded = await Promise.race([loading.promise, new Promise<never>((_, reject) => { failLoad = reject })])
    } catch (e) {
      if (mine !== docSeq) return
      fail(e)
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
      slots.push({ el, canvas: null, drawn: null, drawing: null, task: null })
    }
    column.append(...slots.map((s) => s.el))
    applySizes(scale)
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
  const onGesture = () => { if (op && numPages) land(false) }
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
      return begin(loc.locations.position, 'goTo', o?.opId)
    },

    // Slice 1: nothing in a Style changes a PDF yet (zoom is slice 2); still one ack.
    setStyle(_s, opId) {
      schedule(() => { if (alive) emit('relocated', { locator: at(here()), reason: 'style', opId }) })
    },

    current: () => (numPages || op ? at(here()) : null),

    // No PDF use yet (slice 2: highlights, selection); the API stays whole.
    setFooter() {},
    decorate() {},
    markWords() {},
    find: () => [],
    clearSelection() {},

    on(e, cb) {
      if (!listeners.has(e)) listeners.set(e, new Set())
      const set = listeners.get(e)!
      set.add(cb as (p: never) => void)
      return () => { set.delete(cb as (p: never) => void) }
    },

    destroy() {
      alive = false
      listeners.clear()
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
      root.replaceChildren()
      scroller.style.overflowAnchor = anchorWas
    },
  }
}
