import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reading position across a reflow, tested on the code that ships.
 *
 * The history (ADR-015): typography used to be an input to the document string,
 * so a font-size change reloaded the WebView and re-applied a chapter fraction —
 * and while the reader still appended chapters into one document, that fraction
 * could belong to a different chapter than the one rebuilt (55% of chapter two
 * became 74% of chapter one, then got saved). The document holds one chapter
 * now (2026-10-03), and typography is injected into the live document, which
 * re-anchors the reader in place.
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
/** The end-of-chapter block under the chapter — part of the document, not of the chapter. */
const END_BLOCK = 400

/**
 * A document with real geometry, which jsdom does not have: it reports 0 for
 * every rect, so a layout bug is invisible there. One chapter, then the
 * end-of-chapter block. `scale` is what a font-size change does to the chapter.
 */
function makeDocument(height: number, opts: { bodyPadding?: number } = {}) {
  const pad = opts.bodyPadding ?? 0
  let scale = 1
  // What the injected stylesheet will do to the layout when it is set. The
  // ordering matters and is the point of the test: __textstackApplyTypography
  // must measure BEFORE this happens and re-anchor AFTER.
  let pendingScale = 1
  const chapterHeight = () => Math.round(height * scale)
  const docHeight = () => pad + chapterHeight() + END_BLOCK

  const sent: { type: string; progress?: number; chapterSlug?: string | null; scrollY?: number }[] = []
  const win = {
    scrollY: 0,
    innerHeight: VIEWPORT,
    scrollTo(_x: number, y?: number) {
      const target = typeof y === 'number' ? y : (_x as unknown as { top: number }).top
      win.scrollY = Math.max(0, Math.min(target, Math.max(0, docHeight() - VIEWPORT)))
    },
    ReactNativeWebView: { postMessage: (m: string) => sent.push(JSON.parse(m)) },
  }

  const el = {
    getBoundingClientRect: () => ({ top: pad - win.scrollY, bottom: pad + chapterHeight() - win.scrollY }),
  }

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

  const acks: number[] = []
  const ctx: Record<string, unknown> = {
    tsChapter: { slug: 'ch-1', el },
    window: win,
    document: doc,
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
    acks,
    get scrollY() { return win.scrollY },
    scrollTo(y: number) { win.scrollY = y },
    /** What the next typography injection will do to the document. */
    reflow(factor: number) { pendingScale = factor },
    /** Reflow with no injection — an image or a webfont landing. */
    reflowNow(factor: number) { pendingScale = factor; scale = factor },
    chapterHeight,
    report() {
      sent.length = 0
      ctx.lastProgress = -1
      run('reportProgress();')
      return sent[0] ?? null
    },
    applyTypography(restoreId: number) {
      run(`window.__textstackApplyTypography('body{font-size:14px}', ${restoreId});`)
    },
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

describe('a font-size change mid-chapter', () => {
  it('keeps the reader at the same fraction of the chapter', () => {
    const d = makeDocument(3000)
    d.scrollTo(Math.round(0.3 * (3000 - VIEWPORT)))
    expect(d.report()).toMatchObject({ chapterSlug: 'ch-1' })

    d.reflow(1.25)
    d.applyTypography(1)

    // Against PHYSICAL geometry: 30% of a chapter that is now 3750 tall.
    expect(d.scrollY).toBe(Math.round(0.3 * (3750 - VIEWPORT)))
    const after = d.report()
    expect(after).toMatchObject({ chapterSlug: 'ch-1' })
    expect(after!.progress).toBeCloseTo(0.3, 2)
  })

  it('acknowledges the restore id it was given', () => {
    // The scroll it performs is indistinguishable from the reader's own on the
    // way back, so the write gate has to stay shut until this ack arrives.
    const d = makeDocument(3000)
    d.scrollTo(1210)
    d.reflow(0.8)
    d.applyTypography(9)
    expect(d.acks).toEqual([9])
  })
})

describe('the restore ack carries the landing (R4 bug 4)', () => {
  // ackRestore itself, not the stub above: chapter-relative scrollY, then a report RN can book as
  // the landing even when the restore moved less than the report threshold.
  function run(scrollY: number, lastProgress: number) {
    const sent: { type: string; scrollY?: number; progress?: number }[] = []
    const pad = 120
    const win = { scrollY, innerHeight: VIEWPORT, ReactNativeWebView: { postMessage: (m: string) => sent.push(JSON.parse(m)) } }
    const ctx: Record<string, unknown> = {
      tsChapter: { slug: 'ch-1', el: { getBoundingClientRect: () => ({ top: pad - win.scrollY, bottom: pad + 3000 - win.scrollY }) } },
      window: win,
      document: { documentElement: { scrollHeight: pad + 3000 + END_BLOCK }, body: { innerText: 'prose' } },
      lastProgress, isFinite, Math, JSON,
    }
    const script = [extractFunction('currentChapterBounds'), extractFunction('reportProgress'), extractFunction('ackRestore')].join('\n')
    // eslint-disable-next-line no-new-func
    new Function('ctx', `with (ctx) { ${script}; ackRestore(7); }`)(ctx)
    return sent
  }

  it('scrollY is chapter-relative, like a progress report', () => {
    expect(run(620, 0)[0]).toMatchObject({ type: 'restored', restoreId: 7, scrollY: 500 })
  })

  it('a landing that moved under the threshold is still reported, after the ack', () => {
    const sent = run(620, 500 / (3000 - VIEWPORT))
    expect(sent.map(m => m.type)).toEqual(['restored', 'progress'])
    expect(sent[1].scrollY).toBe(500)
  })
})

describe('chapter bounds are measured, never remembered', () => {
  it('follows the chapter when the layout moves under it', () => {
    // An image or a webfont landing fires no message to RN. A remembered height
    // would keep reporting against the old geometry.
    const d = makeDocument(3000)
    d.reflowNow(0.8)
    d.scrollTo(d.chapterHeight() - VIEWPORT)
    expect(d.report()!.progress).toBe(1)
  })
})

describe('__textstackRestorePercent', () => {
  // It once multiplied the CHAPTER fraction by the whole DOCUMENT's
  // scrollHeight and never subtracted the viewport. chapterScrollTarget is now
  // the exact inverse of reportProgress.
  it('is the inverse of reportProgress', () => {
    const d = makeDocument(3000)
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      d.scrollTo(0)
      d.restorePercent(fraction)
      expect(d.report()!.progress).toBeCloseTo(fraction, 2)
    }
  })

  it('does not overshoot into the end-of-chapter block at fraction 1', () => {
    const d = makeDocument(3000)
    expect(d.restorePercent(1)).toBe(3000 - VIEWPORT)
  })

  it('does not land a viewport too deep in the middle of a chapter', () => {
    const d = makeDocument(3000)
    expect(d.restorePercent(0.5)).toBe(Math.round(0.5 * (3000 - VIEWPORT)))
  })
})

describe('restores jump, they do not animate', () => {
  // Found by driving the real document in a real browser, which is the only
  // place this is visible: the fake DOM has no CSS, and the document sets
  // `html { scroll-behavior: smooth }`.
  //
  // Under that rule window.scrollTo ANIMATES. window.scrollY still reads the
  // old position on the next line, so `ackRestore` reported a place the reader
  // was not at yet — and the animation went on firing reportProgress with
  // intermediate positions after the gate had opened, any of which the 2s
  // debounce could persist.
  //
  // This is a source assertion because the behaviour is a CSS-and-timing
  // interaction that no fake DOM reproduces.
  it('the document never makes scrolling smooth globally (it turned every restore into an animation)', () => {
    expect(SOURCE).not.toMatch(/scroll-behavior:\s*smooth/)
  })

  it('routes every restore through scrollToInstant', () => {
    for (const fn of ['__textstackRestoreScroll', '__textstackRestorePercent', '__textstackApplyTypography']) {
      const body = extractWindowFunction(fn)
      expect(body).toContain('scrollToInstant')
      expect(body).not.toMatch(/window\.scrollTo\(/)
    }
  })

  it('scrollToInstant is a plain jump', () => {
    expect(extractFunction('scrollToInstant')).toContain('window.scrollTo(0, y)')
  })

  it('reads the saved offset in the same space reportProgress wrote it', () => {
    // reportProgress emits `scrollY: relY`, chapter-relative. The chapter
    // element sits below the page padding, so the restore adds its top back.
    const d = makeDocument(3000, { bodyPadding: 52 })
    d.restoreScroll(1200)
    expect(d.report()!.scrollY).toBe(1200)
  })
})
