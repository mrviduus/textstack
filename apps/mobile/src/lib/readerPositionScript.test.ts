import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reading position across a reflow, tested on the code that ships.
 *
 * The bug this locks down, reported three times and patched sixteen:
 *
 *   Open chapter one. Scroll until infinite scroll appends chapter two — the URL
 *   never changes, because the mobile reader appends into the SAME document.
 *   Read to 55% of chapter two. Change the font size.
 *
 * Typography used to be an input to the document string, so the WebView
 * reloaded with only the ROUTE chapter — chapter one — and the reader's chapter
 * fraction was re-applied to it. 55% of chapter two became 74% of chapter one,
 * the write gate was already open, and two seconds later that was the reader's
 * saved position. Locally and on the server. Unrecoverably.
 *
 * These functions live inside the HTML string handed to the WebView, so they
 * cannot be imported. They are extracted from the source and run against a fake
 * layout, the same trick `readerProgressScript.test.ts` uses — and for the same
 * reason: this is the most consequential arithmetic in the app and there is no
 * mobile e2e that reaches it.
 */

const SOURCE = readFileSync(join(__dirname, 'readerHtml.ts'), 'utf8')

/** Extract `function name(...) { ... }` by brace matching. */
function extractFunction(name: string): string {
  const start = SOURCE.search(new RegExp(`function ${name}\\s*\\(`))
  if (start < 0) throw new Error(`${name} not found in readerHtml.ts — did it get renamed?`)
  return sliceBlock(start)
}

/** Extract `window.__name = function (...) { ... };` by brace matching. */
function extractWindowFunction(name: string): string {
  const start = SOURCE.indexOf(`window.${name} = function`)
  if (start < 0) throw new Error(`${name} not found in readerHtml.ts — did it get renamed?`)
  return sliceBlock(start)
}

function sliceBlock(start: number): string {
  let depth = 0
  let seenBrace = false
  let i = start
  for (; i < SOURCE.length; i++) {
    const c = SOURCE[i]
    if (c === '{') { depth++; seenBrace = true } else if (c === '}') {
      depth--
      if (seenBrace && depth === 0) { i++; break }
    }
  }
  return SOURCE.slice(start, i)
}

const SCRIPT = [
  extractFunction('currentChapterBounds'),
  extractFunction('reportProgress'),
  extractFunction('chapterTop'),
  extractFunction('recomputeChapterTops'),
  extractFunction('chapterScrollTarget'),
  extractFunction('scrollToInstant'),
  // Reached by __textstackApplyTypography. Only *called* when a position was
  // captured, which the fake DOM cannot do — but it has to exist, or the reflow
  // path throws before it can fall back to the chapter ratio.
  extractFunction('scrollToResolvedPosition'),
  extractFunction('chapterElement'),
  extractFunction('chapterText'),
  extractFunction('locateCharOffset'),
  extractWindowFunction('__textstackApplyTypography'),
  extractWindowFunction('__textstackRestorePercent'),
  extractWindowFunction('__textstackRestoreScroll'),
].join('\n')

const VIEWPORT = 800

interface ChapterLayout { slug: string; height: number }

/**
 * A document with real geometry, which jsdom does not have: it reports 0 for
 * every offsetTop and every rect, so a layout bug is invisible there.
 *
 * Chapters are stacked in order. `scale` is what a font-size change does —
 * every chapter gets taller or shorter, and every chapter after the first one
 * moves, which is precisely what invalidates a remembered top.
 */
