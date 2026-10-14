import { expect, test, type Page } from '@playwright/test'
import type { EngineEvents, Locator, ReaderEngine } from '../src/api'

// The fixed layout (PDF) on the committed fixture (pdf/fixture.pdf, 40 Letter pages) in Chromium:
// what jsdom cannot check (E33, E35, E36, E38, E40, E41 in docs/05-features/reader-engine.md), and the
// ADR-025 spike check 8 rerun on the engine.

declare global {
  interface Window {
    engine: ReaderEngine
    pdfPage: { locatorToPdfAnchor(l: Locator | null): string | null; pdfAnchorToLocator(j: string): Locator | null; length: number; reads: [number, number][]; errors: unknown[]; opened: string; pageCount(): number; canvases(): number[]; top(n: number): number }
  }
}

async function openPdf(page: Page, at?: number) {
  await page.goto(`/pdf.html${at ? `?page=${at}` : ''}`)
  await page.waitForSelector('body[data-ready]')
}

/** The page in view: wait for the frames that draw its neighbours. */
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

test('E34 opens the fixture by HTTP ranges the host reads: 40 pages, no error', async ({ page }) => {
  await openPdf(page)
  const r = await page.evaluate(() => ({ count: window.pdfPage.pageCount(), reads: window.pdfPage.reads, length: window.pdfPage.length, errors: window.pdfPage.errors, opened: window.pdfPage.opened }))
  expect(r.count).toBe(40)
  expect(r.opened).toBe('start')
  expect(r.errors).toEqual([])
  expect(r.reads.length).toBeGreaterThan(0)
  for (const [b, e] of r.reads) expect(0 <= b && b < e && e <= r.length).toBe(true)
})

test("E33 open and goTo land on page N: its top at the top of the screen, acked with N", async ({ page }) => {
  await openPdf(page, 20)
  expect(await page.evaluate(() => window.pdfPage.opened)).toBe('exact')
  expect(Math.abs(await page.evaluate(() => window.pdfPage.top(20)))).toBeLessThan(2)
  for (const n of [33, 7, 26]) {
    const r = await page.evaluate(async (n) => {
      let ack: number | undefined
      const off = window.engine.on('relocated', (e) => { if (e.opId === `go-${n}`) ack = e.locator.locations.position })
      const result = await window.engine.goTo({ type: 'application/pdf', locations: { position: n } }, { opId: `go-${n}` })
      off()
      return { result, ack, top: window.pdfPage.top(n), current: window.engine.current()?.locations.position }
    }, n)
    expect(r, `page ${n}`).toEqual({ result: 'exact', ack: n, top: expect.any(Number), current: n })
    expect(Math.abs(r.top), `page ${n}`).toBeLessThan(2)
  }
})

test('E35 scrolling through the whole PDF keeps the canvas count bounded, the page in view drawn', async ({ page }) => {
  await openPdf(page)
  let most = 0
  const end = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)
  for (let y = 0; y <= end; y += 600) {
    await page.evaluate((y) => window.scrollTo(0, y), y)
    await frames(page)
    await expect.poll(async () => {
      const c = await page.evaluate(() => window.pdfPage.canvases())
      most = Math.max(most, c.length)
      const inView = await page.evaluate(() => window.engine.current()!.locations.position!)
      return c.includes(inView)
    }).toBe(true)
  }
  expect(most).toBeLessThanOrEqual(8)
  expect(await page.evaluate(() => window.pdfPage.canvases().every((p) => p >= 34))).toBe(true)
})

test("E36 the reader scrolling to a page reports it once, as 'scroll'", async ({ page }) => {
  await openPdf(page)
  const r = await page.evaluate(async () => {
    const seen: { page?: number; reason: string }[] = []
    window.engine.on('relocated', (e) => seen.push({ page: e.locator.locations.position, reason: e.reason }))
    const y = document.querySelector('[data-page="12"]')!.getBoundingClientRect().top + scrollY
    window.scrollTo(0, y)
    await new Promise((r) => setTimeout(r, 300))
    return seen
  })
  expect(r).toEqual([{ page: 12, reason: 'scroll' }])
})

/**
 * On page n: select part of a text-layer line (the first line with 30+ characters, from its 3rd character,
 * `chars` long) as the reader would, and wait for the engine's `selection`. Then store it the way the apps
 * do (`locatorToPdfAnchor`), read it back, paint it, and compare the paint with the text's own boxes.
 */
