// @vitest-environment jsdom
import { Script, runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { formatsJs, html } from './carrier.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated'

// #1128 QA: the format readers ride in the page's one <script> as strings (`formatsJs`), and the
// whole page goes through `html()`: both from carrier.mjs, the module build.mjs writes the page with.
const NONCE = 'q7Rk2mW9xLpA4vBn8cZt0g=='

/** The page's script elements as an HTML parser sees them (DOMParser: no script runs). */
const scriptsOf = (page: string) => [...new DOMParser().parseFromString(page, 'text/html').querySelectorAll('script')].map((s) => s.textContent ?? '')

// Byte sequences that end or bend a script element, or a JS string, if the escape ever stops covering them.
const VECTORS = [
  '</script>', '</SCRIPT >', '</script\t', '</script/', '</sCrIpT\n>', '<!--', '<!-- <script>', '<!--<script></script>-->',
  '<script>', '-->', ']]>', '<![CDATA[', '\u2028', '\u2029', '\\', '\\</script>', '\\u003c/script>', '"', "'", '`', '${x}',
  '\ud800', '\udfff', '\u0000', '\r\n', '</style>', '</body></html>', '<\\/script>',
]

describe('formatsJs + html (carrier.mjs)', () => {
  it('hostileVectors_NeverEndOrBendTheScriptElement_AndRoundTripExactly', () => {
    for (const v of VECTORS) {
      const chunk = `window.__tsFormats.x = ${JSON.stringify(v)}; // ${v}`
      const page = html(formatsJs({ x: chunk }) + 'var after = 1;\n')
      const scripts = scriptsOf(page)
      expect(scripts, JSON.stringify(v)).toHaveLength(1)
      // The parser's script text is exactly what build.mjs meant to run: the carrier decodes back to the chunk.
      const ctx: { __TS_FORMATS?: Record<string, string>; after?: number } = {}
      runInNewContext(scripts[0], ctx)
      expect(ctx.__TS_FORMATS?.x, JSON.stringify(v)).toBe(chunk)
      expect(ctx.after, JSON.stringify(v)).toBe(1)
    }
  })

  it('carriedText_HasNoRawLessThan_WhateverTheChunk', () => {
    const all = VECTORS.join('')
    expect(formatsJs({ a: all, b: `${all}\n${all}` })).not.toContain('<')
  })
})

describe('the committed page, as an HTML parser reads it', () => {
  it('oneScript_CarriesEveryFormatReader_EachValidJs', () => {
    const scripts = scriptsOf(v2ReaderPageHtml(NONCE))
    expect(scripts).toHaveLength(1)
    // The script ends where the page ends: nothing of it spilled into the document or was cut short.
    expect(scripts[0].trimEnd().endsWith('})();')).toBe(true)
    const carrier = scripts[0].slice(0, scripts[0].indexOf('};\n') + 3)
    const ctx: { __TS_FORMATS?: Record<string, string> } = {}
    runInNewContext(carrier, ctx)
    expect(Object.keys(ctx.__TS_FORMATS ?? {}).sort()).toEqual(['cbz', 'fb2', 'mobi', 'pdf', 'pdfcmaps'])
    for (const [k, js] of Object.entries(ctx.__TS_FORMATS!)) {
      expect(() => new Script(js), k).not.toThrow()
      expect(js, k).toContain(`window.__tsFormats.${k} = {`)
    }
  })
})
