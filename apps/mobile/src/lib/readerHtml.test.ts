import { describe, it, expect } from 'vitest'
import { buildPdfEngineHtml } from './readerHtml'
import { PDF_ENGINE_SCRIPT, PDF_JS_SCRIPT } from './pdfViewerScript'

describe('PDF document (ADR-025 Phase 5 slice 4)', () => {
  const engine = buildPdfEngineHtml('https://api.test/me/books/b1/file', 'tok', { initialPage: 12, safeArea: { top: 24, bottom: 0 }, local: false })

  it('the engine page with the worker before it', () => {
    expect(engine).toContain(PDF_ENGINE_SCRIPT)
    expect(engine.indexOf(PDF_JS_SCRIPT)).toBeLessThan(engine.indexOf(PDF_ENGINE_SCRIPT))
    // The engine finds its root when it runs: the scripts come after it.
    expect(engine.indexOf('<div id="pdf-root">')).toBeLessThan(engine.indexOf(PDF_ENGINE_SCRIPT))
    expect(engine).toContain('user-scalable=yes')   // native pinch (answer 6a)
  })

  it("the bootstrap: file, token, page, local, status bar", () => {
    const json = /window\.__TS_PDF = (.*?);<\/script>/.exec(engine)![1]
    expect(JSON.parse(json)).toEqual({ url: 'https://api.test/me/books/b1/file', token: 'tok', initialPage: 12, local: false, safeTop: 24 })
  })
})
