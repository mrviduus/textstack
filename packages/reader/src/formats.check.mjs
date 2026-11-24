// The format check (#1128): the committed page, in Chromium under the Android host's origin (bookOriginRoute.mjs),
// opens one small book per format (fixtures.mjs writeFormatFixtures) and must answer as README "Formats" says, one
// story per row and bullet: each format reader runs only when its first book opens; EPUB, MOBI, FB2/FBZ (UTF-16 too),
// AZW3 and a combo (its KF8 half) open and draw; CBZ has no text features and saves and restores its page by name;
// a fraction-only position (#1187) restores without saving; an HTML clip opens only with the host's format, sanitized; PDF opens, pages, saves and resumes by `pdf-page` and
// never takes a CFI; `describe` reads every format's details and cover beside the open book; a DRM, damaged, entity-declaring or unknown file is refused, leaving the open book reading;
// a hostile PDF neither runs script nor leaves the file; a decompression bomb fails at its deadline while the page answers
// (#1204: pdf.js in a Worker); a JPEG 2000 image draws (OpenJPEG's wasm); a PDF's outline comes after `opened` (#1557);
// an older WebView still reads a PDF or says why not.
// The reader's features (selection, search, highlights, bookmarks, chrome) are not this check's: their modules'
// unit tests and the web e2e cover them.
//
//   node --experimental-strip-types formats.check.mjs      (pnpm -C apps/web check:reader-formats)
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAGE_URL, bookAt } from './bookOriginRoute.mjs'
import { bombPagePdf, bombPdf, fb2, hostilePdf, pdf, writeAlignmentEpub, writeFormatFixtures } from './fixtures.mjs'
import { chromium, drive, hostPage as harnessPage } from './pageHarness.mjs'
import { readerAndroidPageHtml as readerPageHtml } from './readerPage.generated.ts'

const here = dirname(fileURLToPath(import.meta.url))
const TIMEOUT_MS = 15000

const failures = []
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }

