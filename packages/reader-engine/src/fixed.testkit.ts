// Test kit for fixed.test.ts: a fake pdf.js (pages and their sizes, ranges read through the host, no
// pixels), a fake layout for the page column (jsdom has none) and a reader driver, so each test reads
// as its rule (docs/05-features/reader-engine.md, E32–E37).
import { expect } from 'vitest'
import type { EngineEvents, Style } from './api'
import { createEngine } from './engine'
import { fixedLayout, type PdfJs, type PdfRangeTransport } from './fixed'
import { deferred } from './engine.testkit'

export interface Dim { w: number; h: number }
export const LETTER: Dim = { w: 612, h: 792 }
export const LANDSCAPE: Dim = { w: 792, h: 612 }
/** Taller than Letter: the estimate (page 1's size) is wrong for it. */
export const TALL: Dim = { w: 612, h: 1008 }

/** The fake file's length; every range the fake asks for is inside it. */
export const FILE_LENGTH = 8192

/** jsdom has no canvas: a context the fake renderer never draws on. */
HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement['getContext']

/**
 * pdf.js, faked: `getDocument` gets the file from `data` or by ranges through the host's transport
 * (the header first, then a range per page), `getPage(n)` waits for its range like the real one, so a
 * failed read leaves it hanging. `holdFrom(n)`: page n and later wait until `release()` (sizes stream in).
 */
export function fakePdfjs(pages: Dim[], opts: { broken?: boolean } = {}) {
  let hold = { from: Infinity, gate: deferred() }
  const sources: ({ data: Uint8Array } | { range: PdfRangeTransport })[] = []
  let destroyed = 0
  let renders = 0

  class PDFDataRangeTransport implements PdfRangeTransport {
    private listeners: ((begin: number) => void)[] = []
    constructor(public length: number, public initialData: Uint8Array | null) {}
    addRangeListener(l: (begin: number) => void) { this.listeners.push(l) }
    onDataRange(begin: number) { for (const l of [...this.listeners]) l(begin) }
    requestDataRange(_begin: number, _end: number) { throw new Error('the host overrides this') }
  }

  const pdfjs: PdfJs = {
    PDFDataRangeTransport,
    getDocument(arg) {
      const src = arg as { data: Uint8Array } | { range: PdfRangeTransport }
      sources.push(src)
      const range = 'range' in src ? (src.range as PDFDataRangeTransport) : null
      const read = (begin: number, end: number) => new Promise<void>((done) => {
        if (!range) return done()
        range.addRangeListener((b) => { if (b === begin) done() })
        range.requestDataRange(begin, end)
      })
      const doc = {
        numPages: pages.length,
        async getPage(n: number) {
          await read(1024 + n * 64, 1024 + n * 64 + 64)
          if (n >= hold.from) await hold.gate.promise
          const d = pages[n - 1]
          return {
            getViewport: ({ scale }: { scale: number }) => ({ width: d.w * scale, height: d.h * scale }),
            render: () => { renders++; return { promise: Promise.resolve(), cancel() {} } },
          }
        },
      }
      const promise = (async () => {
        await read(0, 1024)
        if (opts.broken) throw new Error('Invalid PDF structure.')
        return doc
      })()
      return { promise, destroy: async () => { destroyed++ } }
    },
  }

  return {
    pdfjs,
    sources,
    get destroyed() { return destroyed },
    get renders() { return renders },
    holdFrom(n: number) { hold = { from: n, gate: deferred() } },
    release() { hold.gate.resolve() },
  }
}

// --- The fake layout: pages down the middle, 6 px margin above and below each (12 px between) --------

const MARGIN = 6
export const VIEWPORT = 800

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

const engines: { destroy(): void }[] = []
/** Call from afterEach. */
export function destroyAll() { engines.splice(0).forEach((e) => e.destroy()) }

