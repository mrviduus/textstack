import { expect, test, type Page } from '@playwright/test'
import type { ReaderEngine } from '../src/api'

// The fixed layout (PDF) on the committed fixture (pdf/fixture.pdf, 40 Letter pages) in Chromium:
// what jsdom cannot check (E33, E35, E36 in docs/05-features/reader-engine.md).

declare global {
  interface Window {
    engine: ReaderEngine
    pdfPage: { length: number; reads: [number, number][]; errors: unknown[]; opened: string; pageCount(): number; canvases(): number[]; top(n: number): number }
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