const dir = mkdtempSync(resolve(tmpdir(), 'ts-v2-formats-'))
const browser = await chromium.launch()
/** A page with the book origin routed to `dir`, as the Android interceptor serves it; host messages land in `got`. */
const hostPage = (got, opts) => harnessPage(browser, { dir, messages: got, ...opts })
try {
  writeFormatFixtures(dir)
  for (const f of ['tssynthetic-kf8.azw3', 'tssynthetic-combo.mobi']) copyFileSync(resolve(here, 'synthetic', f), resolve(dir, f))
  writeFileSync(resolve(dir, 'tsplain.txt'), 'plain text, no book')
  writeFileSync(resolve(dir, 'page.html'), readerPageHtml(randomBytes(18).toString('base64')))

  /**
   * An older WebView (S5 review), on pages of their own, after the main page: the APIs pdf.js 5.5 calls that
   * pdfPolyfills.mjs stands in for are deleted before the page runs, and a PDF still opens and draws; without
   * structuredClone too (not polyfillable) the open is refused with a clear message, never left hanging.
   * #1204: pdf.js's worker has globals of its own: each Worker the page makes runs the same deletions first.
   */
  const oldWebView = async (alsoClone) => {
    const got = []
    const old = await hostPage(got, { viewport: { width: 420, height: 760 } })
    await old.addInitScript((alsoClone) => {
      const strip = () => {
        for (const [o, k] of [[Map.prototype, 'getOrInsertComputed'], [Map.prototype, 'getOrInsert'], [WeakMap.prototype, 'getOrInsertComputed'],
          [WeakMap.prototype, 'getOrInsert'], [Promise, 'withResolvers'], [Promise, 'try'], [AbortSignal, 'any'], [Array.prototype, 'findLast'],
          [Uint8Array.prototype, 'toHex'], [Uint8Array.prototype, 'toBase64'], [Uint8Array, 'fromBase64'], [ArrayBuffer.prototype, 'transferToFixedLength'],
          [URL, 'parse'], [ReadableStream.prototype, Symbol.asyncIterator]]) delete o[k]
      }
      strip()
      if (alsoClone) delete window.structuredClone
      // The worker's script, read back from its blob: URL (connect-src blob:), behind the same deletions.
      const W = window.Worker
      window.Worker = function (url, options) {
        const x = new XMLHttpRequest()
        x.open('GET', url, false)
        x.send()
        window.__strippedWorkers = (window.__strippedWorkers ?? 0) + 1
        return new W(URL.createObjectURL(new Blob([`(${strip})();\n${x.responseText}`], { type: 'text/javascript' })), options)
      }
    }, alsoClone)
    await old.goto(PAGE_URL)
    await old.evaluate((u) => window.__fol.openUrl(u, 'tsformat.pdf'), bookAt('tsformat.pdf'))
    let answer = null
    for (const t0 = Date.now(); !answer && Date.now() - t0 < TIMEOUT_MS; await old.waitForTimeout(50)) answer = got.find((x) => x.type === 'opened' || x.type === 'open-failed')
    let drawn = false
    for (const t0 = Date.now(); !alsoClone && answer?.type === 'opened' && !drawn && Date.now() - t0 < TIMEOUT_MS; await old.waitForTimeout(100))
      for (const f of old.frames().filter((f) => f.url().startsWith('blob:'))) drawn ||= await f.evaluate(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 1. Sphinx')).catch(() => false)
    const stripped = await old.evaluate(() => window.__strippedWorkers ?? 0)
    await old.close()
    return alsoClone
      ? () => check(answer?.type === 'open-failed' && /too old to read PDF/.test(answer.error), `old WebView: without structuredClone a PDF is refused with a clear message (${answer?.type ?? 'no answer'}: ${answer?.error})`)
      : () => check(answer?.type === 'opened' && drawn && stripped === 1, `old WebView: without the polyfilled APIs (page and worker) a PDF still opens and draws (${answer?.type ?? 'no answer'}${answer?.error ? `, ${answer.error}` : ''}, ${stripped} worker)`)
  }

  const messages = []
  const page = await hostPage(messages, { viewport: { width: 420, height: 760 } })
  let pageErrors = 0
  page.on('pageerror', (e) => { pageErrors++; check(false, `pageerror: ${e.message}`) })
  // Every CSP violation in any frame of the page, as `directive blockedURI`.
  await page.addInitScript(() => addEventListener('securitypolicyviolation', (e) => (top.__violations ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)))
  await page.goto(PAGE_URL)

  const { call, waitFor, shown, framesValue, open: openUrl } = drive(page, messages, TIMEOUT_MS)
  const loaded = () => call('Object.keys(window.__tsFormats).filter(k => !["serif", "sans", "dyslexic"].includes(k)).sort().join(",")')
  const storeFrom = (from, what) => waitFor(from, (x) => x.type === 'store', what).then((s) => JSON.parse(s.json)).catch(() => null)
  /** Opens `file`; resolves with `opened` or `open-failed`, after `restored` for an opened book. */
  const open = (file, stored = null, format = null) => openUrl(bookAt(file), file, stored, format)
  /** The text of the book `m` opened, in a frame made after its open (a stale one from the previous book never passes). */
  const showsText = (m) => shown(() => document.body?.innerText.includes('Paragraph 1. Sphinx'), m.stale)
  const turnSaves = async (what) => { const from = messages.length; call('window.__fol.next()'); return storeFrom(from, what) }

  await waitFor(0, (m) => m.type === 'ready', 'ready')
  check(await loaded() === '', 'no format reader has run before a book opens')

  console.log('epub')
  let m = await open('tsformat.epub')
  check(m.type === 'opened' && m.format === 'epub' && m.textual === true && m.annotatable === true && m.title === 'TS EPUB', `opened as epub, textual, annotatable (${m.format}, ${m.title})`)
  check(await loaded() === '', 'an EPUB runs no format reader')
  call('window.__fol.flow("scrolled")')
  check(await call('document.querySelector("foliate-view").renderer.getAttribute("flow")') === 'scrolled', 'flow("scrolled") switches the live renderer')

  console.log('mobi')
  m = await open('tsformat.mobi')
  const tel = messages.slice(m.from).find((x) => x.type === 'telemetry')
  check(tel?.event === 'reader-flow' && tel.format === 'epub' && tel.mode === 'scrolled' && tel.switchedInFirst5Min === true, `the next open ends the EPUB's flow telemetry session, its switch counted: ${JSON.stringify(tel)}`)
  check(m.type === 'opened' && m.format === 'mobi' && m.textual && m.title === 'TS MOBI' && m.sections === 2, `opened as mobi, 2 sections (${m.format}, ${m.title}, ${m.sections}${m.error ? `, ${m.error}` : ''})`)
  check(await loaded() === 'mobi', 'the MOBI reader ran on the first MOBI, and only it')
  check(await showsText(m), 'its text is rendered')
  call('window.__fol.flow("paginated")')

  console.log('fb2')
  for (const file of ['tsformat.fbz', 'tsutf16.fb2', 'tsformat.fb2']) {
    m = await open(file)
    check(m.type === 'opened' && m.format === 'fb2' && m.textual && m.title === 'TS FB2', `${file} opens as fb2 and draws (${m.format}, ${m.title}${m.error ? `, ${m.error}` : ''})`)
    check(await showsText(m), `${file}: its text is rendered`)
  }
  check(await loaded() === 'fb2,mobi', 'the FB2 reader ran once, for FB2, FBZ and UTF-16 FB2')

  // A fraction-only position (a transitional server locator, #1187): restored by fraction, nothing saved until the
  // reader moves (opening the book does not rewrite the server's locator).
  console.log('fraction')
  m = await open('tsformat.fb2', JSON.stringify({ v: 1, book: m.book, highlights: [], position: { fraction: 0.9, at: 1 } }))
  check(m.restored.position === 'restored by fraction', `a fraction-only position is restored (${m.restored.position})`)
  check(!!(await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 1 && x.fraction > 0.5, 'relocate near the end').catch(() => null)), 'and the view is past the start')
  await page.waitForTimeout(1500) // foliate relocates at the landing again after `restored`: none of it may save
  check(!messages.slice(m.from).some((x) => x.type === 'store'), 'restoring by fraction saves nothing')
  check((await turnSaves('a store after the reader moves'))?.position?.cfi?.startsWith('epubcfi('), 'the reader moving saves a CFI position')

  // KF8 (#1182), on the SYNTHETIC Calibre-made books in synthetic/ (kf8fixture.mjs): says nothing about real Kindle files.
  console.log('kf8 (synthetic)')
  m = await open('tssynthetic-kf8.azw3')
  check(m.type === 'opened' && m.format === 'mobi' && m.textual && m.title === 'TS Synthetic KF8' && m.sections === 3 && m.toc.map((t) => t.label).join() === 'Part One,Part Two,Part Three',
    `an AZW3 opens: 3 sections, its TOC (${m.title ?? m.error}, ${m.sections}, ${m.toc?.map((t) => t.label)})`)
  check(await shown(async () => {
    const [css, png, svg, mark] = [document.querySelector('link[rel=stylesheet]'), document.querySelector('img.plate'), document.querySelector('img.badge'), document.querySelector('p.mark')]
    const type = async (url) => (await (await fetch(url)).blob()).type
    return !!(css && png && svg && mark) && png.naturalWidth === 120 && svg.naturalWidth === 80 && getComputedStyle(mark).color === 'rgb(10, 120, 30)'
      && await type(css.href) === 'text/css' && await type(png.src) === 'image/png' && await type(svg.src) === 'image/svg+xml'
  }), 'its resources are typed (text/css, image/png, image/svg+xml): the CSS applies, the PNG and the SVG render')
  // Section 2 carries a refresh meta to section 1: stripped through the KF8 transformTarget, so its frame stays.
  call('window.__fol.goTo(1)')
  check(await shown(() => document.body?.innerText.includes('Copper gulls') && ![...document.querySelectorAll('meta[http-equiv]')].some((x) => /refresh/i.test(x.getAttribute('http-equiv')))), 'the refresh meta of a KF8 section is stripped')
  await page.waitForTimeout(600)
  check(await shown(() => document.body?.innerText.includes('Copper gulls')), 'and its section still shows after the refresh delay')
  m = await open('tssynthetic-combo.mobi')
  check(m.type === 'opened' && m.sections === 3 && await shown(() => { const p = document.querySelector('p.mark'); return !!p && getComputedStyle(p).color === 'rgb(10, 120, 30)' }),
    `a MOBI/KF8 combo reads its KF8 half, with its CSS (${m.sections ?? m.error})`)
  m = await open('tscombo.mobi')
  check(m.type === 'opened' && m.format === 'mobi' && m.title === 'TS COMBO' && await showsText(m), `a combo whose KF8 boundary holds no MOBI header reads its MOBI6 half (${m.title ?? m.error})`)

  console.log('cbz')
  m = await open('tsformat.cbz')
  check(m.type === 'opened' && m.format === 'cbz' && m.textual === false && m.annotatable === false && m.reflowable === false && m.sections === 2,
    `opened as cbz: no text features, fixed layout, 2 pages (${m.format}, ${m.textual}, ${m.reflowable}, ${m.sections}${m.error ? `, ${m.error}` : ''})`)
  check(await loaded() === 'cbz,fb2,mobi', 'the CBZ reader ran on the first CBZ')
  check(await shown(() => document.querySelector('img')?.naturalWidth === 60), 'its first page image is rendered')
  let from = messages.length
  call('window.__fol.highlightSelection()')
  check(!!(await waitFor(from, (x) => x.type === 'log' && /has no text/.test(x.msg), 'highlight refused').catch(() => null)), 'highlightSelection is refused on an image-only book')
  const stored = await turnSaves('a store after the page turn')
  check(stored?.position?.page === 'p02.png' && !('quote' in stored.position) && stored.position.cfi.startsWith('epubcfi('), `a page turn saves page 2 by its entry name, no quote (${JSON.stringify(stored?.position)})`)
  m = await open('tsformat.cbz', JSON.stringify(stored))
  check(m.restored.position === 'restored' && !!(await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 1, 'relocate to page 2').catch(() => null)), `reopened, the saved page is restored (${m.restored.position})`)
  m = await open('tsupper.cbz')
  check(m.type === 'opened' && m.sections === 2, `a CBZ with upper-case extensions keeps every page (${m.sections ?? m.error})`)
  call('window.__fol.next()')
  check(await shown(async () => {
    const img = document.querySelector('img')
    return img?.naturalWidth === 60 && (await (await fetch(img.src)).blob()).type === 'image/svg+xml'
  }), 'its SVG page is rendered as an image (typed image/svg+xml)')

  // An HTML clip (owner decision 5): never by bytes, only with the host's format; one sanitized section.
  console.log('html clip')
  const pw = '(top.__pwned=1)'
  const clipText = Array.from({ length: 3 }, (_, i) => `<p>Paragraph ${i + 1}. Sphinx of black quartz, judge my vow.</p>`).join('')
  writeFileSync(resolve(dir, 'tsclip.html'), `<!doctype html><title>TS CLIP</title><div id="readability-page-1"><h1>Chapter One</h1>${clipText}<script>${pw}</script><img src="x" onerror="${pw}">`
    + `<a href="javascript:${pw}">j</a><svg onload="${pw}"></svg><iframe srcdoc="<script>${pw}</script>"></iframe><form action="https://evil.tst"><input name="p"></form></div>`)
  m = await open('tsclip.html')
  check(m.type === 'open-failed' && /not a book this reader opens/.test(m.error), `a clip without the host's format is refused (${m.error})`)
  m = await open('tsclip.html', null, 'html')
  check(m.type === 'opened' && m.format === 'html' && m.textual && m.annotatable && m.sections === 1 && m.title === 'TS CLIP' && await showsText(m),
    `with the host's format it opens as html, one section, and draws (${m.format}, ${m.sections}, ${m.title}${m.error ? `, ${m.error}` : ''})`)
  check(await shown(() => !document.querySelector('script,iframe,svg,form,input,[onerror],[onload],a[href^="javascript"]'), m.stale)
    && !(await Promise.all(page.frames().map((fr) => fr.evaluate(() => !!top.__pwned).catch(() => false)))).some(Boolean),
  'its section holds no script, frame, svg, form, handler or javascript: link, and no clip script ran')

  console.log('pdf')
  const violations = () => call('window.__violations ?? []')
  const before = (await violations()).length
  m = await open('tsformat.pdf')
  check(m.type === 'opened' && m.format === 'pdf' && m.textual === true && m.annotatable === false && m.reflowable === false && m.sections === 5 && m.title === 'TS PDF',
    `opened as pdf: 5 pages, fixed layout, textual, not annotatable (${m.format}, ${m.sections}, ${m.annotatable}${m.error ? `, ${m.error}` : ''})`)
  check((await loaded()).split(',').includes('pdf'), 'the PDF reader ran on the first PDF')
  check(await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 1. Sphinx')), 'page 1 is drawn with a text layer')
  // #1203: foliate's fixed layout re-renders a PDF page on every resize; the layers are replaced, never added to.
  const layers = () => framesValue(() => document.querySelector('.textLayer')?.textContent.includes('Page 1. Sphinx')
    && `${document.querySelectorAll('.textLayer').length}/${document.querySelectorAll('.annotationLayer').length}/${document.querySelectorAll('.textLayer span').length}`)
  const layersBefore = await layers()
  await page.setViewportSize({ width: 400, height: 740 })
  await page.waitForTimeout(1000)
  await page.setViewportSize({ width: 420, height: 760 })
  await page.waitForTimeout(1000)
  const layersAfter = await layers()
  check(layersBefore?.startsWith('1/1/') && layersAfter === layersBefore, `a resize re-renders page 1 without adding a layer or a span (text/annotation/spans ${layersBefore} → ${layersAfter})`)
  from = messages.length
  call('window.__fol.highlightSelection()')
  await waitFor(from, (x) => x.type === 'log' && /no highlights on a PDF yet/.test(x.msg), 'pdf highlight refused').catch(() => null)
  check(messages.slice(from).some((x) => x.type === 'log' && /no highlights on a PDF yet/.test(x.msg)) && !messages.slice(from).some((x) => x.type === 'store'), 'highlightSelection is refused on a PDF, nothing stored')
  const pdfStored = await turnSaves('a store after a PDF page turn')
  check(pdfStored?.position?.page === 2 && !('cfi' in pdfStored.position) && !('quote' in pdfStored.position), `a page turn saves { page: 2 }, no CFI, no quote (${JSON.stringify(pdfStored?.position)})`)
  m = await open('tsformat.pdf', JSON.stringify(pdfStored))
  check(m.restored.position === 'restored' && !!(await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 1, 'relocate to page 2').catch(() => null)), `reopened, the saved page is restored (${m.restored.position})`)
  // Drawn before the next open: an open over a page still rendering cancels it (pdf.js rejects, a page error).
  check(await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 2. Sphinx')), 'and page 2 is drawn')
  m = await open('tsformat.pdf', JSON.stringify({ ...pdfStored, position: { cfi: 'epubcfi(/6/4)', quote: 'Page 2', index: 1, fraction: 0.4, at: 1 } }))
  check(m.restored.position === 'wrong position kind, stayed at start', `a CFI position on a PDF is not applied (${m.restored.position})`)
  // #1203: a Named action or a ResetForm link (pdf.js asks the link service for getAnchorUrl) loses no link on its page.
  writeFileSync(resolve(dir, 'tslinks.pdf'), pdf(1, { title: 'TS LINKS', annots: [[
    '<< /Type /Annot /Subtype /Link /Rect [40 700 560 720] /Border [0 0 0] /A << /S /URI /URI (https://example.tst/a) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [40 660 560 680] /Border [0 0 0] /A << /S /Named /N /NextPage >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [40 620 560 640] /Border [0 0 0] /A << /S /ResetForm >> >>',
  ]] }))
  m = await open('tslinks.pdf')
  check(m.type === 'opened' && await shown(() => document.querySelectorAll('.annotationLayer section a').length === 3
    && !!document.querySelector('.annotationLayer a[href="https://example.tst/a"]'), m.stale), 'a page with a Named action and a ResetForm link draws all three of its links')
  // #1203, #1557: the last four visited pages are kept; a page's blob: URL is revoked once its frame has loaded it (never
  // by the eviction, which could beat a frame still loading), and the page is rebuilt on a revisit.
  m = await open('tsformat.pdf')
  await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 1. Sphinx'), m.stale)
  const pageUrl = () => page.frames().find((f) => f.url().startsWith('blob:') && !m.stale.has(f))?.url()
  const first = pageUrl()
  for (let i = 2; i <= 5; i++) {
    const at = messages.length
    await call('window.__fol.next()')
    await waitFor(at, (x) => x.type === 'relocate' && x.index === i - 1, `relocate to page ${i}`).catch(() => null)
  }
  await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 5. Sphinx'), m.stale)
  const fetches = (url) => call(`fetch(${JSON.stringify(url)}).then(() => true, () => false)`)
  const last = pageUrl()
  check(!!first && first !== last && !(await fetches(last)) && !(await fetches(first)), `after five pages, page 1's and page 5's blob: URLs are revoked, each once its frame loaded it (${!!first}, ${first !== last})`)
  await call('document.querySelector("foliate-view").goTo(0)')
  check(await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 1. Sphinx'), m.stale), 'and page 1 is rebuilt and drawn on a revisit')
  // #1557: a jump over more than four pages while pages still load (each goTo unawaited): every page shown loads its document,
  // the last one asked for is drawn.
  writeFileSync(resolve(dir, 'tsjump.pdf'), pdf(12, { title: 'TS JUMP' }))
  m = await open('tsjump.pdf')
  await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 1. Sphinx'), m.stale)
  const errorsBefore = pageErrors
  await call('{ const v = document.querySelector("foliate-view"); for (let i = 1; i < 12; i++) v.goTo(i) }')
  check(await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 12. Sphinx'), m.stale) && pageErrors === errorsBefore,
    `a jump over 11 pages while they load draws the last one, no page error (${pageErrors - errorsBefore})`)
  // #1557: the outline is read after `opened` and comes as `toc`, with the entry of the place on screen.
  m = await open('tsoutline.pdf')
  const tocMsg = await waitFor(m.from, (x) => x.type === 'toc', 'the outline').catch(() => null)
  const openedAt = messages.indexOf(messages.slice(m.from).find((x) => x.type === 'opened'))
  check(m.toc?.length === 0 && !!tocMsg && messages.indexOf(tocMsg) > openedAt && JSON.stringify(tocMsg.toc) === JSON.stringify([{ label: 'Start', href: tocMsg.toc[0]?.href, depth: 0 }, { label: 'Four', href: tocMsg.toc[1]?.href, depth: 0 }]) && tocMsg.tocIndex === 0 && tocMsg.key === m.book.sha256,
    `a PDF's outline arrives after \`opened\` (opened.toc ${m.toc?.length}, then ${JSON.stringify(tocMsg)})`)
  from = messages.length
  await call('window.__fol.goTo({ page: 4 })')
  const onFour = await waitFor(from, (x) => x.type === 'relocate' && x.index === 3, 'relocate to page 4').catch(() => null)
  check(onFour?.tocIndex === 1, `and the place's entry follows it (page 4: ${onFour?.tocIndex})`)
  // #1204: a JPEG 2000 image is drawn (OpenJPEG's wasm, carried in the page, compiled under 'wasm-unsafe-eval').
  check(!(await loaded()).split(',').includes('pdfwasm'), 'no wasm chunk has run for a PDF without a JPEG 2000 image')
  m = await open('tsjpx.pdf')
  const red = async () => {
    for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await page.waitForTimeout(100)) {
      const px = await framesValue(() => {
        const c = document.querySelector('#canvas canvas')
        if (!c) return null
        // The image's middle: 200×200 pt at (40, 300) from the bottom-left of a 600×800 pt page.
        const d = c.getContext('2d').getImageData(Math.round(c.width * 140 / 600), Math.round(c.height * 400 / 800), 1, 1).data
        return d[0] > 150 && d[1] < 80 && d[2] < 80 ? [...d].join(',') : null
      })
      if (px) return px
    }
    return null
  }
  const jpxPixel = await red()
  check(m.type === 'opened' && !!jpxPixel, `a PDF's JPEG 2000 image is drawn (${m.type}${m.error ? `, ${m.error}` : ''}; pixel ${jpxPixel})`)
  check((await loaded()).split(',').includes('pdfwasm'), 'the wasm chunk ran for it')
  check(!(await loaded()).split(',').includes('pdfcmaps'), 'no cMap chunk has run for a Latin PDF')
  m = await open('tscjk.pdf')
  check(m.type === 'opened' && await shown(() => document.querySelector('.textLayer')?.textContent.includes('中文')), `a CJK PDF on a predefined cMap opens and draws its text (${m.type})`)
  check((await loaded()).split(',').includes('pdfcmaps'), 'the cMap chunk ran for it')
  const seen = (await violations()).slice(before)
  check(seen.length === 0, `no CSP violation while reading a PDF (${seen.join('; ')})`)

  // #1426: `describe` reads each format's details and cover from a file of its own while a book is open, and never
  // touches that book; then the book on screen.
  console.log('describe')
  const described = async (id, url) => {
    const at = messages.length
    await call(`window.__fol.describe(${JSON.stringify(id)}, ${JSON.stringify(url)})`)
    const d = await waitFor(at, (x) => x.type === 'described' && x.id === id, `${id} described`)
    return { ...d, disturbed: messages.slice(at).some((x) => ['opened', 'open-failed', 'selection-cleared', 'lightbox'].includes(x.type)) }
  }
  const jpeg = (c) => typeof c === 'string' && c.startsWith('data:image/jpeg;base64,') && c.length <= 1.5 * 1024 * 1024
  for (const [file, title, author, cover] of [['tsformat.epub', 'TS EPUB', 'Ada Writer, Bo Second', true], ['tsformat.mobi', 'TS MOBI', '', false],
    ['tsformat.fb2', 'TS FB2', 'Test Author', false], ['tsformat.cbz', '', '', true], ['tsformat.pdf', 'TS PDF', null, true]]) {
    const d = await described(file, bookAt(file))
    check(!d.error && d.meta?.title === title && (author === null || d.meta.author === author) && (cover ? jpeg(d.cover) : d.cover === null) && !d.disturbed,
      `${file} is described: "${d.meta?.title}" by "${d.meta?.author}", cover ${d.cover ? `${d.cover.slice(0, 23)}… ${d.cover.length} chars` : 'none'}${d.error ? `, ${d.error}` : ''}`)
    // ADR-033 P3: the contents the server keeps, keyed by chapters.mjs, where each starts on the progress scale; a PDF
    // with no outline has none (a fixed layout's pages are no chapters).
    const toc = Array.isArray(d.toc) ? d.toc : []
    check((file === 'tsformat.pdf' ? toc.length === 0 : toc.length > 0) && toc.every((e, i) => /^(toc|section)-\d+$/.test(e.key) && e.title && e.fraction >= 0 && e.fraction <= 1 && (i === 0 || e.fraction >= toc[i - 1].fraction)),
      `${file}'s contents for the server: ${toc.length}, ${JSON.stringify(toc.slice(0, 3))}`)
    if (file === 'tsformat.epub') check(d.meta?.lang === 'en' && d.meta.description === 'A small book.', `its language is the primary subtag, its HTML description text (${d.meta?.lang}, ${d.meta?.description})`)
  }
  const outlined = await described('outline', bookAt('tsoutline.pdf'))
  check(JSON.stringify(outlined.toc) === JSON.stringify([{ key: 'toc-0', title: 'Start', depth: 0, fraction: 0 }, { key: 'toc-1', title: 'Four', depth: 0, fraction: 0.6 }]),
    `a PDF's outline is its contents, each entry where its page starts (${JSON.stringify(outlined.toc)})`)
  const bad = await described('bad', bookAt('tsplain.txt'))
  check(bad.meta === null && bad.cover === null && /not a book this reader opens/.test(bad.error) && !bad.disturbed, `a file that is no book is described with an error (${bad.error})`)
  const onScreen = await described('screen', null)
  check(!onScreen.error && onScreen.meta?.title === 'TS CJK' && jpeg(onScreen.cover) && !onScreen.disturbed, `without a url the book on screen is described, its first page the cover (${onScreen.meta?.title ?? onScreen.error})`)

  // A refusal is decided before the open book is torn down: it keeps reading, saving and its telemetry session.
  console.log('refused')
  m = await open('tsformat.epub')
  const alive = messages.length
  const azw3 = readFileSync(resolve(dir, 'tssynthetic-kf8.azw3'))
  const r0 = azw3.readUInt32BE(78)
  const patched = (write) => { const b = Buffer.from(azw3); write(b); return b }
  writeFileSync(resolve(dir, 'tsdrm.azw3'), patched((b) => b.writeUInt16BE(2, r0 + 12)))
  writeFileSync(resolve(dir, 'tsdamaged.azw3'), patched((b) => b.writeUInt32BE(1, r0 + 252)))
  for (const [file, error] of [['tsdrm.mobi', /DRM/], ['tsdrm.azw3', /DRM/], ['tsdamaged.azw3', /truncated or damaged/], ['tskf8.mobi', /truncated or damaged/], ['tsplain.txt', /not a book this reader opens/], ['tslocked.pdf', /password-protected/]]) {
    const r = await open(file)
    check(r.type === 'open-failed' && error.test(r.error), `${file} is refused: ${r.error}`)
  }
  // Entities, nested (billion laughs), flat (a ×30k one hangs the page) or external: refused before the XML parser.
  const lol = ['<!ENTITY l0 "lol">', ...Array.from({ length: 9 }, (_, i) => `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`)].join('')
  writeFileSync(resolve(dir, 'tsbomb.fb2'), fb2('TS bomb', '<section><p>&l9;</p></section>', `<!DOCTYPE FictionBook [${lol}]>`))
  writeFileSync(resolve(dir, 'tsflat.fb2'), fb2('TS flat', `<section><p>${'&e;'.repeat(30000)}</p></section>`, `<!DOCTYPE FictionBook [<!ENTITY e "${'x'.repeat(800)}">]>`))
  writeFileSync(resolve(dir, 'tsxxe.fb2'), fb2('TS xxe', '<section><p>&x;</p></section>', '<!DOCTYPE FictionBook [<!ENTITY x SYSTEM "file:///etc/passwd">]>'))
  for (const file of ['tsbomb.fb2', 'tsflat.fb2', 'tsxxe.fb2']) {
    const r = await open(file).catch((e) => ({ type: 'hung', error: e.message }))
    check(r.type === 'open-failed' && /custom entities/.test(r.error), `${file} is refused before parsing: ${r.error}`)
  }
  check(!!(await turnSaves('a store after the refusals')), 'the EPUB open before the refusals still turns and saves')
  check(!messages.slice(alive).some((x) => x.type === 'telemetry'), 'and its telemetry session was not ended by them')

  console.log('pdf hostile')
  // The logging host, routed over https like the page (an http one is stopped by mixed content before the CSP or
  // any link handling could be tested). The control shows it answers a document without this page's CSP.
  const hits = []
  const evil = 'https://evil.tst:44443'
  const log = (r) => { hits.push(new URL(r.request().url()).pathname); return r.fulfill({ body: '' }) }
  await page.context().route(`${evil}/**`, log) // the context: a window a link opened is caught too
  const control = await browser.newPage()
  await control.route(`${evil}/**`, log)
  await control.evaluate((u) => fetch(u, { mode: 'no-cors' }).catch(() => {}), `${evil}/control`)
  await control.close()
  check(hits.includes('/control'), `control: the logging host is reachable (${hits.join(', ')})`)
  hits.length = 0
  writeFileSync(resolve(dir, 'tshostile.pdf'), hostilePdf(evil))
  m = await open('tshostile.pdf')
  check(m.type === 'opened' && m.format === 'pdf', `the hostile PDF opens (${m.type}${m.error ? `, ${m.error}` : ''})`)
  check(await shown(() => document.querySelectorAll('.annotationLayer section').length === 5), 'its five link annotations are drawn')
  let links = []
  for (const f of page.frames().filter((f) => f.url().startsWith('blob:'))) {
    const at = await f.evaluate(() => getComputedStyle(frameElement.parentElement).display === 'none' ? [] : [...document.querySelectorAll('.annotationLayer section')].map((s) => {
      const r = s.getBoundingClientRect(), fr = frameElement.getBoundingClientRect()
      return { x: fr.left + r.left + r.width / 2, y: fr.top + r.top + r.height / 2 }
    })).catch(() => [])
    if (at.length) links = at
  }
  from = messages.length
  for (const l of links) { await page.mouse.click(l.x, l.y); await page.waitForTimeout(200) }
  await page.waitForTimeout(1000) // a script or a navigation the clicks started has had its turn
  const pwned = (await Promise.all(page.frames().map((fr) => fr.evaluate(() => !!window.__pwned).catch(() => false)))).some(Boolean)
  check(links.length === 5 && !pwned, `no PDF script ran (OpenAction, JavaScript link, javascript: URI; ${links.length} links clicked)`)
  check(hits.length === 0, `nothing reached the logging server (${hits.join(', ')})`)
  check(page.frames().every((fr) => (fr.url() === PAGE_URL || /^(blob:|about:blank)/.test(fr.url()))), `no frame left the book (${page.frames().map((fr) => fr.url().slice(0, 30)).join(', ')})`)
  // pdf.js turns a GoToR whose file is an http URL into that URL: handed to the host's allowlist like any http link
  // in an EPUB. The Launch and script ones never.
  const handed = messages.slice(from).filter((x) => x.type === 'openLink').map((x) => x.href)
  check(handed.length === 2 && handed[0].startsWith(`${evil}/gotor.pdf`) && handed[1] === `${evil}/uri`, `only the two http links are handed to the host, never followed (${handed.join(', ')})`)

  // #1204: pdf.js parses in a Worker: a decompression bomb (1 GiB of XMP in 2 KB) keeps that worker busy, not the
  // page; past its deadline (shortened here, by default the host's `opened` deadline for the file) the worker is
  // terminated and the open fails, the book on screen still reading.
  console.log('pdf bomb')
  writeFileSync(resolve(dir, 'tsbomb.pdf'), bombPdf())
  m = await open('tsformat.pdf')
  await call('window.__fol.__testPdfDeadline(1000)')
  await call('window.__gap = 0; window.__tick = performance.now(); window.__ticker = setInterval(() => { const t = performance.now(); window.__gap = Math.max(window.__gap, t - window.__tick); window.__tick = t }, 20)')
  const bombAt = Date.now()
  const bomb = await open('tsbomb.pdf')
  const bombMs = Date.now() - bombAt
  const gap = await call('clearInterval(window.__ticker), Math.round(window.__gap)')
  await call('window.__fol.__testPdfDeadline(0)')
  check(bomb.type === 'open-failed' && /took too long/.test(bomb.error) && bombMs < 1000 + 5000, `the bomb fails at its deadline (${bomb.type}: ${bomb.error}, ${bombMs} ms)`)
  check(!messages.slice(bomb.from).some((x) => x.type === 'book-stopped'), 'a failed open says `open-failed` only, never `book-stopped`')
  check(gap < 500, `and the page answers all the while (longest gap between 20 ms ticks: ${gap} ms)`)
  check(!!(await turnSaves('a store after the bomb')), 'the PDF open before it still turns and saves')
  m = await open('tsformat.pdf')
  // Drawn before the next open (an open over a page still rendering cancels it: a page error).
  check(m.type === 'opened' && await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 1. Sphinx'), m.stale), `a PDF opens and draws after it (${m.type})`)
  // #1204 review: a page that never finishes drawing after `opened` (the bomb as page 2's content) terminates the worker at
  // its page budget (PDF_PAGE_MS; shortened here) and the hosts are told, `book-stopped` for that book; the page answers.
  writeFileSync(resolve(dir, 'tsbombpage.pdf'), bombPagePdf())
  await call('window.__fol.__testPdfDeadline(1000)')
  m = await open('tsbombpage.pdf')
  await call('window.__gap = 0; window.__tick = performance.now(); window.__ticker = setInterval(() => { const t = performance.now(); window.__gap = Math.max(window.__gap, t - window.__tick); window.__tick = t }, 20)')
  from = messages.length
  const turnAt = Date.now()
  call('window.__fol.next()')
  const stopped = await waitFor(from, (x) => x.type === 'book-stopped', 'book-stopped').catch(() => null)
  const stoppedMs = Date.now() - turnAt
  const pageGap = await call('clearInterval(window.__ticker), Math.round(window.__gap)')
  await call('window.__fol.__testPdfDeadline(0)')
  check(m.type === 'opened' && stopped?.key === m.book.sha256 && /took too long/.test(stopped?.error) && stoppedMs < 1000 + 5000,
    `a page past its budget after \`opened\` says \`book-stopped\` for its book (${m.type}; ${JSON.stringify(stopped)}, ${stoppedMs} ms)`)
  check(pageGap < 500 && messages.slice(from).filter((x) => x.type === 'book-stopped').length === 1, `once, and the page answers all the while (longest gap: ${pageGap} ms)`)
  m = await open('tsformat.pdf')
  check(m.type === 'opened' && await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 1. Sphinx'), m.stale), `the next PDF opens and draws (${m.type})`)

  console.log('alignment')
  writeAlignmentEpub(resolve(dir, 'tsalignment.epub'))
  await call('window.__fol.settings({textAlign:"center"})')
  m = await open('tsalignment.epub')
  const hasAlignment = async (expected, chapter) => {
    for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await page.waitForTimeout(100)) {
      for (const f of page.frames().filter((f) => f.url().startsWith('blob:'))) {
        if (await f.evaluate(({ expected, chapter }) => {
          if (document.querySelector('h1')?.textContent !== `Alignment ${chapter}`) return false
          return ['plain', 'class', 'inline', 'div'].every((id) => {
            const el = document.getElementById(id)
            return el && getComputedStyle(el).textAlign === expected[id]
          })
        }, { expected, chapter }).catch(() => false)) return true
      }
    }
    return false
  }
  const uniform = (value) => Object.fromEntries(['plain', 'class', 'inline', 'div'].map((id) => [id, value]))
  check(await hasAlignment(uniform('center'), 1), 'chosen centre applies on first load, over publisher classes, inline !important and div text')
  for (const [textAlign, css] of [['left', 'start'], ['justify', 'justify'], ['center', 'center']]) {
    await call(`window.__fol.settings(${JSON.stringify({ textAlign })})`)
    check(await hasAlignment(uniform(css), 1), `live alignment: ${textAlign} wins over publisher CSS`)
  }
  await call('document.querySelector("foliate-view").goTo(1)')
  check(await hasAlignment(uniform('center'), 2), 'chosen alignment applies when the next chapter loads')
  await call('window.__fol.settings({textAlign:"book"})')
  check(await hasAlignment({ plain: 'start', class: 'justify', inline: 'right', div: 'justify' }, 2), 'book mode restores publisher class and inline alignment')

  console.log('saved quotations')
  const selectPlain = () => shown(() => {
    const p = document.getElementById('plain')
    if (!p || document.querySelector('h1')?.textContent !== 'Alignment 2') return false
    const range = document.createRange()
    range.selectNodeContents(p)
    const selection = document.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  })
  await selectPlain()
  from = messages.length
  await call('window.__fol.saveQuotation()')
  const quoted = await storeFrom(from, 'saved quotation')
  const quotation = quoted?.highlights.find(h => h.color === 'quote')
  check(quotation?.selectedText === 'Plain paragraph.', 'a selection is saved intact as an anchored quotation')
  const noPaint = () => call('document.querySelector("foliate-view").renderer.getContents().every(c => !c.overlayer.element.querySelector("g"))')
  check(await noPaint(), 'saving a quotation does not paint a highlight')
  await selectPlain()
  from = messages.length
  await call('window.__fol.saveQuotation()')
  const sameQuote = await waitFor(from, x => x.type === 'highlighted', 'same quotation reused')
  check(sameQuote.id === quotation?.id, 'saving the same range again reuses its quotation')
  await open('tsalignment.epub', JSON.stringify(quoted))
  await call('document.querySelector("foliate-view").goTo(1)')
  check(await noPaint(), 'restored quotations remain unpainted')
  await call(`window.__fol.goTo(${JSON.stringify(quotation?.cfi)}, true)`)
  const beforeBookmark = messages.length
  await call('window.__fol.addBookmark()')
  const bookmarkedQuote = JSON.parse((await waitFor(beforeBookmark,
    x => x.type === 'store' && JSON.parse(x.json).highlights.some(h => h.color === 'bookmark'),
    'bookmark at a quotation')).json)
  const bookmark = bookmarkedQuote?.highlights.find(h => h.color === 'bookmark')
  check(bookmarkedQuote?.highlights.filter(h => h.color === 'bookmark').length === 1
    && bookmarkedQuote?.highlights.filter(h => h.color === 'quote').length === 1,
  'a quotation does not block a separate bookmark at the same location')
  if (bookmark) {
    await open('tsalignment.epub', JSON.stringify(bookmarkedQuote))
    check(await call('window.__fol.placedBookmarks()') === 1, 'restoring a quotation does not increase the bookmark count')
    const removeFrom = messages.length
    await call(`window.__fol.removeBookmark(${JSON.stringify(bookmark.id)})`)
    await storeFrom(removeFrom, 'removed bookmark beside quotation')
  }
  from = messages.length
  await call(`window.__fol.removeHighlight(${JSON.stringify(quotation?.id)})`)
  const removedQuote = JSON.parse((await waitFor(from,
    x => x.type === 'store' && !JSON.parse(x.json).highlights.some(h => h.id === quotation?.id),
    'removed quotation')).json)
  check(removedQuote && !removedQuote.highlights.some(h => h.id === quotation?.id), 'a saved quotation can be removed and persisted')

  console.log('offline reader fonts')
  for (const [fontFamily, name] of [['serif', 'TextStack'], ['serif', 'Literata'], ['sans', 'TextStack Source Sans 3'], ['dyslexic', 'TextStack OpenDyslexic']]) {
    await call(`window.__fol.settings(${JSON.stringify({ fontFamily })})`)
    let loadedFont = false
    for (const f of page.frames().filter((f) => f.url().startsWith('blob:'))) {
      loadedFont ||= await f.evaluate(async ({ name, fontFamily }) => {
        if (document.querySelector('h1')?.textContent !== 'Alignment 2') return false
        if (!['plain', 'class', 'inline', 'div'].every((id) => getComputedStyle(document.getElementById(id)).fontFamily.includes(name))) return false
        for (const face of fontFamily === 'dyslexic' ? ['400'] : ['400', '700', 'italic 400', 'italic 700']) {
          const loaded = await document.fonts.load(`${face} 20px "${name}"`)
          if (loaded.length !== 1 || loaded[0].status !== 'loaded') return false
        }
        return true
      }, { name, fontFamily }).catch(() => false)
    }
    check(loadedFont, `${name}: embedded faces load and beat publisher text fonts without network access`)
  }

  for (const alsoClone of [false, true]) (await oldWebView(alsoClone))()

  // Every page error, last so every block above is covered; refusals log theirs as `open: …`.
  for (const x of messages) if (x.type === 'log' && x.level === 'error' && !/^open: /.test(x.msg)) check(false, `page error: ${x.msg.split('\n')[0]}`)
} catch (e) {
  check(false, String(e?.message ?? e))
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n[check:reader-formats] ${failures.length ? 'FAILED' : 'ok'}`)
process.exit(failures.length ? 1 : 0)
