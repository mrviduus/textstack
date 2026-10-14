// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createEngine } from './engine'
import { FILE_LENGTH, LANDSCAPE, LETTER, TALL, destroyAll, lineText, makePdfReader, quoteRect } from './fixed.testkit'
import { locatorToPdfAnchor, pdfAnchorToLocator } from './mappers'
import type { EngineEvents, Locator } from './api'

/**
 * Fixed layout (PDF). Each test name starts with its rule ID; the rules, in plain words, are in
 * docs/05-features/reader-engine.md (E32–E37, and the generic op rules on a PDF). The fake pdf.js, the
 * fake page column and the reader driver are in fixed.testkit.ts. Pixels: playground/fixed.e2e.ts.
 */

afterEach(() => { destroyAll(); vi.useRealTimers(); document.getSelection()?.removeAllRanges() })

/** Phone width 412: fit = (412 - 24) / 612. */
const FIT = (412 - 24) / 612
const PAGE_H = Math.round(792 * FIT)   // 502

/** Pages 1–4 Letter, then taller pages: until their sizes arrive, the column puts page 20 too high. */
const MIXED = [...Array(4).fill(LETTER), ...Array(36).fill(TALL)]

describe('open', () => {
  it('E32 an engine without the host fixed layout throws on a PDF: the engine never loads pdf.js', async () => {
    const engine = createEngine(document.createElement('div'), { scroller: document.createElement('div'), observeResize: () => () => {} })
    await expect(engine.open({ layout: 'fixed', pdf: { data: new ArrayBuffer(8) } })).rejects.toThrow(/fixed/)
    engine.destroy()
  })

  it('E32 an engine with it opens a PDF: one box per page fit to the width, ready with pageCount, then one ack', async () => {
    const reader = makePdfReader({ pages: 40 })
    expect(await reader.open(undefined, 'open-1')).toBe('start')
    expect(reader.events()).toEqual(['ready', 'relocated'])
    expect(reader.payloads('ready')).toEqual([{ opId: 'open-1', pageCount: 40 }])
    expect(reader.ack('open-1')).toEqual({ page: 1, reason: 'open' })
    expect(reader.pages()).toHaveLength(40)
    expect(reader.pages()[0]).toEqual({ w: 388, h: PAGE_H })
  })

  it('E32 each page keeps its own shape', async () => {
    const reader = makePdfReader({ pages: [LETTER, LANDSCAPE, LETTER] })
    await reader.open()
    await reader.settle()
    expect(reader.pages()).toEqual([
      { w: 388, h: PAGE_H },
      { w: Math.round(792 * FIT), h: Math.round(612 * FIT) },
      { w: 388, h: PAGE_H },
    ])
  })

  it('E32 an engine with the fixed layout throws on a reflow chapter', async () => {
    const reader = makePdfReader()
    await expect(reader.engine.open({ href: 'c1', layout: 'reflow', html: '<p>x</p>' })).rejects.toThrow(/reflow/)
  })
})

