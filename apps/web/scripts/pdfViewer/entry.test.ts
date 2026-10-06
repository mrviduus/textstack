// @vitest-environment jsdom
/**
 * The mobile PDF viewer bundle (entry.ts), run in jsdom over a simulated page column, with its
 * `pdfPage` reports fed through the real RN persist gate — the open → jump → report → save path.
 *
 * jsdom has no layout, so the column is modelled: each `.pdf-page` is as tall as its inline
 * `height`, 6px margin above and below, stacked from y=0; `window.scrollTo` moves the viewport.
 * Page sizes stream in as the test releases `getPage`, exactly as the real prefetch does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pdfGateReduce, PDF_GATE_INITIAL, type PdfGateState } from '../../../../packages/shared/src/reader/pdfPersistGate'

const NUM_PAGES = 100
const COVER = { width: 612, height: 1000 }   // page 1, taller than the rest
const BODY = { width: 612, height: 792 }

let released = 0
let waiting: (() => void)[] = []
function release(upTo: number) {
  released = upTo
  const w = waiting
  waiting = []
  w.forEach(fn => fn())
}

vi.mock('pdfjs-dist/legacy/build/pdf.min.mjs', () => {
  const page = (n: number) => {
    const dim = n === 1 ? COVER : BODY
    return {
      getViewport: ({ scale }: { scale: number }) => ({ width: dim.width * scale, height: dim.height * scale }),
      render: () => ({ cancel: () => {}, promise: new Promise<void>(() => {}) }),
      streamTextContent: () => ({}),
    }
  }
  const pdf = {
    numPages: NUM_PAGES,
    getPage: (n: number) => new Promise(resolve => {
      const go = () => (n <= released ? resolve(page(n)) : waiting.push(go))
      go()
    }),
    destroy: async () => {},
  }
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({ promise: Promise.resolve(pdf) }),
    TextLayer: class { render() { return new Promise(() => {}) } cancel() {} },
  }
})

let scrollY = 0
let observerCallback: ((entries: unknown[]) => void) | null = null
const messages: { type: string; page?: number; numPages?: number; jumpId?: number }[] = []

function layoutTop(el: Element): number {
  let y = 0
  for (const sib of Array.from(el.parentElement!.children)) {
    y += 6
    if (sib === el) return y
    y += parseFloat((sib as HTMLElement).style.height) + 6
  }
  return y
}

const flush = () => vi.advanceTimersByTimeAsync(300)
/** The page under the viewport top, read off the modelled column. */
function topPage(): number {
  const el = Array.from(document.querySelectorAll('.pdf-page'))
    .find(p => layoutTop(p) + parseFloat((p as HTMLElement).style.height) > scrollY + 2)!
  return Number((el as HTMLElement).dataset.page)
}
/** The IntersectionObserver firing — pages crossing the 300px band as the column changes. */
const observerFires = async () => { observerCallback?.([]); await flush() }

// Each test imports a fresh viewer; the one before it must stop listening to the shared window.
const added: [string, EventListenerOrEventListenerObject][] = []
const realAdd = window.addEventListener.bind(window)

beforeEach(async () => {
  window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: unknown) => {
    added.push([type, fn])
    realAdd(type, fn, o as AddEventListenerOptions)
  }) as typeof window.addEventListener
  vi.useFakeTimers()
  vi.resetModules()
  released = 0
  waiting = []
  scrollY = 0
  messages.length = 0
  document.body.innerHTML = '<div id="pdf-root"></div>'
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 636 })   // scale 1
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })
  window.scrollTo = ((_x: number, y: number) => { scrollY = Math.max(0, y); window.dispatchEvent(new Event('scroll')) }) as typeof window.scrollTo
  window.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
  ;(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    constructor(cb: (e: unknown[]) => void) { observerCallback = cb }
    observe() {}
    disconnect() {}
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (!this.classList.contains('pdf-page')) return new DOMRect(0, 0, 0, 0)
    const top = layoutTop(this) - scrollY
    const h = parseFloat((this as HTMLElement).style.height)
    return { top, bottom: top + h, left: 0, right: 612, width: 612, height: h, x: 0, y: top, toJSON() {} } as DOMRect
  })
  ;(window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = {
    postMessage: (s: string) => messages.push(JSON.parse(s)),
  }
})

