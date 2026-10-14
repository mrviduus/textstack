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
      offLine(offset: number, y: number): number
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
    try {
      const acked = await new Promise<boolean>((r) => {
        const off = window.engine.on('relocated', (e) => { if (e.reason === 'style') { off(); r(true) } })
        setTimeout(() => { off(); r(false) }, 2000)
        window.engine.setStyle({ fontSize: 26 })
      })
      const now = window.engine.current()!
      const dy = Math.abs(window.pg.yOf(window.pg.offsetOf(before)!) - (scrollY + innerHeight * 0.25))
      return { acked, same: JSON.stringify(now.text) === JSON.stringify(before.text), dy, line: window.pg.lineHeight() }
    } finally {
      drawer.remove()
    }
  })
  expect(r.acked, "the style change's 'style' relocation").toBe(true)
  expect(r.same).toBe(true)
  expect(r.dy).toBeLessThan(r.line)   // still on the reading line after the reflow
})

/** Something over the reading line with text of its own (a popup, a drawer): the caret there is not the chapter's. */
async function cover(page: Page, box: { top: string; height: string }) {
  await page.evaluate((box) => {
    const el = document.createElement('div')
    el.id = 'cover'
    el.textContent = 'Translate Explain Highlight Copy '.repeat(40)
    Object.assign(el.style, { position: 'fixed', left: '0', right: '0', top: box.top, height: box.height, overflow: 'hidden', background: 'white', zIndex: '10' })
    document.body.append(el)
  }, box)
}
const uncover = (page: Page) => page.evaluate(() => document.getElementById('cover')?.remove())

/** How far the engine's place is from the reading line, by the text's own boxes (no hit test). */
const placeOffLine = (page: Page) => page.evaluate(() => ({
  dy: Math.abs(window.pg.yOf(window.pg.offsetOf(window.engine.current()!)!) - (scrollY + innerHeight * 0.25)),
  line: window.pg.lineHeight(),
}))

test('E45 a popup over the reading line while the reader scrolls: every scroll reads the text truly on the line', async ({ page }) => {
  await openChapter(page, 'moby-dick-5')
  await readerScrolls(page, 0.3)
  await cover(page, { top: '20%', height: '10%' })   // a word popup's band, across the reading line
  try {
    for (const f of [0.35, 0.5, 0.65]) {
      await readerScrolls(page, f)
      const r = await placeOffLine(page)
      expect(r.dy, `at ${f}`).toBeLessThan(r.line)
    }
  } finally {
    await uncover(page)
  }
})

/**
 * E45 under a popup band, at 24 stops: the rule, checked by brute force over every line box of the chapter.
 * Text on the reading line is found on it (0 away); with none (a gap, beside a figure), the text found is the
 * nearest above.
 */
async function expectCoveredLineRule(page: Page) {
  // Text = visible characters: the line boxes of every run of them (whitespace, soft hyphens, zero-width
  // spaces and word joiners are not text), in page coordinates; a cover does not move them.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('#reader')!.firstElementChild!, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    const lines: [number, number][] = []
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      for (const m of n.data.matchAll(/[^\s­​⁠﻿]+/g)) {
        range.setStart(n, m.index!)
        range.setEnd(n, m.index! + m[0].length)
        for (const b of Array.from(range.getClientRects())) if (b.width > 0 && b.height > 0) lines.push([b.top + scrollY, b.bottom + scrollY])
      }
    }
    Object.assign(window, { textLines: lines })
  })
  await cover(page, { top: '20%', height: '10%' })
  try {
    for (let i = 1; i <= 24; i++) {
      await readerScrolls(page, i / 25)
      const r = await page.evaluate(() => {
          const at = window.pg.offsetOf(window.engine.current()!)!
          const y = scrollY + innerHeight * 0.25
          let above = Infinity
          let onLine = false
          for (const [top, bottom] of (window as unknown as { textLines: [number, number][] }).textLines) {
            if (top <= y && y < bottom) onLine = true
            else if (bottom <= y) above = Math.min(above, y - bottom)
          }
          return { off: window.pg.offLine(at, y), want: onLine ? 0 : above, y, found: window.pg.text().slice(at, at + 40) }
        })
        expect(Math.abs(r.off - r.want), `at ${i}/25: reading line y=${r.y}, found ${JSON.stringify(r.found)} ${r.off} away, the nearest text ${r.want}`).toBeLessThan(1)
    }
  } finally {
    await uncover(page)
  }
}