function makeDocument(layout: ChapterLayout[], opts: { bodyPadding?: number } = {}) {
  const pad = opts.bodyPadding ?? 0
  let scale = 1
  // What the injected stylesheet will do to the layout when it is set. The
  // ordering matters and is the point of the test: __textstackApplyTypography
  // must measure BEFORE this happens and re-anchor AFTER.
  let pendingScale = 1
  const heightOf = (c: ChapterLayout) => Math.round(c.height * scale)
  const topOf = (idx: number) => pad + layout.slice(0, idx).reduce((sum, c) => sum + heightOf(c), 0)
  const docHeight = () => pad + layout.reduce((sum, c) => sum + heightOf(c), 0)

  const win = {
    scrollY: 0,
    innerHeight: VIEWPORT,
    scrollTo(_x: number, y?: number) {
      const target = typeof y === 'number' ? y : (_x as unknown as { top: number }).top
      win.scrollY = Math.max(0, Math.min(target, Math.max(0, docHeight() - VIEWPORT)))
    },
    ReactNativeWebView: { postMessage: (m: string) => sent.push(JSON.parse(m)) },
  }
  const sent: { type: string; progress?: number; chapterSlug?: string | null; scrollY?: number }[] = []

  const elements = layout.map((c, idx) => ({
    getBoundingClientRect: () => ({ top: topOf(idx) - win.scrollY }),
  }))

  // Setting the stylesheet's text is what reflows a real document, so it is
  // what reflows this one.
  const styleEl = { id: '', _text: '', set textContent(v: string) { this._text = v; scale = pendingScale }, get textContent() { return this._text } }
  const doc = {
    documentElement: { get scrollHeight() { return docHeight() }, style: { scrollBehavior: '' } },
    body: { innerText: 'a chapter with real prose in it' },
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => styleEl,
  }

  const chapterSlugs = layout.map((c, idx) => ({ slug: c.slug, el: elements[idx], top: topOf(idx) }))

  const acks: number[] = []
  const ctx: Record<string, unknown> = {
    chapterSlugs,
    window: win,
    document: doc,
    getCurrentChapterSlug: () => null,
    ackRestore: (id: number) => acks.push(id),
    // The reader's own listener. In the WebView the scroll fires it; here we
    // call it explicitly so a test can say when it wants the report.
    lastProgress: -1,
    requestAnimationFrame: (fn: () => void) => fn(),
    isFinite,
    Math,
    JSON,
  }

  const run = (body: string) =>
    // eslint-disable-next-line no-new-func
    new Function('ctx', `with (ctx) { ${SCRIPT}; ${body} }`)(ctx)

  return {
    ctx,
    acks,
    sent,
    get scrollY() { return win.scrollY },
    scrollTo(y: number) { win.scrollY = y },
    /** What the next typography injection will do to the document. */
    reflow(factor: number) { pendingScale = factor },
    /** Reflow with no injection — for the stale-tops companion test. */
    reflowNow(factor: number) { pendingScale = factor; scale = factor },
    /** Physical top of a chapter right now, whatever the registry believes. */
    realTop: (idx: number) => topOf(idx),
    tops: () => chapterSlugs.map(c => c.top),
    report() {
      sent.length = 0
      ctx.lastProgress = -1
      run('reportProgress();')
      return sent[0] ?? null
    },
    applyTypography(restoreId: number) {
      run(`window.__textstackApplyTypography = null; ${extractWindowFunction('__textstackApplyTypography')}; window.__textstackApplyTypography('body{font-size:14px}', ${restoreId});`)
    },
    recomputeTops() { run('recomputeChapterTops();') },
    restoreScroll(offset: number, restoreId = 1) {
      run(`window.__textstackRestoreScroll(${offset}, ${restoreId});`)
      return win.scrollY
    },
    restorePercent(fraction: number, restoreId = 1) {
      run(`window.__textstackRestorePercent(${fraction}, ${restoreId});`)
      return win.scrollY
    },
  }
}

const TWO_CHAPTERS: ChapterLayout[] = [
  { slug: 'ch-1', height: 3000 },
  { slug: 'ch-2', height: 3000 },
]

describe('a font-size change mid-chapter-two', () => {
  it('keeps the reader in chapter two, at the same fraction of it', () => {
    // THE regression. Named after what it costs: reading at 55% of chapter two,
    // the reader used to be moved to 74% of chapter one and have that saved.
    const d = makeDocument(TWO_CHAPTERS)
    // 55% through chapter two: span is (6000 - 3000) - 800 = 2200.
    d.scrollTo(3000 + Math.round(0.55 * 2200))
    expect(d.report()).toMatchObject({ chapterSlug: 'ch-2' })
    expect(d.report()!.progress).toBeCloseTo(0.55, 2)

    // The font shrinks: every chapter is 20% shorter and chapter two moves up.
    d.reflow(0.8)
    d.applyTypography(9)

    // Against PHYSICAL geometry, not against what the registry believes. A
    // registry that has gone stale is self-consistent — it computes a target
    // and then reports that target back at the fraction it was asked for — so a
    // test that only compares those two numbers passes with the bug in place.
    // 55% of a chapter that is now 2400 tall and starts at 2400.
    expect(d.scrollY).toBe(d.realTop(1) + Math.round(0.55 * (2400 - VIEWPORT)))

    // And once the tops are refreshed (the ResizeObserver does this in the
    // WebView), the reader's own progress report agrees.
    d.recomputeTops()
    const after = d.report()
    expect(after).toMatchObject({ chapterSlug: 'ch-2' })
    expect(after!.progress).toBeCloseTo(0.55, 2)
    // The assertion that would have caught the bug: not chapter one, at any
    // fraction of it.
    expect(after!.chapterSlug).not.toBe('ch-1')
  })

  it('acknowledges the restore id it was given', () => {
    // The scroll it performs is indistinguishable from the reader's own on the
    // way back, so the write gate has to stay shut until this ack arrives.
    const d = makeDocument(TWO_CHAPTERS)
    d.scrollTo(4210)
    d.reflow(0.8)
    d.applyTypography(9)
    expect(d.acks).toEqual([9])
  })

  it('works from the first chapter too', () => {
    const d = makeDocument(TWO_CHAPTERS)
    d.scrollTo(Math.round(0.3 * (3000 - 800)))
    expect(d.report()).toMatchObject({ chapterSlug: 'ch-1' })

    d.reflow(1.25)
    d.applyTypography(1)

    expect(d.scrollY).toBe(Math.round(0.3 * (3750 - VIEWPORT)))
    d.recomputeTops()
    const after = d.report()
    expect(after).toMatchObject({ chapterSlug: 'ch-1' })
    expect(after!.progress).toBeCloseTo(0.3, 2)
  })
})

