import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readerAndroidPageHtml, readerPageHtml } from './readerPage.generated'
import { MAX_SELECTED_TEXT } from '../../shared/src/reader/locators'

const NONCE = 'q7Rk2mW9xLpA4vBn8cZt0g=='

describe('readerPageHtml', () => {
  it('generatedSource_CarriesOnlyThePlaceholder_NoLiteralNonce', () => {
    const src = readFileSync(resolve(__dirname, 'readerPage.generated.ts'), 'utf8')
    // The page's CSP, and the web and Android CSP literals the Android page swaps: every one the placeholder.
    expect(new Set(src.match(/'nonce-[^']*'/g))).toEqual(new Set(["'nonce-__READER_NONCE__'"]))
    expect(src.match(/nonce=\\"[^\\]*\\"/g)).toEqual(['nonce=\\"__READER_NONCE__\\"'])
  })

  it('validNonce_FillsTheCspAndTheScriptTag_ExactlyTwice', () => {
    const html = readerPageHtml(NONCE)
    expect(html.split(NONCE)).toHaveLength(3)
    expect(html).toContain(`script-src 'nonce-${NONCE}'`)
    expect(html).toContain(`<script nonce="${NONCE}">`)
    expect(html).not.toContain('__READER_NONCE__')
  })

  it('weakOrUnsafeNonce_Throws', () => {
    for (const bad of ['', 'tsfoliate', '__READER_NONCE__', 'x__READER_NONCE__', 'a'.repeat(15), `${'a'.repeat(16)}"><script>`, `${'a'.repeat(16)}'`])
      expect(() => readerPageHtml(bad), bad).toThrow()
  })

  it('nonceShapes_PaddedBase64AndHexAccepted_InjectionShapesRejected', () => {
    for (const ok of ['a'.repeat(16), NONCE, 'ab'.repeat(16), 'A-_b'.repeat(6)]) expect(() => readerPageHtml(ok), ok).not.toThrow()
    for (const bad of [`${'a'.repeat(16)}\n`, ` ${'a'.repeat(16)}`, `${'a'.repeat(16)}===`, `${'a'.repeat(16)}$&`, `${'a'.repeat(16)}; script-src *`])
      expect(() => readerPageHtml(bad), JSON.stringify(bad)).toThrow()
  })

  it('twoLoads_DifferentNonces_EachCarriesOnlyItsOwn', () => {
    // Not runs of one letter: the carried pdf.js and cMaps hold base64 data with long runs of 'A'.
    const [na, nb] = ['Qa1Qa1'.repeat(4), 'Zb2Zb2'.repeat(4)]
    const a = readerPageHtml(na)
    const b = readerPageHtml(nb)
    expect(a).not.toContain(nb)
    expect(b).not.toContain(na)
  })

  it('csp_MatchesAdr029Decision4_AndPrecedesTheOnlyScript', () => {
    const html = readerPageHtml(NONCE)
    expect(html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1]).toBe(
      `default-src 'none'; script-src 'nonce-${NONCE}' 'wasm-unsafe-eval'; style-src blob: 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; frame-src blob:; worker-src blob:; connect-src blob: data:; form-action 'none'; base-uri 'none'`,
    )
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'))
    expect(html.match(/<script/g)).toHaveLength(1)
  })

  it('androidPage_CspAddsTheServedDirectories_RestIdentical', () => {
    const web = readerPageHtml(NONCE)
    const android = readerAndroidPageHtml(NONCE)
    expect(android.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1]).toBe(
      `default-src 'none'; script-src 'nonce-${NONCE}' 'wasm-unsafe-eval'; style-src blob: 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; frame-src blob:; worker-src blob:; connect-src blob: data: https://appassets.androidplatform.net/v2/books/ https://appassets.androidplatform.net/v2/staging/; form-action 'none'; base-uri 'none'`,
    )
    expect(android.replace(/connect-src [^;]*/, '')).toBe(web.replace(/connect-src [^;]*/, ''))
    expect(() => readerAndroidPageHtml('__READER_NONCE__')).toThrow()
  })

  it('bundle_PatchedPaginatorGuardAndPaginatedDefault_NoTestOnlyCode', () => {
    const html = readerPageHtml(NONCE)
    // Fork commit d73682a (was patches/0001): Paginator.render() returns while the current view's document has no body yet.
    // esbuild's temporaries are renamed as the bundle grows (_a → _a2): matched by shape, not by name.
    expect(html).toMatch(/if \(!\(\((\w+) = \((\w+) = this\.#view\) == null \? void 0 : \2\.document\) == null \? void 0 : \1\.body\)\) return;/)
    // Fork commit b3386ef (#1182): setStyles' frame callback does nothing once destroy() nulled the view.
    expect(html).toMatch(/requestAnimationFrame\(\(\) => \{\s*if \(this\.#view\) this\.#background\.style\.background = getBackground\(this\.#view\.document\);\s*\}\);/)
    // Fork commit 73d4259 (#1291): afterScroll does nothing once destroy() nulled the view.
    expect(html).toMatch(/#afterScroll\(reason\) \{\s*if \(!this\.#view\) return;/)
    // Fork commit fe04665 (#1297): justAnchored swallows only the anchoring's own scroll (its offset), not the reader's next one.
    expect(html).toContain('const anchored = this.#justAnchored === this.#container[this.scrollProp];')
    expect(html).toContain('else this.#justAnchored = this.#container[this.scrollProp];')
    expect(html).toContain('var flow = "paginated";')
    expect(html).not.toContain('reproRenderDuringLoad')
    expect(html).not.toContain('currentView')
  })

  it('bundle_Kf8ForkCommits_AndTheRelocateReasonFromTheView', () => {
    const html = readerPageHtml(NONCE)
    // #1182 fork commits. view.js: the view's relocate carries the renderer's reason; the page reads it there
    // and keeps no capture listener of its own on the renderer.
    expect(html).toContain('this.#emit("relocate", { ...this.lastLocation, reason });')
    // The save rule's test, sent as `relocate.moved` (#1263) and used for the save: one rule.
    expect(html).toMatch(/const moved = (\w+)\.reason !== "anchor" && \1\.cfi !== lastCfi && !hostMoving;/)
    expect(html).toMatch(/dir: pagedDir\(\), moved, cause, atEnd: atBookEnd\(.*\), \.\.\.lengthAt\(.*\) \}\);/)
    // #1313: what moved the place, from the page's own navigations (`hostMoving`, `asNav`), never a host's guess.
    expect(html).toMatch(/const cause = (\w+)\.cfi === lastCfi \? "layout" : navs > 0 \|\| awaitingRestore && !readerActed \? "nav" : \1\.reason === "anchor" \? "layout" : "turn";/)
    expect(html).toMatch(/const position = moved && entry \? positionOf\(/)
    expect(html).not.toContain('rendererReason')
    expect(html).not.toMatch(/view\.renderer\.addEventListener\("relocate"/)
    // mobi.js, the carried MOBI reader (a JSON string, read back as JS): typed KF8 resource blobs, and KF8
    // section markup dispatched through transformTarget, where the page strips refresh metas.
    const mobi: string = JSON.parse(html.match(/var __TS_FORMATS = \{mobi: ("(?:[^"\\]|\\.)*")/)![1])
    expect(mobi).toContain('new Blob([newData], { type: newType })')
    expect(mobi).not.toContain('{ newType }')
    expect(mobi).toMatch(/const detail = \{ data: replaced, type: this\.#type \};\s*this\.transformTarget\.dispatchEvent\(new CustomEvent\("data", \{ detail \}\)\);\s*const data = await detail\.data;\s*if \(data !== replaced\) doc = /)
  })

  it('bundle_OpenFlushesPendingSaves_AndNoHighlightBeforeRestored', () => {
    const html = readerPageHtml(NONCE)
    // The call sites of the two data-loss guards; the scheduler itself is unit-tested.
    // #1128 S5: the book is made before the swap; a superseded or empty one is destroyed and never swapped
    // in; at the swap the book on screen's pending save is flushed under its own key, then forgotten (#1286 review: flush()
    // hands a host nothing of a previous open), then the new one is assigned.
    expect(html).toMatch(/const made = await makeBookFor\(bytes, name, kind\);\s*const empty = [^;]*;\s*if \(mine !== openSeq \|\| empty\) destroy\(made\.book\);\s*if \(mine !== openSeq\) return false;\s*if \(empty\) throw [^;]*;\s*saves\.flush\(\);\s*saves\.forget\(\);\s*endSession\(\);\s*book = \{ sha256/)
    // The replaced book is destroyed (view.close() leaves it alive).
    expect(html).toMatch(/view\.close\(\);\s*\} catch \(\w+\) \{[\s\S]{0,200}?\}\s*destroy\(view == null \? void 0 : view\.book\);/)
    expect(html).not.toContain('saves.cancel')
    // Sniffing still precedes the view swap: a refused file leaves the shown book reading and saving.
    // #1069: request order is assigned before reading, and stale read callbacks cannot open a book.
    expect(html).toMatch(/function openFor\(bytes, name, mine, fileFormat\) \{\s*let kind;\s*try \{\s*kind = fileFormat === \"html\" \? \"html\" : sniffFormat\(bytes\);\s*\} catch \((\w+)\) \{\s*return openFailed\(name, [^;]*;\s*\}\s*return open\(bytes, name, kind, mine\)/)
    expect(html).toMatch(/openUrl: \(url, name, fileFormat = null\) => \{\s*const mine = \+\+openSeq;\s*openXhr == null \? void 0 : openXhr\.abort\(\);\s*const \w+ = openXhr = new XMLHttpRequest\(\)/)
    expect(html).toMatch(/\w+\.onload = \(\) => \{\s*if \(mine !== openSeq\) return;/)
    expect(html).toMatch(/function highlightSelection\(color = "yellow", quotation = false\) \{[\s\S]{0,800}?if \(!entry\) return log\("warn"/)
    // The open seq only goes up: a failed open answers `open-failed` and hands nothing back.
    expect(html).toMatch(/if \(mine === openSeq\) openFailed\(name, [^;]*;\s*\}\);/)
    expect(html).not.toMatch(/(?<!var )openSeq = /)
    expect(html.indexOf('const made = await makeBookFor(')).toBeLessThan(html.indexOf('view == null ? void 0 : view.close()'))
  })

  it('bundle_EveryStateChangeGuarded_SoOneBadBookCannotWedgeThePage', () => {
    const html = readerPageHtml(NONCE)
    // A view that never rendered throws from close(); the next open must still work.
    expect(html).toMatch(/try \{\s*view == null \? void 0 : view\.close\(\);\s*\} catch/)
    // A replaced view's events are dropped: each view's listeners carry the seq of the open that made them
    // and compare it with the view on screen, which turns over at the swap, before the dying view's close()
    // fires relocate (#1168). A newer open still being made does not silence the view on screen (#1128 S5).
    expect(html).toMatch(/view\.addEventListener\("relocate", \(\{ detail: \w+ \}\) => \{\s*(var [^;]*;\s*)?if \(mine !== viewSeq\) return;[\s\S]{0,400}?post\(\{\s*type: "relocate"/)
    expect(html).toMatch(/view\.addEventListener\("create-overlay", [\s\S]{0,80}?if \(mine !== viewSeq\) return;/)
    expect(html).toMatch(/endSession\(\);\s*book = \{ sha256[^}]*\};\s*entry = null;\s*quotes = \[\];\s*hostMoving = true;\s*awaitingRestore = true;\s*readerActed = false;\s*navs = 0;\s*lastCfi = null;\s*viewSeq = mine;\s*navigating = Promise\.resolve\(\);/)
    // A restore is for the view on screen that answered `opened`, whatever is being made meanwhile.
    expect(html).toMatch(/if \(!book \|\| readySeq !== viewSeq\) return log\("warn", "restore ignored/)
    // The host-move guard is cleared however restore ends, or the page saves nothing for the rest of the session.
    expect(html).toMatch(/\} finally \{[\s\S]{0,200}?hostMoving = awaitingRestore = false;/)
    // The renderer exists only after view.open() resolved.
    // The renderer exists only after view.open() resolved; the fixed-layout one (CBZ) has no setStyles (#1128).
    // One place sets them (#1260, applyLook): at the open, on `settings`, and once before any book.
    expect(html).toMatch(/view\.renderer\) == null \? void 0 : (\w+)\.setStyles\) == null \? void 0 : \w+\.call\(\1, settingsCss\(look, fontUrl\(\), glossRoom\)\)/)
    expect(html).toMatch(/view\.renderer\.setAttribute\("margin", "24px"\);\s*applyLook\(\);\s*await view\.init\(/)
    // #1260: whatever the host sends is read through settings.mjs before it is the page's, and before any CSS is built from it.
    expect(html).toMatch(/settings: \((\w+)\) => \{\s*look = readSettings\(\1\);\s*applyLook\(\);\s*return look;\s*\}/)
    expect(html).toMatch(/function settingsCss\((\w+), fontUrl2?, glosses = false\) \{\s*const (\w+) = readSettings\(\1\);/)
    // A position is reported restored only if the renderer really shows that section, a fraction's too (#1187).
    expect(html).toContain('result.position = arrivedAt(index) ? "restored" : "navigation failed, stayed at start"')
    expect(html).toContain('return resolved && arrivedAt(resolved.index) ? resolved.index : -1')
  })

  it('formatReaders_CarriedAsEscapedStrings_RunOnlyUnderThePageNonce', () => {
    const html = readerPageHtml(NONCE)
    // #1128: MOBI, FB2 and CBZ ride ahead of the page in its one script, as strings with no raw `<`
    // (nothing in them can end or bend the script element), and are run by page.mjs on first use
    // through a script element carrying the page's own nonce: no CSP directive is widened.
    const str = '"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"'
    const carried = html.match(new RegExp(`<script nonce="[^"]+">(var __TS_FORMATS = \\{mobi: ${str},\\nfb2: ${str},\\ncbz: ${str},\\npdf: ${str},\\npdfworker: ${str},\\npdfwasm: ${str},\\npdfcmaps: ${str},\\ndyslexic: ${str},\\nserif: ${str},\\nsans: ${str}\\};\\n)`))?.[1]
    expect(carried).toBeDefined()
    expect(carried).not.toContain('<')
    for (const k of ['mobi', 'fb2', 'cbz', 'pdf', 'pdfwasm', 'pdfcmaps', 'dyslexic', 'serif', 'sans']) expect(carried).toMatch(new RegExp(`window\\.__tsFormats\\.${k} ?=`))
    expect(html).toMatch(/var NONCE = \(\w+ = document\.currentScript\) == null \? void 0 : \w+\.nonce;/)
    expect(html).toMatch(/(\w+)\.nonce = NONCE;\s*\1\.textContent = /)
    // A comic book has no text: its frames say the reader acted (#1313), post mouse moves, forward keys and post `tap` (where it landed,
    // #1263) and return before any selection or press listener; a translation is never drawn on it.
    expect(html).toMatch(/function onLoad\(\{ detail: \{ doc, index \} \}\) \{\s*for \(const type of \["pointerdown", "wheel", "keydown", "touchstart"\]\) doc\.addEventListener\(type, onInput, \{ capture: true, passive: true \}\);\s*doc\.addEventListener\("pointermove", onMove, \{ passive: true \}\);\s*doc\.addEventListener\("keydown", onKey\);\s*if \(!textual\) return doc\.addEventListener\("click", \((\w+)\) => post\(tapAt\(doc, \1\)\)\);\s*sectionIndex\.set\(doc, index\);/)
    // Nor on a PDF (#1128 S5): `annotatable` is false for both, and `opened` says so.
    expect(html).toMatch(/showTranslation: \(cfi, index, \w+\) => view && annotatable && annotate\(/)
    expect(html).toContain('annotatable = textual && format !== "pdf";')
    expect(html).toMatch(/type: "opened",\s*book,\s*format,\s*textual,\s*annotatable,/)
    // The page bundle itself carries none of them: view.js's own imports stay stubbed.
    const page = html.slice(html.indexOf(carried!) + carried!.length)
    expect(page).not.toContain('.vendor/foliate-js/mobi.js')
    expect(page).not.toContain('.vendor/foliate-js/fb2.js')
    expect(page).not.toContain('.vendor/foliate-js/comic-book.js')
    expect(page).not.toContain('pdfjsWorker')
  })

  it('pdfReader_WorkerInAWorkerOfItsOwn_NoEvalWasmCarriedNothingFetched', () => {
    // #1204: pdf.js's worker is a chunk of its own (`pdfworker`), run in a Worker from a blob: URL of its text, never on
    // the page; the PDF reader carries pdf.js's main side and the fork's pdf.js, which forces isEvalSupported off.
    const html = readerPageHtml(NONCE)
    const chunk = (k: string): string => JSON.parse(html.match(new RegExp(`\\n${k}: ("(?:[^"\\\\]|\\\\.)*")`))![1])
    const pdf = chunk('pdf')
    const worker = chunk('pdfworker')
    expect(pdf).not.toMatch(/globalThis\.pdfjsWorker\s*=/)
    expect(worker).toMatch(/globalThis\.pdfjsWorker\s*=/)
    expect(pdf).toContain('isEvalSupported:!1')
    // S5 review: the runtime polyfills run before pdf.js, on the page and in the worker; the page refuses a PDF without
    // structuredClone or Worker.
    expect(pdf.indexOf('getOrInsertComputed')).toBeLessThan(pdf.indexOf('isEvalSupported:!1'))
    expect(worker.indexOf('getOrInsertComputed')).toBeLessThan(worker.search(/globalThis\.pdfjsWorker\s*=/))
    expect(html).toContain('if (typeof structuredClone !== "function" || typeof Worker !== "function") throw new Error("this WebView is too old to read PDF");')
    expect(html).toMatch(/new Worker\(pdfWorkerUrl \?\?= URL\.createObjectURL\(new Blob\(\[\(\((\w+) = self\.__TS_FORMATS\) == null \? void 0 : \1\.pdfworker\) \?\? ""\], \{ type: "text\/javascript" \}\)\)\)/)
    // A book still on screen after its init answers `opened`; `restored` names its book.
    expect(html).toMatch(/await view\.init\(\{ showTextStart: true \}\);\s*if \(mine !== viewSeq\) return false;/)
    expect(html).toContain('post({ type: "restored", key: book.sha256, ...result })')
    for (const js of [pdf, worker]) {
      expect(js).toContain('Copyright 2024 Mozilla Foundation')
      expect(js).toContain('Licensed under the Apache License, Version 2.0')
    }
    // The page: the bytes themselves (#1557), its worker, the open's deadline; wasm and cMaps from its own chunks, no URL for anything.
    expect(html).toMatch(/made = await makePDF\(bytes, \{ css(?:: \w+)?, worker: pdfWorker, deadline, pageDeadline: testPdfDeadline \|\| PDF_PAGE_MS, onFail, params: \{ useWasm: true, CMapReaderFactory: PdfCMaps, WasmFactory: PdfWasm \} \}\)/)
    // #1204 review: a terminated worker with its book on screen is said to the hosts, never for a book not on screen.
    expect(html).toContain('if (made && (view == null ? void 0 : view.book) === made) post({ type: "book-stopped", key: book.sha256,')
    expect(html).toContain('const deadline = testPdfDeadline || openedDeadlineMs(bytes.length);')
    // #1204: OpenJPEG's wasm, base64, with its two notices; asked for by name, nothing else.
    const wasm = chunk('pdfwasm')
    expect(wasm).toMatch(/"openjpeg\.wasm": ?"AGFzbQ[A-Za-z0-9+/=]+"/)
    expect(wasm).toContain('Universite catholique de Louvain')
    expect(wasm).toContain('Mozilla Foundation')
    expect(html).toContain('if (filename !== "openjpeg.wasm") throw')
    expect(html).toContain('made.rendition.spread = "none";')
    const cmaps = JSON.parse(html.match(/\npdfcmaps: ("(?:[^"\\]|\\.)*")/)![1]) as string
    expect(cmaps).toContain('Adobe Systems Incorporated')
    expect(cmaps).toMatch(/"UniGB-UCS2-H": ?"[A-Za-z0-9+/=]+"/)
    // A PDF position is a page, never a CFI; a position of the other kind is refused on restore and goTo.
    expect(html).toMatch(/var fits = \((\w+)\) => format === "pdf" === isPdfPage\(\1\);/)
    expect(html).toMatch(/if \((\w+) && !fits\(\1\)\) \{\s*result\.position = "wrong position kind, stayed at start";/)
    // goTo: a wrong-kind position, and a raw CFI string on a PDF.
    expect(html).toMatch(/if \(isPosition\(target\) \? !fits\(target\) : format === "pdf" && String\(target\)\.startsWith\("epubcfi\("\)\) return log\("warn"/)
  })

  it('bundle_SyncPrereqs_UuidIdsCodePointQuotesSelectedText', () => {
    const html = readerPageHtml(NONCE)
    // #1078: v4 UUID ids from getRandomValues (no randomUUID: needs a secure context), quotes cut by
    // code points, the full selection in selectedText and restore comparing it (old entries: quote).
    expect(html).toContain('crypto.getRandomValues(new Uint8Array(16))')
    // The page's own script: pdf.js (a carried reader) checks for randomUUID and falls back.
    expect(html.slice(html.indexOf('"};\n'))).not.toContain('randomUUID')
    expect(html).toMatch(/return \w+\.range \? \{ \.\.\.\w+, quote: quoteOf\(\w+\.range\.toString\(\)/)
    expect(html).toMatch(/id: uuidV4\(\),[\s\S]{0,120}?quote: quoteOf\(selectedText\),\s*selectedText,/)
    // (#1314: a bookmark's by the text a bookmark keeps there, a highlight's by the range's own text.)
    expect(html).toMatch(/foldText\(\w+\(\w+\) \? \w+ : \w+\) === foldText\((\w+)\.selectedText \?\? \1\.quote\)/)
    expect(html).not.toMatch(/\.slice\(0, 64\)/)
    // The `highlighted` message carries the full selection and its colour (README protocol table).
    expect(html).toMatch(/type: "highlighted", id: \w+\.id, cfi: \w+\.cfi, quote: \w+\.quote, selectedText, color \}/)
    // A selection with no text, or one the server would refuse (SyncLimits.MaxSelectedText), is not
    // stored, and nothing is drawn or announced for it.
    // The cap is the shared one (packages/shared locators, SyncLimits.MaxSelectedText), bundled once.
    expect(html.match(/var MAX_SELECTED_TEXT = (\S+);/g)).toHaveLength(1)
    expect(Number(html.match(/var MAX_SELECTED_TEXT = (\S+);/)?.[1])).toBe(MAX_SELECTED_TEXT)
    expect(html).toMatch(/const selectedText = \w+\.range\.toString\(\);\s*if \(!selectedText\.trim\(\)\) return log\("warn"[^;]*;\s*if \(selectedText\.length > MAX_SELECTED_TEXT\) return log\("warn"/)
  })
})
