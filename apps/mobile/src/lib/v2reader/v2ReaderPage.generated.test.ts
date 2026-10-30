import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { v2ReaderPageHtml } from './v2ReaderPage.generated'

const NONCE = 'q7Rk2mW9xLpA4vBn8cZt0g=='

describe('v2ReaderPageHtml', () => {
  it('generatedSource_CarriesOnlyThePlaceholder_NoLiteralNonce', () => {
    const src = readFileSync(resolve(__dirname, 'v2ReaderPage.generated.ts'), 'utf8')
    expect(src.match(/'nonce-[^']*'/g)).toEqual(["'nonce-__V2_READER_NONCE__'"])
    expect(src.match(/nonce=\\"[^\\]*\\"/g)).toEqual(['nonce=\\"__V2_READER_NONCE__\\"'])
  })

  it('validNonce_FillsTheCspAndTheScriptTag_ExactlyTwice', () => {
    const html = v2ReaderPageHtml(NONCE)
    expect(html.split(NONCE)).toHaveLength(3)
    expect(html).toContain(`script-src 'nonce-${NONCE}'`)
    expect(html).toContain(`<script nonce="${NONCE}">`)
    expect(html).not.toContain('__V2_READER_NONCE__')
  })

  it('weakOrUnsafeNonce_Throws', () => {
    for (const bad of ['', 'tsfoliate', 'a'.repeat(15), `${'a'.repeat(16)}"><script>`, `${'a'.repeat(16)}'`])
      expect(() => v2ReaderPageHtml(bad), bad).toThrow()
  })

  it('nonceShapes_PaddedBase64AndHexAccepted_InjectionShapesRejected', () => {
    for (const ok of ['a'.repeat(16), NONCE, 'ab'.repeat(16), 'A-_b'.repeat(6)]) expect(() => v2ReaderPageHtml(ok), ok).not.toThrow()
    for (const bad of [`${'a'.repeat(16)}\n`, ` ${'a'.repeat(16)}`, `${'a'.repeat(16)}===`, `${'a'.repeat(16)}$&`, `${'a'.repeat(16)}; script-src *`])
      expect(() => v2ReaderPageHtml(bad), JSON.stringify(bad)).toThrow()
  })

  it('twoLoads_DifferentNonces_EachCarriesOnlyItsOwn', () => {
    const a = v2ReaderPageHtml('A'.repeat(24))
    const b = v2ReaderPageHtml('B'.repeat(24))
    expect(a).not.toContain('B'.repeat(24))
    expect(b).not.toContain('A'.repeat(24))
  })

  it('csp_MatchesAdr029Decision4_AndPrecedesTheOnlyScript', () => {
    const html = v2ReaderPageHtml(NONCE)
    expect(html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1]).toBe(
      `default-src 'none'; script-src 'nonce-${NONCE}'; style-src blob: 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; frame-src blob:; connect-src blob: data: file:; form-action 'none'; base-uri 'none'`,
    )
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'))
    expect(html.match(/<script/g)).toHaveLength(1)
  })

  it('bundle_PatchedPaginatorGuardAndPaginatedDefault_NoTestOnlyCode', () => {
    const html = v2ReaderPageHtml(NONCE)
    // patches/0001: Paginator.render() returns while the current view's document has no body yet.
    expect(html).toContain('if (!((_b = (_a = this.#view) == null ? void 0 : _a.document) == null ? void 0 : _b.body)) return;')
    expect(html).toContain('var flow = "paginated";')
    expect(html).not.toContain('reproRenderDuringLoad')
  })
})