describe('chapter tops are recomputed, never remembered', () => {
  it('follows the chapter when a reflow moves it', () => {
    const d = makeDocument(TWO_CHAPTERS)
    expect(d.tops()).toEqual([0, 3000])
    d.reflowNow(0.8)
    d.recomputeTops()
    expect(d.tops()).toEqual([0, 2400])
    expect(d.tops()[1]).toBe(d.realTop(1))
  })

  it('mislabels the chapter if they are not — this is why the recompute exists', () => {
    // The companion to the test above: delete recomputeChapterTops and this is
    // what the reader gets. Standing at the very top of chapter two, in a
    // document that has reflowed under a registry still holding the old tops,
    // reportProgress calls it chapter one — and that slug is what gets saved.
    const d = makeDocument(TWO_CHAPTERS)
    d.reflowNow(0.8)
    d.scrollTo(d.realTop(1))          // physically at the start of chapter two
    expect(d.report()).toMatchObject({ chapterSlug: 'ch-1' })  // stale tops lie

    d.recomputeTops()
    expect(d.report()).toMatchObject({ chapterSlug: 'ch-2' })  // and now they don't
  })
})

describe('__textstackRestorePercent', () => {
  // It multiplied the CHAPTER fraction by the whole DOCUMENT's scrollHeight and
  // never subtracted the viewport, so even with one chapter loaded it landed
  // roughly innerHeight x fraction too deep, and at ~1 it clamped to the bottom.
  // Restoring by percent was never a safe fallback. chapterScrollTarget is now
  // the exact inverse of reportProgress.
  it('is the inverse of reportProgress', () => {
    const d = makeDocument(TWO_CHAPTERS)
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      d.scrollTo(0)
      d.restorePercent(fraction)
      expect(d.report()!.progress).toBeCloseTo(fraction, 2)
    }
  })

  it('does not overshoot into the next chapter at fraction 1', () => {
    // The old version multiplied by the whole document's scrollHeight, so a
    // reader who had finished chapter one reopened deep inside chapter two.
    const d = makeDocument(TWO_CHAPTERS)
    expect(d.restorePercent(1)).toBe(3000 - VIEWPORT)
  })

  it('does not land a viewport too deep in the middle of a chapter', () => {
    // The other half of the same defect: innerHeight was never subtracted.
    const d = makeDocument(TWO_CHAPTERS)
    expect(d.restorePercent(0.5)).toBe(Math.round(0.5 * (3000 - VIEWPORT)))
  })
})

describe('restores jump, they do not animate', () => {
  // Found by driving the real document in a real browser, which is the only
  // place this is visible: the fake DOM below has no CSS, and the document sets
  // `html { scroll-behavior: smooth }`.
  //
  // Under that rule window.scrollTo ANIMATES. window.scrollY still reads the
  // old position on the next line, so `ackRestore` reported a place the reader
  // was not at yet — and the animation went on firing reportProgress with
  // intermediate positions after the gate had opened, any of which the 2s
  // debounce could persist. Measured: a restore to 28793 acknowledged 15042 and
  // came to rest wherever the animation happened to be interrupted.
  //
  // This is a source assertion because the behaviour is a CSS-and-timing
  // interaction that no fake DOM reproduces.
  it('still sets scroll-behavior: smooth, which is what makes this necessary', () => {
    expect(SOURCE).toContain('scroll-behavior: smooth')
  })

  it('routes every restore through scrollToInstant', () => {
    for (const fn of ['__textstackRestoreScroll', '__textstackRestorePercent', '__textstackApplyTypography']) {
      const body = extractWindowFunction(fn)
      expect(body).toContain('scrollToInstant')
      expect(body).not.toMatch(/window\.scrollTo\(/)
    }
  })

  it('scrollToInstant disables the CSS rule around the jump', () => {
    // Not `behavior: 'instant'`: that value is not understood everywhere the
    // app runs, and an unknown value falls back to the CSS — i.e. to smooth.
    const body = extractFunction('scrollToInstant')
    expect(body).toContain("scrollBehavior = 'auto'")
    expect(body).toContain('window.scrollTo(0, y)')
    expect(body).toContain('scrollBehavior = prev')
  })

  it('reads the saved offset in the same space reportProgress wrote it', () => {
    // reportProgress emits `scrollY: relY`, chapter-relative. The restore used
    // to treat that number as a document coordinate, which agreed only while
    // the first chapter's recorded top was zero — it is now the real top of the
    // chapter element, which sits below the page padding.
    const d = makeDocument([{ slug: 'ch-1', height: 3000 }], { bodyPadding: 52 })
    d.restoreScroll(1200)
    expect(d.report()!.scrollY).toBe(1200)
  })
})
