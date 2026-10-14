import { describe, it, expect } from 'vitest'
import { buildReaderHtml, buildPdfEngineHtml, buildPdfViewerHtml } from './readerHtml'
import { PDF_ENGINE_SCRIPT, PDF_VIEWER_SCRIPT, PDF_WORKER_SCRIPT } from './pdfViewerScript'
import { READER_SELECTION_BRIDGE } from './readerBridge'

// Second argument is the theme, and its default is load-bearing — passing {}
// strips fontFamily and throws inside buildFontFace.
const html = buildReaderHtml('<p>Hello</p><img src="a.png" alt="a">')

/**
 * Every script this file emits lives inside <head>, so anything running at parse
 * time sees `document.body === null`. That cost the image lightbox: its setup
 * ended with `document.body.addEventListener(...)`, which threw on every reader
 * load and left tapping an image doing nothing — silently, on every book with
 * images, for as long as the code existed.
 *
 * A general "nothing touches document.body before <body>" rule is what you want
 * here and is not what these tests are: most body access in the head script sits
 * inside functions that run later, and telling those apart from immediate
 * statements needs a parser, not a string search. A version that tried flagged
 * `document.body.appendChild(sep)` — which is fine — on its first run. So this
 * pins the one construct that broke instead.
 */
describe('reader document', () => {
  const headEnd = html.lastIndexOf('</head>')
  const head = html.slice(0, headEnd)

  it('emits its scripts inside head, which is what makes the rest of this matter', () => {
    expect(headEnd).toBeGreaterThan(-1)
    expect(head).toContain('<script>')
  })

  it('delegates the image lightbox on document, not on a body that does not exist yet', () => {
    const start = head.indexOf('function isLightboxImg')
    expect(start).toBeGreaterThan(-1)
    const lightbox = head.slice(start)
    expect(lightbox).toContain("document.addEventListener('click'")
    expect(lightbox).not.toContain('document.body.addEventListener')
  })
})

describe('PDF documents (ADR-025 Phase 5 slice 4)', () => {
  const engine = buildPdfEngineHtml('https://api.test/me/books/b1/file', 'tok', { initialPage: 12, safeArea: { top: 24, bottom: 0 }, local: false })
  const old = buildPdfViewerHtml('https://api.test/me/books/b1/file', 'tok', { initialPage: 12 })

  it('the engine document: the engine page with the worker before it, no old selection bridge or viewer', () => {
    expect(engine).toContain(PDF_ENGINE_SCRIPT)
    expect(engine.indexOf(PDF_WORKER_SCRIPT)).toBeLessThan(engine.indexOf(PDF_ENGINE_SCRIPT))
    expect(engine).not.toContain(PDF_VIEWER_SCRIPT)
    expect(engine).not.toContain(READER_SELECTION_BRIDGE)
    // The engine finds its root when it runs: the scripts come after it.
    expect(engine.indexOf('<div id="pdf-root">')).toBeLessThan(engine.indexOf(PDF_ENGINE_SCRIPT))
    expect(engine).toContain('user-scalable=yes')   // native pinch (answer 6a)
  })

  it("the engine document's bootstrap: file, token, page, local, status bar", () => {
    const json = /window\.__TS_PDF = (.*?);<\/script>/.exec(engine)![1]
    expect(JSON.parse(json)).toEqual({ url: 'https://api.test/me/books/b1/file', token: 'tok', initialPage: 12, local: false, safeTop: 24 })
  })

  it('the old viewer (flag off) still loads its worker before it, and its bridge', () => {
    expect(old.indexOf(PDF_WORKER_SCRIPT)).toBeLessThan(old.indexOf(PDF_VIEWER_SCRIPT))
    expect(old).toContain(READER_SELECTION_BRIDGE)
    expect(old).not.toContain(PDF_ENGINE_SCRIPT)
  })
})