/** A PDF reader on the fake layout, phone width (412 px). `pages`: a count of Letter pages, or each size. */
export function makePdfReader(opts: { pages?: number | Dim[]; width?: number; broken?: boolean } = {}) {
  const sizes = Array.isArray(opts.pages) ? opts.pages : Array.from({ length: opts.pages ?? 40 }, () => LETTER)
  const fake = fakePdfjs(sizes, { broken: opts.broken })
  let width = opts.width ?? 412

  const root = document.createElement('div')
  document.body.append(root)
  Object.defineProperty(root, 'clientWidth', { get: () => width })

  const pageEls = () => Array.from(root.querySelectorAll<HTMLElement>('[data-page]'))
  /** Each page's top and height in the column, from the sizes the engine gave it. */
  function boxes() {
    const out = new Map<Element, { top: number; height: number }>()
    let y = 0
    for (const el of pageEls()) {
      const height = parseFloat(el.style.height) || 0
      out.set(el, { top: y + MARGIN, height })
      y += height + 2 * MARGIN
    }
    return { out, total: y }
  }

  const scroller = document.createElement('div')
  let top = 0
  Object.defineProperty(scroller, 'scrollHeight', { get: () => Math.max(boxes().total, VIEWPORT) })
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      const next = Math.max(0, Math.min(v, boxes().total - VIEWPORT))
      if (next === top) return
      top = next
      setTimeout(() => scroller.dispatchEvent(new Event('scroll')), 0)   // like a browser: the event comes later
    },
  })

  let resize = () => {}
  const engine = createEngine(root, {
    fixed: fixedLayout(fake.pdfjs),
    scroller,
    measure: (el) => boxes().out.get(el) ?? { top: 0, height: boxes().total },
    viewport: () => ({ height: VIEWPORT }),
    schedule: (cb) => { setTimeout(cb, 0) },
    observeResize: (_el, cb) => { resize = cb; return () => { resize = () => {} } },
  })
  engines.push(engine)

  const log: { event: keyof EngineEvents; payload: unknown }[] = []
  for (const event of ['ready', 'relocated', 'error'] as const) engine.on(event, (payload) => log.push({ event, payload }))
  const relocations = () => log.filter((x) => x.event === 'relocated').map((x) => x.payload as EngineEvents['relocated'])

  /** Ranges the engine asked the host for. */
  const reads: [number, number][] = []
  let failure: { from: number; error: unknown } | null = null

  const reader = {
    engine,
    fake,
    root,
    reads,
    /** The host's bytes: by ranges (`read`, the default) or whole (`data`). */
    source(kind: 'read' | 'data' = 'read') {
      if (kind === 'data') return { data: new ArrayBuffer(FILE_LENGTH) }
      return {
        length: FILE_LENGTH,
        read: (begin: number, end: number) => {
          reads.push([begin, end])
          if (failure && begin >= failure.from) return Promise.reject(failure.error)
          return Promise.resolve(new Uint8Array(end - begin))
        },
      }
    },
    /** From now on every read at or past `from` rejects with `error`. */
    failReads(from: number, error: unknown) { failure = { from, error } },
    open(page?: number, opId?: string, kind: 'read' | 'data' = 'read') {
      return engine.open({ layout: 'fixed', pdf: reader.source(kind) }, page === undefined ? undefined : { type: 'application/pdf', locations: { position: page } }, opId)
    },
    goTo(page: number, opId?: string) {
      return engine.goTo({ type: 'application/pdf', locations: { position: page } }, { opId })
    },
    setStyle(s: Style, opId?: string) { engine.setStyle(s, opId) },
    /** The page boxes, as laid out: width, height. */
    pages: () => pageEls().map((el) => ({ w: parseFloat(el.style.width), h: parseFloat(el.style.height) })),
    /** Where page n's top is in the column. */
    pageTop: (n: number) => boxes().out.get(pageEls()[n - 1])!.top,
    /** Page numbers that have a canvas now. */
    canvases: () => pageEls().filter((el) => el.querySelector('canvas')).map((el) => Number(el.dataset.page)),
    /** The page under the top of the screen, and how far into it (0..1). */
    spot() {
      for (const [el, b] of boxes().out) {
        if (top < b.top + b.height) return { page: Number((el as HTMLElement).dataset.page), into: (top - b.top) / b.height }
      }
      return null
    },
    get scrollTop() { return top },
    /** The reader scrolls by hand to y. */
    scrollTo(y: number) { scroller.scrollTop = y },
    /** A reader gesture (finger, wheel, key) on the page. */
    gesture(type: 'touchmove' | 'wheel' | 'keydown' = 'touchmove') { window.dispatchEvent(new Event(type)) },
    /** The reader's screen gets wider or narrower (rotation). */
    setWidth(w: number) { width = w; resize() },
    /** Let every pending frame, timer, read and page run. */
    async settle() { for (let i = 0; i < 12; i++) await tick() },
    events: () => log.map((x) => x.event),
    payloads: (event: keyof EngineEvents) => log.filter((x) => x.event === event).map((x) => x.payload),
    relocations,
    reasons: () => relocations().map((r) => r.reason),
    /** The op's ack: asserts there is exactly one `relocated` with this opId, and returns its page. */
    ack(opId: string): { page: number | undefined; reason: string } {
      const mine = relocations().filter((r) => r.opId === opId)
      expect(mine, `relocated events for ${opId}`).toHaveLength(1)
      return { page: mine[0].locator.locations.position, reason: mine[0].reason }
    },
  }
  return reader
}