describe('a page position', () => {
  it("E33 a saved page opens with that page's top at the top of the screen", async () => {
    const reader = makePdfReader({ pages: 40 })
    expect(await reader.open(17, 'open-1')).toBe('exact')
    expect(reader.ack('open-1').page).toBe(17)
    expect(reader.scrollTop).toBe(reader.pageTop(17))
  })

  it('E33 waits for the sizes of every page above the target, then lands on its real top', async () => {
    const reader = makePdfReader({ pages: MIXED })
    reader.fake.holdFrom(10)
    let landed = false
    const opening = reader.open(20, 'open-1').then((r) => { landed = true; return r })
    await reader.settle()
    expect(landed).toBe(false)
    expect(reader.relocations()).toEqual([])
    reader.fake.release()
    expect(await opening).toBe('exact')
    expect(reader.ack('open-1').page).toBe(20)
    expect(reader.scrollTop).toBe(reader.pageTop(20))
    expect(reader.pages()[19].h).toBe(Math.round(1008 * FIT))
  })

  it('E33 goTo a page puts its top at the top of the screen and acks once', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    for (const page of [12, 3, 38]) {
      expect(await reader.goTo(page, `go-${page}`)).toBe('exact')
      expect(reader.ack(`go-${page}`)).toEqual({ page, reason: 'goTo' })
      expect(reader.scrollTop).toBe(reader.pageTop(page))
    }
  })

  it('E33 a page past the end lands on the last page; page 0 on page 1', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.goTo(99, 'far')
    expect(reader.ack('far').page).toBe(40)
    await reader.goTo(0, 'zero')
    expect(reader.ack('zero').page).toBe(1)
    expect(reader.scrollTop).toBe(reader.pageTop(1))
  })

  it('E33 sizes that never come: the jump lands on the estimate after 8 s', async () => {
    vi.useFakeTimers()
    const reader = makePdfReader({ pages: MIXED })
    reader.fake.holdFrom(10)
    let result: string | undefined
    void reader.open(20, 'open-1').then((r) => { result = r })
    await vi.advanceTimersByTimeAsync(7900)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(result).toBe('exact')
    expect(reader.ack('open-1').page).toBe(20)
    expect(reader.scrollTop).toBe(reader.pageTop(20))
  })

  it('E3 a goTo without a page does not move, says why, and is not landed', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open(5)
    expect(await reader.engine.goTo({ href: 'c1', type: 'text/html', locations: { progression: 0.5 } }, { opId: 'g' })).toBe('superseded')
    expect(reader.payloads('error')).toEqual([{ code: 'anchor-miss', detail: expect.stringContaining('page') }])
    expect(reader.ack('g').page).toBe(5)
    expect(reader.scrollTop).toBe(reader.pageTop(5))
  })
})

describe('ops on a PDF', () => {
  it('E4 a newer goTo supersedes one still travelling; each is acked once', async () => {
    const reader = makePdfReader({ pages: MIXED })
    await reader.open()
    reader.fake.holdFrom(10)
    const first = reader.goTo(25, 'first')
    const second = reader.goTo(30, 'second')
    reader.fake.release()
    expect(await first).toBe('superseded')
    expect(await second).toBe('exact')
    expect(reader.ack('first').page).toBe(30)
    expect(reader.ack('second').page).toBe(30)
    expect(reader.scrollTop).toBe(reader.pageTop(30))
  })

  it('E4 a second open replaces the first: the first is superseded, only the second is shown', async () => {
    const reader = makePdfReader({ pages: 40 })
    const first = reader.open(10, 'first')
    const second = reader.open(3, 'second')
    expect(await first).toBe('superseded')
    expect(await second).toBe('exact')
    expect(reader.payloads('ready')).toEqual([{ opId: 'second', pageCount: 40 }])
    expect(reader.pages()).toHaveLength(40)
  })

  it('E12 a goTo that overtakes the open still gets the PDF its ready, and lands', async () => {
    const reader = makePdfReader({ pages: 40 })
    const opening = reader.open(undefined, 'open-1')
    const going = reader.goTo(12, 'go')
    expect(await opening).toBe('superseded')
    expect(await going).toBe('exact')
    expect(reader.payloads('ready')).toEqual([{ opId: 'open-1', pageCount: 40 }])
    expect(reader.scrollTop).toBe(reader.pageTop(12))
  })

  it('E6 a style change keeps the page and acks once', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open(8)
    reader.setStyle({ theme: { bg: '#000', fg: '#fff' } }, 'style-1')
    await reader.settle()
    expect(reader.ack('style-1')).toEqual({ page: 8, reason: 'style' })
    expect(reader.scrollTop).toBe(reader.pageTop(8))
  })

  it('E7 while a jump travels, current() is its target', async () => {
    const reader = makePdfReader({ pages: MIXED })
    await reader.open()
    reader.fake.holdFrom(10)
    void reader.goTo(22)
    await reader.settle()
    expect(reader.engine.current()).toEqual({ type: 'application/pdf', locations: { position: 22 } })
  })

  it('E9 destroy: a travelling op resolves superseded, no events, the container is empty', async () => {
    const reader = makePdfReader({ pages: MIXED })
    await reader.open()
    reader.fake.holdFrom(10)
    const going = reader.goTo(30, 'go')
    const before = reader.relocations().length
    reader.engine.destroy()
    reader.fake.release()
    expect(await going).toBe('superseded')
    await reader.settle()
    expect(reader.relocations()).toHaveLength(before)
    expect(reader.root.childNodes).toHaveLength(0)
    expect(reader.fake.destroyed).toBe(1)
  })
})