async function selectAndRepaint(page: Page, n: number, chars = 18) {
  return page.evaluate(async ({ n, chars }) => {
    const { engine, pdfPage } = window
    await engine.goTo({ type: 'application/pdf', locations: { position: n } })
    const pageEl = document.querySelector(`[data-page="${n}"]`)!
    const deadline = Date.now() + 5000
    let span: HTMLElement | undefined
    while (!span && Date.now() < deadline) {
      span = Array.from(pageEl.querySelectorAll<HTMLElement>('.textLayer span:not(.markedContent)')).find((s) => (s.textContent ?? '').length >= 30)
      if (!span) await new Promise((r) => setTimeout(r, 50))
    }
    if (!span) return { error: `page ${n}: no text layer line` }
    const range = document.createRange()
    range.setStart(span.firstChild!, 2)
    range.setEnd(span.firstChild!, 2 + chars)
    const got = new Promise<EngineEvents['selection']>((r) => { const off = engine.on('selection', (e) => { off(); r(e) }) })
    const sel = getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    const selection = (await got)!
    const json = pdfPage.locatorToPdfAnchor(selection.locator)!
    const back = pdfPage.pdfAnchorToLocator(json)!
    sel.removeAllRanges()
    engine.decorate('highlight', [{ id: 'h', locator: back }])
    const painted = Array.from(pageEl.querySelectorAll('[data-group="highlight"]')).map((el) => el.getBoundingClientRect())
    const text = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5)
    const off = painted.length !== text.length ? Infinity : Math.max(0, ...painted.map((p, i) =>
      Math.max(Math.abs(p.left - text[i].left), Math.abs(p.top - text[i].top), Math.abs(p.width - text[i].width), Math.abs(p.height - text[i].height))))
    return {
      expected: range.toString().trim(),
      text: selection.text,
      page: selection.locator.locations.position,
      inPageText: (pageEl.querySelector('.textLayer')!.textContent ?? '').includes(selection.text),
      roundTrip: pdfPage.locatorToPdfAnchor(back) === json,
      off,
    }
  }, { n, chars })
}

test('E40 + E41 a selection on the text round-trips through PdfAnchor and paints on the text, at 1x and 2x', async ({ page }) => {
  await openPdf(page)
  for (const zoom of [1, 2]) {
    await page.evaluate((zoom) => window.engine.setStyle({ zoom }), zoom)
    const r = await selectAndRepaint(page, 5)
    expect(r, `zoom ${zoom}`).toMatchObject({ page: 5, inPageText: true, roundTrip: true })
    expect(r.text).toBe(r.expected)
    expect(r.off, `zoom ${zoom}: paint vs text, px`).toBeLessThan(1)
  }
})

test('E38 zoom 3 keeps the page under the top line, and a page wider than the screen is never cut on the left', async ({ page }) => {
  await openPdf(page, 12)
  const r = await page.evaluate(async () => {
    window.scrollBy(0, 200)
    await new Promise((r) => setTimeout(r, 300))
    const p = (n: number) => document.querySelector(`[data-page="${n}"]`)!.getBoundingClientRect()
    const before = -p(12).top / p(12).height
    window.engine.setStyle({ zoom: 3 })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return { before, after: -p(12).top / p(12).height, left: p(12).left, wide: p(12).width > document.documentElement.clientWidth, scrollable: document.documentElement.scrollWidth > document.documentElement.clientWidth }
  })
  expect(r.wide).toBe(true)   // the layout viewport: a phone browser zooms out to show overflow, so not innerWidth
  expect(r.scrollable).toBe(true)
  expect(r.left).toBeGreaterThanOrEqual(0)
  expect(Math.abs(r.after - r.before)).toBeLessThan(0.01)
})

test('ADR-025 spike check 8 rerun: a selection on every page of the fixture anchors on its text layer', async ({ page }) => {
  await openPdf(page)
  const failures: string[] = []
  for (let n = 1; n <= 40; n++) {
    const r = await selectAndRepaint(page, n, 24)
    const ok = !('error' in r) && r.page === n && r.text === r.expected && r.inPageText && r.roundTrip && r.off < 1
    if (!ok) failures.push(`page ${n}: ${JSON.stringify(r)}`)
  }
  console.log(`spike check 8: ${40 - failures.length}/40 pages`)
  expect(failures).toEqual([])
})
