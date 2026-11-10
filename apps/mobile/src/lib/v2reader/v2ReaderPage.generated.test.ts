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
    // Fork commit d73682a (was patches/0001): Paginator.render() returns while the current view's document has no body yet.
    expect(html).toContain('if (!((_b = (_a = this.#view) == null ? void 0 : _a.document) == null ? void 0 : _b.body)) return;')
    expect(html).toContain('var flow = "paginated";')
    expect(html).not.toContain('reproRenderDuringLoad')
    expect(html).not.toContain('currentView')
  })

  it('bundle_OpenCancelsPendingSaves_AndNoHighlightBeforeRestored', () => {
    const html = v2ReaderPageHtml(NONCE)
    // The call sites of the two data-loss guards; the scheduler itself is unit-tested.
    expect(html).toMatch(/async function open\(bytes, name, mine\) \{(\s*var [^;]*;)?\s*saves\.cancel\(\);/)
    expect(html).toMatch(/function openFor\(bytes, name\) \{\s*const mine = \+\+openSeq;/)
    expect(html).toMatch(/function highlightSelection\(\) \{[\s\S]{0,200}?if \(!entry\) return log\("warn"/)
  })

  it('bundle_EveryStateChangeGuarded_SoOneBadBookCannotWedgeThePage', () => {
    const html = v2ReaderPageHtml(NONCE)
    // A view that never rendered throws from close(); the next open must still work.
    expect(html).toMatch(/try \{\s*view == null \? void 0 : view\.close\(\);\s*\} catch/)
    // A superseded book's events are dropped: each view's listeners carry the open seq that made
    // them, and openFor turns the seq over before the dying view's close() fires relocate (#1168).
    expect(html).toMatch(/view\.addEventListener\("relocate", \(\{ detail: \w+ \}\) => \{\s*(var [^;]*;\s*)?if \(mine !== openSeq\) return;\s*post\(\{\s*type: "relocate"/)
    expect(html).toMatch(/view\.addEventListener\("create-overlay", [\s\S]{0,80}?if \(mine !== openSeq\) return;/)
    // A superseded open must not re-key the current book's saves: the seq check precedes the assignment.
    expect(html).toMatch(/if \(mine !== openSeq\) return false;\s*book = \{ sha256/)
    // restoring is cleared however restore ends, or the page saves nothing for the rest of the session.
    expect(html).toMatch(/\} finally \{[\s\S]{0,200}?restoring = false;/)
    // The renderer exists only after view.open() resolved.
    expect(html).toMatch(/view\.renderer\) == null \? void 0 : _a\.setStyles/)
    // A position is reported restored only if the renderer really shows that section.
    expect(html).toContain('result.position = landed ? "restored" : "navigation failed, stayed at start"')
  })

  it('bundle_SyncPrereqs_UuidIdsCodePointQuotesSelectedText', () => {
    const html = v2ReaderPageHtml(NONCE)
    // #1078: v4 UUID ids from getRandomValues (no randomUUID: needs a secure context), quotes cut by
    // code points, the full selection in selectedText and restore comparing it (old entries: quote).
    expect(html).toContain('crypto.getRandomValues(new Uint8Array(16))')
    expect(html).not.toContain('randomUUID')
    expect(html).toMatch(/const quote = quoteOf\(\w+\.range\.toString\(\)/)
    expect(html).toMatch(/id: uuidV4\(\),[\s\S]{0,120}?quote: quoteOf\(selectedText\),\s*selectedText,/)
    expect(html).toMatch(/const ok = foldText\(\w+\) === foldText\((\w+)\.selectedText \?\? \1\.quote\);/)
    expect(html).not.toMatch(/\.slice\(0, 64\)/)
    // The `highlighted` message carries the full selection (README protocol table).
    expect(html).toMatch(/type: "highlighted", id: \w+\.id, cfi: \w+\.cfi, quote: \w+\.quote, selectedText \}/)
    // A selection with no text, or one the server would refuse (SyncLimits.MaxSelectedText), is not
    // stored, and nothing is drawn or announced for it.
    expect(html).toContain('var MAX_SELECTED_TEXT = 4e3;')
    expect(html).toMatch(/const selectedText = \w+\.range\.toString\(\);\s*if \(!selectedText\) return log\("warn"[^;]*;\s*if \(selectedText\.length > MAX_SELECTED_TEXT\) return log\("warn"/)
  })
})