describe('bytes', () => {
  it('E34 by ranges: pdf.js reads through the host, every range inside the file', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    const src = reader.fake.sources[0]
    expect('range' in src && (src.range as unknown as { length: number }).length).toBe(FILE_LENGTH)
    expect(reader.reads.length).toBeGreaterThan(1)
    for (const [b, e] of reader.reads) expect(0 <= b && b < e && e <= FILE_LENGTH, `${b}-${e}`).toBe(true)
  })

  it('E34 whole: the host hands the bytes, the engine reads nothing', async () => {
    const reader = makePdfReader({ pages: 40 })
    expect(await reader.open(4, 'o', 'data')).toBe('exact')
    expect('data' in reader.fake.sources[0]).toBe(true)
    expect(reader.reads).toEqual([])
  })

  it('E34 a read rejected with pdf-auth while opening: one pdf-auth error; the open acks its page, not landed', async () => {
    const reader = makePdfReader({ pages: 40 })
    reader.failReads(0, { code: 'pdf-auth' })
    expect(await reader.open(17, 'open-1')).toBe('superseded')
    expect(reader.payloads('error')).toEqual([{ code: 'pdf-auth', detail: expect.any(String) }])
    expect(reader.ack('open-1').page).toBe(17)
  })

  it('E34 pdf-auth mid-read (pages after the open): one error, however many reads fail', async () => {
    const reader = makePdfReader({ pages: 40 })
    reader.failReads(1024 + 3 * 64, { code: 'pdf-auth' })
    expect(await reader.open(undefined, 'open-1')).toBe('start')
    await reader.settle()
    expect(reader.reads.filter(([b]) => b >= 1024 + 3 * 64).length).toBeGreaterThan(1)
    expect(reader.payloads('error')).toEqual([{ code: 'pdf-auth', detail: expect.any(String) }])
  })

  it('E34 any other read failure is pdf-load', async () => {
    const reader = makePdfReader({ pages: 40 })
    reader.failReads(0, new Error('offline'))
    expect(await reader.open(undefined, 'open-1')).toBe('superseded')
    expect(reader.payloads('error')).toEqual([{ code: 'pdf-load', detail: 'offline' }])
    expect(reader.ack('open-1').page).toBe(1)
  })

  it('E34 a broken file is pdf-load, with the reason', async () => {
    const reader = makePdfReader({ broken: true })
    expect(await reader.open(undefined, 'open-1', 'data')).toBe('superseded')
    expect(reader.payloads('error')).toEqual([{ code: 'pdf-load', detail: 'Invalid PDF structure.' }])
    expect(reader.events()).toEqual(['error', 'relocated'])
  })
})

describe('the render window', () => {
  it('E35 only pages near the screen have a canvas', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.settle()
    // Visible with the 300 px margin: pages 1–3; drawn one page further.
    expect(reader.canvases()).toEqual([1, 2, 3, 4])
  })

  it('E35 scrolling the whole PDF keeps the canvas count bounded, and the pages on screen drawn', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    let most = 0
    for (let y = 0; y <= reader.pageTop(40); y += 700) {
      reader.scrollTo(y)
      await reader.settle()
      const drawn = reader.canvases()
      most = Math.max(most, drawn.length)
      expect(drawn).toContain(reader.spot()!.page)
    }
    expect(most).toBeLessThanOrEqual(8)
    expect(reader.canvases().every((p) => p >= 34)).toBe(true)
  })

  it('E35 a jump draws the pages it lands on and frees the ones it left', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.settle()
    await reader.goTo(30)
    await reader.settle()
    expect(reader.canvases()).toEqual([28, 29, 30, 31, 32, 33])
  })
})

