import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { buildReaderHtml } from './readerHtml'

/**
 * A highlight paints where its words are on screen — in the real reader
 * document, through the same `renderHighlight` RN injects.
 *
 * The overlayer stores rects in DOCUMENT coordinates and counter-translates
 * its <svg> by -scrollY (packages/reader-overlay). That is only right when the
 * svg is anchored to the viewport — web puts it in a position:fixed host. The
 * phone appended it to <body> as position:absolute, which already scrolls with
 * the page, so the shift was applied twice: every highlight below the first
 * screen was drawn scrollY pixels above its text, off screen.
 *
 * jsdom has no layout, so the rect and the scroll are stubbed and the screen
 * position is computed from the svg's own styles — the two CSS facts in play.
 */

const { JSDOM, VirtualConsole } = createRequire(__filename)('jsdom') as {
  JSDOM: new (html: string, opts: Record<string, unknown>) => { window: Window & typeof globalThis }
  VirtualConsole: new () => unknown
}

const SCROLL_Y = 1200
const WORD_VIEWPORT_TOP = 300 // where the word is on screen, i.e. getClientRects().top

function openReader() {
  const html = '<p>She sat in the garden and watched the moon.</p><p>Then she rose.</p>'
  const dom = new JSDOM(buildReaderHtml(html, undefined, 'ch-6'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(win: Window & typeof globalThis & { ReactNativeWebView: unknown }) {
      win.ReactNativeWebView = { postMessage: () => {} }
      Object.defineProperty(win, 'scrollY', { configurable: true, get: () => SCROLL_Y })
      Object.defineProperty(win, 'pageYOffset', { configurable: true, get: () => SCROLL_Y })
      const rect = { x: 20, y: WORD_VIEWPORT_TOP, left: 20, top: WORD_VIEWPORT_TOP, right: 80, bottom: WORD_VIEWPORT_TOP + 20, width: 60, height: 20 }
      win.Range.prototype.getClientRects = function () { return [rect] as unknown as DOMRectList }
      win.Range.prototype.getBoundingClientRect = function () { return rect as DOMRect }
    },
  })
  return dom.window
}

/** On-screen top of the first painted rect, from the svg's position and transform. */
function paintedViewportTop(w: Window): number {
  const svg = w.document.querySelector('svg[data-reader-overlay]') as SVGSVGElement
  const rect = svg.querySelector('rect')!
  const translateY = Number(/translate\([^,]+,\s*(-?[\d.]+)px\)/.exec(svg.style.transform)![1])
  const y = Number(rect.getAttribute('y')) + translateY
  // fixed: the svg's origin is the viewport's. absolute (in an unpositioned
  // body): the document's, which is scrollY above the viewport's.
  return svg.style.position === 'fixed' ? y : y - SCROLL_Y
}

describe('renderHighlight paints over its words', () => {
  it('scrolled down the chapter, the highlight lands on the word, not scrollY above it', () => {
    const w = openReader()
    ;(w as unknown as { eval: (s: string) => void }).eval(
      `renderHighlight("h1", ${JSON.stringify(JSON.stringify({ prefix: 'She sat in the ', exact: 'garden', suffix: ' and' }))}, "yellow", "garden")`,
    )
    expect(w.document.querySelectorAll('svg[data-reader-overlay] rect').length).toBe(1)
    expect(paintedViewportTop(w)).toBe(WORD_VIEWPORT_TOP)
  })
})
