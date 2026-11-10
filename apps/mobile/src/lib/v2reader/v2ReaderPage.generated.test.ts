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
    // esbuild's temporaries are renamed as the bundle grows (_a → _a2): matched by shape, not by name.
    expect(html).toMatch(/if \(!\(\((\w+) = \((\w+) = this\.#view\) == null \? void 0 : \2\.document\) == null \? void 0 : \1\.body\)\) return;/)
    expect(html).toContain('var flow = "paginated";')
    expect(html).not.toContain('reproRenderDuringLoad')
    expect(html).not.toContain('currentView')
  })

  it('bundle_OpenCancelsPendingSaves_AndNoHighlightBeforeRestored', () => {
    const html = v2ReaderPageHtml(NONCE)
    // The call sites of the two data-loss guards; the scheduler itself is unit-tested.
    expect(html).toMatch(/async function open\(bytes, name, kind, mine\) \{(\s*var [^;]*;)?\s*saves\.cancel\(\);/)
    // #1128: the format is sniffed (and a refusal answered) BEFORE the seq turns over, so a refused
    // file leaves the open book reading and saving, like a failed read (#1168).
    expect(html).toMatch(/function openFor\(bytes, name\) \{\s*let kind;\s*try \{\s*kind = sniffFormat\(bytes\);\s*\} catch \((\w+)\) \{\s*return openFailed\(name, [^;]*;\s*\}\s*const mine = \+\+openSeq;\s*return open\(bytes, name, kind, mine\)/)
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
    // (#1128: the previous book's telemetry session ends there too, before the new book is assigned.)
    expect(html).toMatch(/if \(mine !== openSeq\) return false;\s*endSession\(\);\s*book = \{ sha256/)
    // restoring is cleared however restore ends, or the page saves nothing for the rest of the session.
    expect(html).toMatch(/\} finally \{[\s\S]{0,200}?restoring = false;/)
    // The renderer exists only after view.open() resolved.
    // The renderer exists only after view.open() resolved; the fixed-layout one (CBZ) has no setStyles (#1128).
    expect(html).toMatch(/view\.renderer\) == null \? void 0 : (\w+)\.setStyles\) == null \? void 0 : \w+\.call\(\1, css\(\)\)/)
    expect(html).toMatch(/\((\w+) = \((\w+) = view\.renderer\)\.setStyles\) == null \? void 0 : \1\.call\(\2, css\(\)\)/)
    // A position is reported restored only if the renderer really shows that section, a fraction's too (#1187).
    expect(html).toContain('result.position = arrivedAt(index) ? "restored" : "navigation failed, stayed at start"')
    expect(html).toContain('return !!resolved && arrivedAt(resolved.index)')
  })

  it('formatReaders_CarriedAsEscapedStrings_RunOnlyUnderThePageNonce', () => {
    const html = v2ReaderPageHtml(NONCE)
    // #1128: MOBI, FB2 and CBZ ride ahead of the page in its one script, as strings with no raw `<`
    // (nothing in them can end or bend the script element), and are run by page.mjs on first use
    // through a script element carrying the page's own nonce: no CSP directive is widened.
    const carried = html.match(/<script nonce="[^"]+">(var __TS_FORMATS = \{mobi: "[^"\\]*(?:\\.[^"\\]*)*",\nfb2: "[^"\\]*(?:\\.[^"\\]*)*",\ncbz: "[^"\\]*(?:\\.[^"\\]*)*"\};\n)/)?.[1]
    expect(carried).toBeDefined()
    expect(carried).not.toContain('<')
    for (const k of ['mobi', 'fb2', 'cbz']) expect(carried).toContain(`window.__tsFormats.${k} = {`)
    expect(html).toMatch(/var NONCE = \(\w+ = document\.currentScript\) == null \? void 0 : \w+\.nonce;/)
    expect(html).toMatch(/(\w+)\.nonce = NONCE;\s*\1\.textContent = /)
    // A comic book has no text: its frames post only `tap`, and a translation is never drawn on it.
    expect(html).toMatch(/function onLoad\(\{ detail: \{ doc, index \} \}\) \{\s*if \(!textual\) return doc\.addEventListener\("click", \(\) => post\(\{ type: "tap" \}\)\);/)
    expect(html).toMatch(/showTranslation: \(cfi, index, \w+\) => view && textual && annotate\(/)
    // The page bundle itself carries none of them: view.js's own imports stay stubbed.
    const page = html.slice(html.indexOf(carried!) + carried!.length)
    expect(page).not.toContain('.vendor/foliate-js/mobi.js')
    expect(page).not.toContain('.vendor/foliate-js/fb2.js')
    expect(page).not.toContain('.vendor/foliate-js/comic-book.js')
  })

  it('bundle_SyncPrereqs_UuidIdsCodePointQuotesSelectedText', () => {
    const html = v2ReaderPageHtml(NONCE)
    // #1078: v4 UUID ids from getRandomValues (no randomUUID: needs a secure context), quotes cut by
    // code points, the full selection in selectedText and restore comparing it (old entries: quote).
    expect(html).toContain('crypto.getRandomValues(new Uint8Array(16))')
    expect(html).not.toContain('randomUUID')
    expect(html).toMatch(/return textual \? \{ \.\.\.\w+, quote: quoteOf\(\w+\.range\.toString\(\)/)
    expect(html).toMatch(/id: uuidV4\(\),[\s\S]{0,120}?quote: quoteOf\(selectedText\),\s*selectedText,/)
    expect(html).toMatch(/const ok = foldText\(\w+\) === foldText\((\w+)\.selectedText \?\? \1\.quote\);/)
    expect(html).not.toMatch(/\.slice\(0, 64\)/)
    // The `highlighted` message carries the full selection (README protocol table).
    expect(html).toMatch(/type: "highlighted", id: \w+\.id, cfi: \w+\.cfi, quote: \w+\.quote, selectedText \}/)
    // A selection with no text, or one the server would refuse (SyncLimits.MaxSelectedText), is not
    // stored, and nothing is drawn or announced for it.
    expect(html).toContain('var MAX_SELECTED_TEXT = 4e3;')
    expect(html).toMatch(/const selectedText = \w+\.range\.toString\(\);\s*if \(!selectedText\.trim\(\)\) return log\("warn"[^;]*;\s*if \(selectedText\.length > MAX_SELECTED_TEXT\) return log\("warn"/)
  })
})
