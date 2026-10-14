import { expect, test, type Page } from '@playwright/test'
import type { Locator, ReaderEngine } from '../src/api'

// Rules E25–E27 (docs/05-features/reader-engine.md): what jsdom cannot check, on real chapters.

declare global {
  interface Window {
    engine: ReaderEngine
    pg: {
      sameText(): boolean
      probe(): number | null
      offsetOf(loc: Locator): number | null
      yOf(offset: number): number
      lineHeight(): number
      placeAt(offset: number): Locator
      text(): string
    }
  }
}

const CHAPTERS = ['moby-dick-5', 'speckled-band', 'ulysses-15']
const STOPS = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]

async function openChapter(page: Page, chapter: string) {
  await page.goto(`/?chapter=${chapter}`)
  await page.waitForSelector('body[data-ready]')
  expect(await page.evaluate(() => window.pg.sameText())).toBe(true)
}

/** The reader scrolls to a fraction of the chapter; resolves once the engine has read it. */
async function readerScrolls(page: Page, f: number) {
  await page.evaluate(async (f) => {
    const seen = new Promise<void>((r) => { const off = window.engine.on('relocated', (e) => { if (e.reason === 'scroll') { off(); r() } }) })
    window.scrollTo(0, Math.round(f * (document.documentElement.scrollHeight - innerHeight)))
    await seen
  }, f)
}

for (const chapter of CHAPTERS) {
  test(`E25 the reading line is the web probe's line: ${chapter}`, async ({ page }) => {
    await openChapter(page, chapter)
    for (const f of STOPS) {
      await readerScrolls(page, f)
      const r = await page.evaluate(() => {
        const engine = window.pg.offsetOf(window.engine.current()!)!
        const probe = window.pg.probe()!
        return { dy: Math.abs(window.pg.yOf(engine) - window.pg.yOf(probe)), line: window.pg.lineHeight() }
      })
      expect(r.dy, `at ${f}`).toBeLessThan(r.line)
    }
  })
}

for (const chapter of CHAPTERS) {
  test(`E26 goTo puts the place on the reading line, and current() stays it: ${chapter}`, async ({ page }) => {
    await openChapter(page, chapter)
    for (const f of STOPS) {
      await readerScrolls(page, f)
      const saved = await page.evaluate(() => window.engine.current()!)
      await readerScrolls(page, f > 0.5 ? 0.05 : 0.95)   // away, then back
      const r = await page.evaluate(async (saved) => {
        await window.engine.goTo(saved)
        const dy = Math.abs(window.pg.yOf(window.pg.offsetOf(saved)!) - (scrollY + innerHeight * 0.25))
        return { dy, line: window.pg.lineHeight(), now: window.engine.current()!.text }
      }, saved)
      expect(r.dy, `at ${f}`).toBeLessThan(r.line / 2)   // the reading line crosses the place's line
      expect(r.now, `at ${f}`).toEqual(saved.text)
    }
  })
}

test('E27 reading the place on a scroll costs under 4 ms a frame on a long chapter, CPU 4x slower', async ({ page }) => {
  await openChapter(page, 'ulysses-15')   // 2760 table cells
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const ms = await page.evaluate(async () => {
    // A frame callback queued before the engine's: from it to the engine's 'scroll' is the engine's frame.
    let t0 = 0
    addEventListener('scroll', () => requestAnimationFrame(() => { t0 = performance.now() }), { capture: true })
    const times: number[] = []
    for (let i = 1; i <= 40; i++) {
      await new Promise<void>((r) => {
        const off = window.engine.on('relocated', (e) => { if (e.reason === 'scroll') { times.push(performance.now() - t0); off(); r() } })
        window.scrollTo(0, (i / 41) * (document.documentElement.scrollHeight - innerHeight))
      })
    }
    return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]
  })
  console.log(`E27 median engine frame on ulysses-15, CPU 4x: ${ms.toFixed(2)} ms`)
  expect(ms).toBeLessThan(4)   // a quarter of a 60 fps frame; shared CI runners are slow
})