describe('reading', () => {
  it('E36 the reader scrolling to another page emits one scroll with it; inside a page, nothing', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    reader.scrollTo(100)
    await reader.settle()
    expect(reader.reasons()).toEqual(['open'])
    reader.scrollTo(reader.pageTop(5) - 50)
    await reader.settle()
    expect(reader.relocations().slice(1)).toEqual([{ locator: { type: 'application/pdf', locations: { position: 5 } }, reason: 'scroll' }])
  })

  it("E36 the engine's own scrolls are never 'scroll'", async () => {
    const reader = makePdfReader({ pages: MIXED })
    await reader.open(12)
    await reader.goTo(30)
    await reader.goTo(2)
    await reader.settle()
    expect(reader.reasons()).toEqual(['open', 'goTo', 'goTo'])
  })

  it('E36 a reader gesture during a jump ends it where the reader is, and it never snaps back', async () => {
    for (const gesture of ['touchmove', 'wheel', 'key:ArrowDown', 'key:PageUp', 'key: ', 'key:End']) {
      const reader = makePdfReader({ pages: MIXED })
      await reader.open()
      reader.fake.holdFrom(10)
      const going = reader.goTo(30, 'go')
      await reader.settle()
      reader.gesture(gesture)
      expect(await going, gesture).toBe('superseded')
      const where = reader.spot()!.page
      expect(reader.ack('go').page).toBe(where)
      reader.fake.release()
      await reader.settle()
      expect(reader.spot()!.page, gesture).toBe(where)
      destroyAll()
    }
  })

  it('E36 a key that does not scroll (Escape, a modifier) leaves the jump travelling', async () => {
    const reader = makePdfReader({ pages: MIXED })
    await reader.open()
    reader.fake.holdFrom(10)
    const going = reader.goTo(30, 'go')
    await reader.settle()
    for (const key of ['Escape', 'Shift', 'Control', 'Meta', 'a']) reader.gesture(`key:${key}`)
    reader.fake.release()
    expect(await going).toBe('exact')
    expect(reader.scrollTop).toBe(reader.pageTop(30))
  })
})

describe('sizes', () => {
  it('E37 sizes arriving above the reader keep them on the same spot of the same page', async () => {
    const reader = makePdfReader({ pages: MIXED })
    reader.fake.holdFrom(3)
    await reader.open()
    reader.scrollTo(reader.pageTop(15) + PAGE_H / 2)   // the middle of page 15, on estimated sizes
    await reader.settle()
    await new Promise((r) => setTimeout(r, 200))      // the reader stopped
    const before = reader.spot()!
    const reasons = reader.reasons().length
    reader.fake.release()
    await reader.settle()
    const after = reader.spot()!
    expect(after.page).toBe(before.page)
    expect(Math.abs(after.into - before.into) * reader.pages()[14].h).toBeLessThan(1)
    expect(reader.reasons()).toHaveLength(reasons)   // the engine's re-anchor is not the reader's scroll
  })

  it('E37 a width change re-fits every page and keeps the spot', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open(10)
    reader.scrollTo(reader.pageTop(10) + 200)
    await reader.settle()
    await new Promise((r) => setTimeout(r, 200))
    const before = reader.spot()!
    reader.setWidth(800)
    await reader.settle()
    expect(reader.pages()[0].w).toBe(800 - 24)
    const after = reader.spot()!
    expect(after.page).toBe(before.page)
    expect(Math.abs(after.into - before.into) * reader.pages()[9].h).toBeLessThan(2)
  })

  it("E37 the engine's own scroll is not a fling: a size change right after a jump applies at once", async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.goTo(10)
    await new Promise((r) => setTimeout(r, 5))  // the jump's scroll event just arrived
    reader.setWidth(800)
    expect(reader.pages()[0].w).toBe(800 - 24)
    expect(reader.spot()!.page).toBe(10)
  })

  it('E37 while the reader scrolls, a size change waits until scrolling has stopped', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open(10)
    reader.scrollTo(reader.pageTop(10) + 200)
    await new Promise((r) => setTimeout(r, 5))  // a fling: its scroll event just arrived
    const top = reader.scrollTop
    reader.setWidth(800)
    expect(reader.scrollTop).toBe(top)          // nothing moved under the finger
    expect(reader.pages()[0].h).toBe(PAGE_H)
    await new Promise((r) => setTimeout(r, 200))
    await reader.settle()
    expect(reader.pages()[0].w).toBe(800 - 24)
    expect(reader.spot()!.page).toBe(10)
  })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('zoom', () => {
  it("E38 zoom 2 doubles every page and keeps the page under the top line at the same fraction; one 'style' ack", async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open(10)
    reader.scrollTo(reader.pageTop(10) + 150)
    await reader.settle()
    const before = reader.spot()!
    reader.setStyle({ zoom: 2 }, 'z')
    await reader.settle()
    expect(reader.pages()[0]).toEqual({ w: Math.round(612 * FIT * 2), h: Math.round(792 * FIT * 2) })
    const after = reader.spot()!
    expect(after.page).toBe(10)
    expect(Math.abs(after.into - before.into) * reader.pages()[9].h).toBeLessThan(2)
    expect(reader.ack('z')).toEqual({ page: 10, reason: 'style' })
  })

  it("E38 'fit' goes back to the width; zoom is clamped to 0.2–5×", async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    reader.setStyle({ zoom: 100 })
    expect(reader.pages()[0].w).toBe(Math.round(612 * 5))
    reader.setStyle({ zoom: 0.01 })
    expect(reader.pages()[0].w).toBe(Math.round(612 * 0.2))
    reader.setStyle({ zoom: 'fit' })
    expect(reader.pages()[0].w).toBe(388)
  })

  it('E38 the drawn pages are redrawn sharp at the new scale', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.settle()
    reader.setStyle({ zoom: 2 })
    await reader.settle()
    const canvas = reader.root.querySelector<HTMLCanvasElement>('[data-page="1"] canvas')!
    expect(parseFloat(canvas.style.width)).toBe(Math.floor(612 * FIT * 2))
  })

  it('E38 a zoom is the reader’s command: it applies at once, even mid-fling', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open(10)
    reader.scrollTo(reader.pageTop(10) + 150)
    await wait(5)   // a fling's scroll event just arrived
    reader.setStyle({ zoom: 1.5 })
    expect(reader.pages()[0].w).toBe(Math.round(612 * FIT * 1.5))
    expect(reader.spot()!.page).toBe(10)
  })
})

