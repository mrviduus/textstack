// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createEngine } from './engine'
import { FILE_LENGTH, LANDSCAPE, LETTER, TALL, destroyAll, makePdfReader } from './fixed.testkit'

/**
 * Fixed layout (PDF). Each test name starts with its rule ID; the rules, in plain words, are in
 * docs/05-features/reader-engine.md (E32–E37, and the generic op rules on a PDF). The fake pdf.js, the
 * fake page column and the reader driver are in fixed.testkit.ts. Pixels: playground/fixed.e2e.ts.
 */

afterEach(() => { destroyAll(); vi.useRealTimers() })

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