// Font metrics move where floats and gaps fall (CI's Linux fonts failed where the Mac passed): several fonts.
for (const [font, width] of ['Georgia, serif', 'serif', 'sans-serif', 'monospace', 'Verdana'].flatMap((f) => [[f, 412], [f, 600]] as const)) {
  test(`E45 under a popup, floated figures with captions beside the reading line still read the text on the line: ${font} @${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 839 })
    await openChapter(page, 'moby-dick-5-float')   // a float every third paragraph: caption text sits below the lines after it
    await page.addStyleTag({ content: `#reader { font-family: ${font} !important }` })
    await expectCoveredLineRule(page)
  })
}

test('E45 under a popup, hidden blocks and long collapsed whitespace before the line do not break the search', async ({ page }) => {
  await openChapter(page, 'moby-dick-5-hidden')   // display:none notes and 300-space runs: characters with no box
  await expectCoveredLineRule(page)
})

for (const width of [412, 600]) {
  test(`E45 under a popup, a whitespace and word-joiner run right before hidden text does not break the search @${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 839 })
    // Every paragraph ends in 1500 spaces and U+2060, then a display:none note: most midpoints of the search
    // land in such a run, whose next visible character is past the hidden note.
    await openChapter(page, 'moby-dick-5-hidden-run')
    await expectCoveredLineRule(page)
  })
}

test('E45 a covered reading line in a gap between blocks reads the text just above with a bounded search, not a scan of the chapter', async ({ page }) => {
  await openChapter(page, 'ulysses-15')   // 2760 table cells: a scan of every text node is thousands of box reads
  await cover(page, { top: '20%', height: '10%' })
  try {
    const r = await page.evaluate(async () => {
      // A gap between two blocks, put on the reading line.
      const blocks = Array.from(document.querySelectorAll<HTMLElement>('#reader p, #reader tr'))
        .map((el) => el.getBoundingClientRect()).map((b) => ({ top: b.top + scrollY, bottom: b.bottom + scrollY }))
        .sort((a, b) => a.top - b.top)
      const i = blocks.findIndex((b, k) => k > 50 && blocks[k + 1] && blocks[k + 1].top - b.bottom > 6)
      const gap = (blocks[i].bottom + blocks[i + 1].top) / 2
      let reads = 0
      const own = Range.prototype.getClientRects
      Range.prototype.getClientRects = function () { reads++; return own.call(this) }
      try {
        await new Promise<void>((done) => {
          const off = window.engine.on('relocated', (e) => { if (e.reason === 'scroll') { off(); done() } })
          window.scrollTo(0, gap - innerHeight * 0.25)
        })
      } finally {
        Range.prototype.getClientRects = own
      }
      return { reads, ...((): { dy: number; line: number } => ({
        dy: window.pg.yOf(window.pg.offsetOf(window.engine.current()!)!) - (scrollY + innerHeight * 0.25),
        line: window.pg.lineHeight(),
      }))() }
    })
    expect(r.reads).toBeLessThan(100)
    expect(r.dy, 'the text just above the line').toBeLessThan(0)
    expect(-r.dy).toBeLessThan(3 * r.line)
  } finally {
    await uncover(page)
  }
})

test('E45 the reader scrolls under a drawer, then changes the font: the text that was on the line stays on it', async ({ page }) => {
  await openChapter(page, 'moby-dick-5')
  await readerScrolls(page, 0.5)
  await cover(page, { top: '0', height: '100%' })
  let under: Locator
  try {
    await readerScrolls(page, 0.52)   // behind the drawer: the caret at the reading line lands on the drawer
    under = await page.evaluate(() => window.engine.current()!)
    const acked = await page.evaluate(() => new Promise<boolean>((r) => {
      const off = window.engine.on('relocated', (e) => { if (e.reason === 'style') { off(); r(true) } })
      setTimeout(() => { off(); r(false) }, 2000)
      window.engine.setStyle({ fontSize: 26 })
    }))
    expect(acked, "the style change's 'style' relocation").toBe(true)
  } finally {
    await uncover(page)
  }
  expect(await page.evaluate(() => window.engine.current()!.text)).toEqual(under.text)
  const r = await placeOffLine(page)
  expect(r.dy).toBeLessThan(r.line)
})