describe('text layer', () => {
  it("E39 each drawn page has pdf.js's text layer at its scale; it goes with the canvas", async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.settle()
    const withText = () => Array.from(reader.root.querySelectorAll<HTMLElement>('[data-page]')).filter((el) => el.querySelector('.textLayer span')).map((el) => Number(el.dataset.page))
    expect(withText()).toEqual(reader.canvases())
    expect(reader.span(2, 1).textContent).toBe(lineText(2, 1))
    expect(reader.root.querySelector<HTMLElement>('[data-page="1"] .textLayer')!.style.getPropertyValue('--scale-factor')).toBe(String(FIT))
    await reader.goTo(30)
    await reader.settle()
    expect(withText()).toEqual(reader.canvases())
    expect(withText()).not.toContain(1)
  })
})

describe('selection on a PDF', () => {
  async function opened() {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.settle()
    return reader
  }
  const selections = (reader: ReturnType<typeof makePdfReader>) => reader.payloads('selection') as EngineEvents['selection'][]

  it('E20 a drag on a page, once it settles, is one selection: text, sentence, page and rects', async () => {
    const reader = await opened()
    reader.select(reader.range(2, 1, 'keeper counted'))
    reader.select(reader.range(2, 1, 'keeper counted'))   // iOS fires again: sent once
    await wait(250)
    expect(selections(reader)).toEqual([{
      locator: { type: 'application/pdf', locations: { position: 2 }, text: { highlight: 'keeper counted' }, ext: { rects: [quoteRect(2, 1, 'keeper counted')] } },
      text: 'keeper counted',
      sentence: lineText(2, 1),
      source: 'drag',
      tooLong: false,
      rect: expect.objectContaining({ width: expect.any(Number) }),
    }])
  })

  it("E40 the locator writes today's PdfAnchor bytes, and they paint back on the same text", async () => {
    const reader = await opened()
    reader.select(reader.range(2, 1, 'keeper counted'))
    await wait(250)
    const json = locatorToPdfAnchor(selections(reader)[0]!.locator)
    expect(json).toBe(JSON.stringify({ v: 1, kind: 'pdf', page: 2, rects: [quoteRect(2, 1, 'keeper counted')], exact: 'keeper counted' }))
    reader.engine.decorate('highlight', [{ id: 'h', locator: pdfAnchorToLocator(json!)! }])
    const painted = reader.drawn(2, 'highlight')[0].box
    const text = reader.range(2, 1, 'keeper counted').getClientRects()[0]
    const page = reader.root.querySelector('[data-page="2"]')!.getBoundingClientRect()
    expect(Math.abs(painted.left - (text.left - page.left))).toBeLessThan(0.5)
    expect(Math.abs(painted.top - (text.top - page.top))).toBeLessThan(0.5)
    expect(Math.abs(painted.width - text.width)).toBeLessThan(0.5)
  })

  it('E40 the same text selected at zoom 2 gives the same rects', async () => {
    const reader = await opened()
    reader.setStyle({ zoom: 2 })
    await reader.settle()
    reader.select(reader.range(1, 2, 'counted 12 ships'))
    await wait(250)
    expect(selections(reader)[0]!.locator.ext!.rects).toEqual([quoteRect(1, 2, 'counted 12 ships')])
  })

  it("E40 a selection running onto the next page keeps the start page's part", async () => {
    const reader = await opened()
    const r = document.createRange()
    r.setStart(reader.span(2, 2).firstChild!, 0)
    r.setEnd(reader.span(3, 0).firstChild!, 6)
    reader.select(r)
    await wait(250)
    const loc = selections(reader)[0]!.locator
    expect(loc.locations.position).toBe(2)
    expect(loc.ext!.rects).toEqual([quoteRect(2, 2, lineText(2, 2))])
  })

  it('E20 the selection going away is null', async () => {
    const reader = await opened()
    reader.select(reader.range(2, 1, 'keeper'))
    await wait(250)
    reader.select(null)
    await wait(250)
    expect(selections(reader)).toHaveLength(2)
    expect(selections(reader)[1]).toBeNull()
  })

  it("E20 a selection moving off the pages (the host's own text) is null", async () => {
    const reader = await opened()
    reader.select(reader.range(2, 1, 'keeper'))
    await wait(250)
    const outside = document.createElement('p')
    outside.textContent = 'Translate'
    document.body.append(outside)
    const r = document.createRange()
    r.selectNodeContents(outside)
    reader.select(r)
    await wait(250)
    expect(selections(reader)[1]).toBeNull()
    outside.remove()
  })

  it('E21 a finger held still 450 ms on a word: hold, then the word as a selection, marked; the page selection untouched', async () => {
    const reader = await opened()
    const p = reader.pointAt(2, 1, 'keeper')
    reader.pointer('pointerdown', p.x + 10, p.y, reader.span(2, 1))
    await wait(500)
    expect(reader.events().filter((e) => e === 'hold' || e === 'selection')).toEqual(['hold', 'selection'])
    const sel = selections(reader)[0]!
    expect(sel.text).toBe('keeper')
    expect(sel.source).toBe('hold')
    expect(sel.locator.ext!.rects).toEqual([quoteRect(2, 1, 'keeper')])
    expect(reader.drawn(2, 'selection')).toHaveLength(1)
    expect(document.getSelection()!.rangeCount).toBe(0)
    reader.tap(p.x + 10, p.y, reader.span(2, 1))   // the click that ends the hold
    expect(reader.events()).not.toContain('tap')
    reader.engine.clearSelection()
    expect(reader.drawn(2, 'selection')).toEqual([])
  })

  it('E21 moving 8 px cancels the hold', async () => {
    const reader = await opened()
    const p = reader.pointAt(2, 1, 'keeper')
    reader.pointer('pointerdown', p.x, p.y, reader.span(2, 1))
    reader.pointer('pointermove', p.x, p.y + 9, reader.span(2, 1))
    await wait(500)
    expect(reader.events()).not.toContain('hold')
  })
})