test('E29 the chapter growing above the reading line is a reflow, never the reader scrolling; the engine alone re-anchors', async ({ page }) => {
  await openChapter(page, 'moby-dick-5')
  await readerScrolls(page, 0.5)
  const r = await page.evaluate(async () => {
    const before = window.engine.current()!.text
    const reasons: string[] = []
    window.engine.on('relocated', (e) => reasons.push(e.reason))
    // Like an image loading above the reader: the browser's scroll anchoring moves scrollTop by itself.
    const above = Array.from(document.querySelectorAll<HTMLElement>('#reader p')).filter((p) => p.getBoundingClientRect().bottom < 0)
    const top = scrollY
    above[above.length - 1].style.paddingTop = '300px'
    void document.body.offsetHeight   // the host reads layout at once: a browser anchor would move now
    const anchored = scrollY !== top
    await new Promise((r) => setTimeout(r, 300))
    return { anchored, reasons, same: JSON.stringify(window.engine.current()!.text) === JSON.stringify(before) }
  })
  expect(r.anchored, 'scroll anchoring is off: no race with the engine').toBe(false)
  expect(r.reasons).toEqual(['reflow'])
  expect(r.same).toBe(true)
})

test('E30 a style change is one \'style\' relocation: the browser never scrolls the page before the engine re-anchors', async ({ page }) => {
  await openChapter(page, 'moby-dick-5')
  await readerScrolls(page, 0.5)
  const r = await page.evaluate(async () => {
    const reasons: string[] = []
    window.engine.on('relocated', (e) => reasons.push(e.reason))
    const top = scrollY
    window.engine.setStyle({ fontSize: 26 })
    void document.body.offsetHeight   // the host reads layout at once: a browser anchor would move now
    const anchored = scrollY !== top
    await new Promise((r) => setTimeout(r, 300))
    return { anchored, reasons }
  })
  expect(r.anchored, 'no page-level scroll anchoring: its scroll reads as the reader (web saved it)').toBe(false)
  expect(r.reasons).toEqual(['style'])
})

test('E26 a place that starts on a soft hyphen lands on the reading line too', async ({ page }) => {
  await openChapter(page, 'moby-dick-5-shy')   // U+00AD in words of 8+ letters, as extraction adds them
  const r = await page.evaluate(async () => {
    const text = window.pg.text()
    const dys: number[] = []
    for (let i = 1; i <= 10; i++) {
      const at = text.indexOf('\u00AD', (i / 11) * text.length)
      await window.engine.goTo(window.pg.placeAt(at))
      dys.push(Math.abs(window.pg.yOf(at) - (scrollY + innerHeight * 0.25)))
    }
    return { worst: Math.max(...dys), line: window.pg.lineHeight() }
  })
  expect(r.worst).toBeLessThan(r.line / 2)
})

test('E43 a font change while a drawer covers the reading line keeps the place (H2b)', async ({ page }) => {
  await openChapter(page, 'moby-dick-5')
  await readerScrolls(page, 0.5)
  const r = await page.evaluate(async () => {
    const before = window.engine.current()!
    // Like web's settings drawer: over the whole reading line, with text of its own under the caret.
    const drawer = document.createElement('div')
    drawer.textContent = 'Font size Line height Font family '.repeat(40)
    Object.assign(drawer.style, { position: 'fixed', inset: '0', background: 'white', zIndex: '10' })
    document.body.append(drawer)
    await new Promise((r) => {
      const off = window.engine.on('relocated', (e) => { if (e.reason === 'style') { off(); r(null) } })
      window.engine.setStyle({ fontSize: 26 })
    })
    const now = window.engine.current()!
    const dy = Math.abs(window.pg.yOf(window.pg.offsetOf(before)!) - (scrollY + innerHeight * 0.25))
    drawer.remove()
    return { same: JSON.stringify(now.text) === JSON.stringify(before.text), dy, line: window.pg.lineHeight() }
  })
  expect(r.same).toBe(true)
  expect(r.dy).toBeLessThan(r.line)   // still on the reading line after the reflow
})