afterEach(() => {
  for (const [type, fn] of added.splice(0)) window.removeEventListener(type, fn)
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** RN's side (useReaderPdf): the persist gate over every `pdfPage`, and the pages it saved. */
function rnGate() {
  let gate: PdfGateState = PDF_GATE_INITIAL
  let seen = 0
  const saved: number[] = []
  return {
    saved,
    dispatch(e: Parameters<typeof pdfGateReduce>[1]) { gate = pdfGateReduce(gate, e).state },
    /** Feed the viewer's new messages through the gate. */
    drain() {
      for (; seen < messages.length; seen++) {
        const m = messages[seen]
        if (m.type === 'pdfReady') gate = pdfGateReduce(gate, { type: 'documentLoaded' }).state
        if (m.type !== 'pdfPage') continue
        const d = pdfGateReduce(gate, { type: 'pageReported', page: m.page!, ackJumpId: m.jumpId, at: Date.now() })
        gate = d.state
        if (d.persist) saved.push(m.page!)
      }
    },
  }
}

async function openViewer(initialPage: number | null) {
  ;(window as unknown as { __TS_PDF: unknown }).__TS_PDF = { url: 'book.pdf', token: null, initialPage }
  release(1)                                  // the cover's size is known first
  await import('./entry')
  await flush()
  expect(messages.some(m => m.type === 'pdfReady')).toBe(true)
}

describe('PDF reopen (F2: +2 pages per open)', () => {
  it('a resume jump saves only the resume page while the pages above it are still being measured', async () => {
    const rn = rnGate()
    await openViewer(50)                      // bootstrap at the chapter start
    rn.drain()
    // RN: device page 55, inside the chapter → jump (useReaderPdf.scrollPdfToPage).
    rn.dispatch({ type: 'jumpIssued', page: 55, jumpId: 1, at: Date.now() })
    ;(window as unknown as { scrollToPage: (n: number, id: number) => void }).scrollToPage(55, 1)
    await flush()
    rn.drain()

    // Sizes stream in: pages 2..30 turn out shorter than the cover-sized estimate.
    release(30)
    await flush()
    await observerFires()
    rn.drain()
    vi.advanceTimersByTime(5000)              // past PDF_JUMP_SETTLE_MS
    await observerFires()
    rn.drain()

    release(NUM_PAGES)
    await flush()
    await observerFires()                     // the rest of the sizes land; nothing touched
    rn.drain()
    expect(rn.saved.length).toBeGreaterThan(0)
    expect(rn.saved).toEqual(rn.saved.map(() => 55))
  })

  it('opening at the bootstrap page (no RN jump) saves nothing before that page is reached', async () => {
    const rn = rnGate()
    await openViewer(55)
    rn.drain()
    rn.dispatch({ type: 'noJumpNeeded' })     // device page == chapter start → 'stay'
    await observerFires()                     // the viewer still sits at the top, on page 1
    rn.drain()
    release(30)
    await flush()
    await observerFires()
    rn.drain()
    release(NUM_PAGES)
    await flush()
    rn.drain()
    expect(rn.saved.length).toBeGreaterThan(0)
    expect(rn.saved).toEqual(rn.saved.map(() => 55))
  })

  it('the reader scrolling while a jump travels cancels it: their page is saved, no snap back', async () => {
    const rn = rnGate()
    await openViewer(null)
    rn.drain()
    rn.dispatch({ type: 'jumpIssued', page: 55, jumpId: 1, at: Date.now() })
    ;(window as unknown as { scrollToPage: (n: number, id: number) => void }).scrollToPage(55, 1)
    await flush()
    // The reader's own gesture, then the scroll it makes: to page 20.
    window.dispatchEvent(new Event('touchmove'))
    window.scrollTo(0, layoutTop(document.querySelector('.pdf-page[data-page="20"]')!))
    await flush()
    rn.drain()
    expect(rn.saved.at(-1)).toBe(20)
    // The sizes arrive late: the cancelled jump stays cancelled, and the pages above shrinking
    // under a fixed scrollY must not carry the reader forward (TOC → drag → drift 139 → 146).
    release(NUM_PAGES)
    await flush()
    await observerFires()
    window.dispatchEvent(new Event('scroll'))
    await flush()
    rn.drain()
    expect(topPage()).toBe(20)
    expect(rn.saved.at(-1)).toBe(20)
  })

  it('a jump whose sizes never arrive lands at its deadline, and reporting resumes', async () => {
    const rn = rnGate()
    await openViewer(null)
    rn.drain()
    rn.dispatch({ type: 'jumpIssued', page: 55, jumpId: 1, at: Date.now() })
    ;(window as unknown as { scrollToPage: (n: number, id: number) => void }).scrollToPage(55, 1)
    await flush()
    rn.drain()
    expect(rn.saved).toEqual([])
    await vi.advanceTimersByTimeAsync(8000)
    rn.drain()
    expect(messages.filter(m => m.type === 'pdfPage').at(-1)).toMatchObject({ page: 55, jumpId: 1 })
    expect(rn.saved).toEqual([55])
    window.scrollTo(0, layoutTop(document.querySelector('.pdf-page[data-page="57"]')!))
    await flush()
    rn.drain()
    expect(rn.saved.at(-1)).toBe(57)
  })

  it('a jump after every size is known lands and is acknowledged at once', async () => {
    const rn = rnGate()
    await openViewer(null)
    release(NUM_PAGES)
    await flush()
    rn.drain()
    rn.dispatch({ type: 'noJumpNeeded' })
    rn.dispatch({ type: 'jumpIssued', page: 40, jumpId: 7, at: Date.now() })
    ;(window as unknown as { scrollToPage: (n: number, id: number) => void }).scrollToPage(40, 7)
    await flush()
    rn.drain()
    expect(messages.filter(m => m.type === 'pdfPage').at(-1)).toMatchObject({ page: 40, jumpId: 7 })
    expect(rn.saved.at(-1)).toBe(40)
  })

  it('a re-fit after the resume jump landed (width known late) keeps the reader on its page', async () => {
    // The open measured a too-wide container (~1.4x fit); the real width arrives afterwards.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    const rn = rnGate()
    await openViewer(null)
    release(NUM_PAGES)
    await flush()
    rn.drain()
    rn.dispatch({ type: 'noJumpNeeded' })
    rn.dispatch({ type: 'jumpIssued', page: 40, jumpId: 3, at: Date.now() })
    ;(window as unknown as { scrollToPage: (n: number, id: number) => void }).scrollToPage(40, 3)
    await flush()
    rn.drain()
    expect(rn.saved.at(-1)).toBe(40)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 636 })
    window.dispatchEvent(new Event('resize'))
    await flush()
    await observerFires()
    window.dispatchEvent(new Event('scroll'))
    await flush()
    rn.drain()
    expect(topPage()).toBe(40)
    expect(rn.saved).toEqual(rn.saved.map(() => 40))
  })

  it('a re-fit while the jump travels still lands on the target', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    const rn = rnGate()
    await openViewer(null)
    rn.drain()
    rn.dispatch({ type: 'jumpIssued', page: 40, jumpId: 4, at: Date.now() })
    ;(window as unknown as { scrollToPage: (n: number, id: number) => void }).scrollToPage(40, 4)
    await flush()
    release(20)
    await flush()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 636 })
    window.dispatchEvent(new Event('resize'))
    await flush()
    release(NUM_PAGES)
    await flush()
    await observerFires()
    rn.drain()
    expect(topPage()).toBe(40)
    expect(rn.saved).toEqual(rn.saved.map(() => 40))
    expect(rn.saved.length).toBeGreaterThan(0)
  })

  it('the fit width is the layout viewport, not the pinch-zoomed visual one', async () => {
    // Android WebView with pinch zoom: innerWidth is the visual viewport and shrinks with the zoom;
    // fitting to it gave a different scale on each open.
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 636 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 454 })
    try {
      await openViewer(null)
      release(NUM_PAGES)
      await flush()
      expect((document.querySelector('.pdf-page[data-page="2"]') as HTMLElement).style.width).toBe('612px')
    } finally {
      delete (document.documentElement as unknown as { clientWidth?: number }).clientWidth
    }
  })
})