describe('highlights on a PDF', () => {
  const hl = (id: string, page: number, rects: { x: number; y: number; w: number; h: number }[], style?: string): { id: string; locator: Locator; style?: string } =>
    ({ id, locator: { type: 'application/pdf', locations: { position: page }, text: { highlight: 'x' }, ext: { rects } }, style })

  it('E41 each item is painted on its page from its rects at the live scale, in its colour', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    reader.engine.decorate('highlight', [hl('h1', 3, [{ x: 100, y: 96, w: 84, h: 12 }], 'rgba(1, 2, 3, 0.5)')])
    expect(reader.drawn(3, 'highlight')).toEqual([{ id: 'h1', dot: false, box: { left: 100 * FIT, top: 96 * FIT, width: 84 * FIT, height: 12 * FIT } }])
    expect(reader.root.querySelector<HTMLElement>('[data-page="3"] [data-id="h1"]')!.style.background).toBe('rgba(1, 2, 3, 0.5)')
    reader.setStyle({ zoom: 2 })
    expect(reader.drawn(3, 'highlight')[0].box.left).toBeCloseTo(100 * FIT * 2)
  })

  it("E41 'dot' is a dot just after the last rect, no fill", async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    reader.engine.decorate('highlight', [hl('h1', 2, [{ x: 100, y: 96, w: 84, h: 12 }, { x: 72, y: 120, w: 30, h: 12 }], 'dot')])
    const drawn = reader.drawn(2, 'highlight')
    expect(drawn.filter((d) => !d.dot)).toEqual([])
    expect(drawn.filter((d) => d.dot).map((d) => d.box.left)).toEqual([(72 + 30) * FIT + 1])
  })

  it('E41 a call replaces its own group only; no page or no rects is not drawn', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    reader.engine.decorate('search', [hl('s1', 2, [{ x: 72, y: 72, w: 30, h: 12 }])])
    reader.engine.decorate('highlight', [hl('h1', 2, [{ x: 100, y: 96, w: 84, h: 12 }]), { id: 'bad', locator: { type: 'application/pdf', locations: {} } }, hl('none', 2, [])])
    reader.engine.decorate('highlight', [hl('h2', 4, [{ x: 100, y: 96, w: 84, h: 12 }])])
    expect(reader.drawn(2, 'search').map((d) => d.id)).toEqual(['s1'])
    expect(reader.drawn(2, 'highlight')).toEqual([])
    expect(reader.drawn(4, 'highlight').map((d) => d.id)).toEqual(['h2'])
  })

  it('E41 the marks let a selection start through them', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    reader.engine.decorate('highlight', [hl('h1', 2, [{ x: 100, y: 96, w: 84, h: 12 }])])
    expect(reader.root.querySelector<HTMLElement>('[data-page="2"] .pdf-marks')!.style.pointerEvents).toBe('none')
  })

  it('E41 a tap on a painted rect is a decorationTap with its id and box; a highlight wins over a search hit', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.settle()
    reader.engine.decorate('search', [hl('s1', 2, [quoteRect(2, 1, 'keeper counted')])])
    reader.engine.decorate('highlight', [hl('h1', 2, [quoteRect(2, 1, 'keeper')])])
    const p = reader.pointAt(2, 1, 'keeper')
    reader.tap(p.x, p.y, reader.span(2, 1))
    await wait(350)
    const q = reader.pointAt(2, 1, 'counted')
    reader.tap(q.x, q.y, reader.span(2, 1))
    const taps = reader.payloads('decorationTap') as EngineEvents['decorationTap'][]
    expect(taps.map((t) => [t.group, t.id])).toEqual([['highlight', 'h1'], ['search', 's1']])
    const page = reader.root.querySelector('[data-page="2"]')!.getBoundingClientRect()
    expect(taps[0].rect.x).toBeCloseTo(page.left + quoteRect(2, 1, 'keeper').x * FIT)
    expect(reader.events()).not.toContain('tap')
  })
})

describe('taps and scrolling on a PDF', () => {
  it('E22 a tap on the page is a tap; the click ending a drag selection is not', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.settle()
    reader.tap(200, 300)
    expect(reader.payloads('tap')).toEqual([{ x: 200, y: 300 }])
    await wait(350)
    reader.select(reader.range(1, 0, 'keeper'))
    reader.tap(200, 300)
    expect(reader.payloads('tap')).toHaveLength(1)
  })

  it('E28 a second tap within 300 ms emits nothing', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    reader.tap(200, 300)
    reader.tap(200, 300)
    expect(reader.payloads('tap')).toHaveLength(1)
  })

  it("E23 reader scrolling says its direction: 'down' after 48 px, 'up' after 6; the engine's own scrolls never", async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.goTo(10)
    await reader.settle()
    expect(reader.payloads('scrollDir')).toEqual([])
    const y = reader.scrollTop
    reader.scrollTo(y + 40)
    await reader.settle()
    expect(reader.payloads('scrollDir')).toEqual([])
    reader.scrollTo(y + 60)
    await reader.settle()
    reader.scrollTo(y + 53)
    await reader.settle()
    expect(reader.payloads('scrollDir')).toEqual(['down', 'up'])
  })
})

describe('review fixes', () => {
  it('E35 a page freed while its draw waits, then drawn again, has one canvas and one text layer', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.settle()
    reader.fake.holdFrom(10)                 // the draws below wait on their pages
    reader.scrollTo(reader.pageTop(12))
    await reader.settle()
    reader.scrollTo(0)                       // freed while waiting
    await reader.settle()
    reader.scrollTo(reader.pageTop(12))      // drawn again
    await reader.settle()
    reader.fake.release()
    await reader.settle()
    for (const el of Array.from(reader.root.querySelectorAll('[data-page]'))) {
      expect(el.querySelectorAll('canvas').length, `page ${(el as HTMLElement).dataset.page}`).toBeLessThanOrEqual(1)
      expect(el.querySelectorAll('.textLayer').length, `page ${(el as HTMLElement).dataset.page}`).toBeLessThanOrEqual(1)
    }
  })

  it('E34 after a failed open, a goTo is acked and not landed, and current() stays empty', async () => {
    const reader = makePdfReader({ pages: 40 })
    reader.failReads(0, new Error('offline'))
    await reader.open(3, 'o')
    let result: string | undefined
    void reader.goTo(5, 'g').then((r) => { result = r })
    await reader.settle()
    expect(result).toBe('superseded')
    expect(reader.ack('g').page).toBe(3)
    expect(reader.engine.current()).toBeNull()
  })

  it("E40 a drag onto the next page: the text and sentence are the start page's part too, like the rects", async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    await reader.settle()
    const r = document.createRange()
    r.setStart(reader.span(2, 2).firstChild!, 0)
    r.setEnd(reader.span(3, 0).firstChild!, 6)
    reader.select(r)
    await wait(250)
    const sel = reader.payloads('selection')[0] as NonNullable<EngineEvents['selection']>
    expect(sel.text).toBe(lineText(2, 2))
    expect(sel.locator.text!.highlight).toBe(lineText(2, 2))
    expect(sel.sentence).toBe(lineText(2, 2))
  })

  it("E39 a page whose canvas could not be made says 'render', and is drawn when it can be", async () => {
    const real = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof real
    const reader = makePdfReader({ pages: 40 })
    try {
      await reader.open()
      await reader.settle()
      expect(reader.payloads('error')).toContainEqual({ code: 'render', detail: expect.stringContaining('page 1') })
    } finally { HTMLCanvasElement.prototype.getContext = real }
    reader.scrollTo(10)
    await reader.settle()
    expect(reader.canvases()).toContain(1)
  })

  it('E36 a scroll key typed into a host field never ends a jump', async () => {
    const reader = makePdfReader({ pages: MIXED })
    await reader.open()
    reader.fake.holdFrom(10)
    const going = reader.goTo(30, 'go')
    await reader.settle()
    const fields = [document.createElement('input'), document.createElement('textarea'), (() => { const d = document.createElement('div'); d.setAttribute('contenteditable', 'true'); return d })()]
    for (const f of fields) {
      document.body.append(f)
      f.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      f.remove()
    }
    reader.fake.release()
    expect(await going).toBe('exact')
  })

  it("E32 page boxes have page 1's own shape from the start: the first draw is never thrown away", async () => {
    const reader = makePdfReader({ pages: [LANDSCAPE, ...Array(9).fill(LANDSCAPE)] })
    let atReady: { w: number; h: number } | undefined
    reader.engine.on('ready', () => { atReady = reader.pages()[0] })
    await reader.open()
    await reader.settle()
    expect(atReady).toEqual({ w: 388, h: Math.round(612 * (412 - 24) / 792) })
    expect(reader.fake.renders).toBe(reader.canvases().length)
  })

  it('E23 + E28 a new document starts fresh: its first scroll down and its first tap are sent', async () => {
    const reader = makePdfReader({ pages: 40 })
    await reader.open()
    reader.scrollTo(100)
    await reader.settle()
    reader.tap(200, 300)
    await reader.open(undefined, 'second')
    reader.tap(200, 300)
    reader.scrollTo(200)
    await reader.settle()
    expect(reader.payloads('scrollDir')).toEqual(['down', 'down'])
    expect(reader.payloads('tap')).toHaveLength(2)
  })
})
