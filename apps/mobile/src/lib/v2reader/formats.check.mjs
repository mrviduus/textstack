// The format check (#1128): the committed page, in Chromium as file:// (the dev route's origin), opens one
// small book per format (fixtures.mjs writeFormatFixtures) and must answer as README "Formats" says:
// each format reader runs only when its first book opens, CBZ has no text features and still saves and
// restores its page, a fraction-only position (#1187) restores without saving, a synthetic KF8 (#1182) reads,
// a DRM-flagged MOBI or KF8, a damaged KF8 and an unknown file are refused, and flow() switches the live view
// and is reported once per book in `telemetry`. PDF (#1128 S5): opens through pdf.js on the page's main
// thread, pages, selects, saves and resumes by `pdf-page`, a password-protected one fails leaving the open
// book reading, and a hostile PDF neither runs script nor leaves the file.
//
//   node --experimental-strip-types formats.check.mjs      (pnpm -C apps/web check:v2-reader-formats)
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fb2, hostilePdf, pdf, writeFormatFixtures } from './fixtures.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(resolve(here, '../../../../web/package.json'))('@playwright/test')
const TIMEOUT_MS = 15000

const failures = []
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }

const dir = mkdtempSync(resolve(tmpdir(), 'ts-v2-formats-'))
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] })
try {
  writeFormatFixtures(dir)
  for (const f of ['tssynthetic-kf8.azw3', 'tssynthetic-combo.mobi']) copyFileSync(resolve(here, 'synthetic', f), resolve(dir, f))
  writeFileSync(resolve(dir, 'tsplain.txt'), 'plain text, no book')
  writeFileSync(resolve(dir, 'page.html'), v2ReaderPageHtml(randomBytes(18).toString('base64')))
  const page = await browser.newPage()
  const messages = []
  page.on('pageerror', (e) => check(false, `pageerror: ${e.message}`))
  await page.exposeFunction('__toHost', (json) => messages.push(JSON.parse(json)))
  await page.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
  // Every CSP violation in any frame of the page, as `directive blockedURI`.
  await page.addInitScript(() => addEventListener('securitypolicyviolation', (e) => (top.__violations ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)))
  await page.goto(pathToFileURL(resolve(dir, 'page.html')).href)

  /** The first message from `from` on that matches. */
  const waitFor = async (from, match, what) => {
    for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await page.waitForTimeout(50)) {
      const m = messages.slice(from).find(match)
      if (m) return m
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const call = (js) => page.evaluate(js)
  const loaded = () => call('Object.keys(window.__tsFormats).sort().join(",")')
  /** Opens `file`; resolves with `opened` or `open-failed`, after `restored` for an opened book. */
  const open = async (file, stored = null) => {
    const from = messages.length
    await call(`window.__fol.openUrl(${JSON.stringify(pathToFileURL(resolve(dir, file)).href)}, ${JSON.stringify(file)})`)
    const m = await waitFor(from, (x) => (x.type === 'opened' || x.type === 'open-failed') && (x.book?.name ?? x.name) === file, `${file} to open`)
    if (m.type === 'opened') {
      await call(`window.__fol.restore(${JSON.stringify(stored)})`)
      m.restored = await waitFor(from, (x) => x.type === 'restored', `${file} restored`)
    }
    return { ...m, from }
  }
  /** Polls the section frames (blob:) until one passes `probe`, run inside it. */
  const shown = async (probe) => {
    for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await page.waitForTimeout(100)) {
      for (const f of page.frames().filter((f) => f.url().startsWith('blob:'))) if (await f.evaluate(probe).catch(() => false)) return true
    }
    return false
  }
  const showsText = () => shown(() => document.body?.innerText.includes('Paragraph 1. Sphinx'))

  /**
   * PDF (#1128 S5): opens through pdf.js run on the page's main thread, under the unchanged CSP; pages;
   * selects; saves `{ page }` (pdf-page, section index + 1) and resumes there; refuses the other position
   * kinds; a password-protected PDF fails and the open book keeps reading; a hostile PDF neither runs
   * script nor leaves the file. In a portrait view, as on a phone.
   */
  async function checkPdf() {
    console.log('pdf')
    await page.setViewportSize({ width: 420, height: 760 })
    const violations = () => call('window.__violations ?? []')
    const before = (await violations()).length
    const settle = () => page.waitForTimeout(1200)
    const storesFrom = (from) => messages.slice(from).filter((x) => x.type === 'store').map((x) => JSON.parse(x.json).position)
    const t0 = Date.now()
    let m = await open('tsformat.pdf')
    check(m.type === 'opened' && m.format === 'pdf' && m.textual === true && m.annotatable === false && m.reflowable === false && m.sections === 5 && m.title === 'TS PDF',
      `opened as pdf: 5 pages, fixed layout, textual, not annotatable (${m.format}, ${m.sections}, ${m.annotatable}, ${m.title}${m.error ? `, ${m.error}` : ''}) in ${Date.now() - t0} ms`)
    check((await loaded()).split(',').includes('pdf'), 'the PDF reader ran on the first PDF')
    const textLayer = (n) => shown(new Function(`return !!document.querySelector('.textLayer')?.textContent.includes('Page ${n}. Sphinx')`))
    check(await textLayer(1), 'page 1 is drawn with a text layer')
    /** The section frame on screen. */
    const frame = async () => {
      for (const f of page.frames().filter((f) => f.url().startsWith('blob:')))
        if (await f.evaluate(() => getComputedStyle(frameElement.parentElement).display !== 'none' && !!document.querySelector('.textLayer span')).catch(() => false)) return f
    }
    // A selection in the text layer, as a long-press makes one.
    const f1 = await frame()
    const selected = await f1?.evaluate(() => { const s = getSelection(); s.selectAllChildren(document.querySelector('.textLayer')); return s.toString() })
    check(/Sphinx of black quartz/.test(selected ?? ''), 'its text layer selects')
    let from = messages.length
    call('window.__fol.highlightSelection()')
    await waitFor(from, (x) => x.type === 'log' && /no highlights on a PDF yet/.test(x.msg), 'pdf highlight refused')
    check(!messages.slice(from).some((x) => x.type === 'store'), 'highlightSelection is refused on a PDF (no pdf-page anchor yet), nothing stored')
    // A tap on a word: the word and its sentence, no CFI (nothing can be drawn at one on a PDF).
    await f1?.evaluate(() => getSelection().removeAllRanges())
    from = messages.length
    const at = f1 && await f1.evaluate(() => {
      const r = document.querySelector('.textLayer span').getBoundingClientRect()
      const fr = frameElement.getBoundingClientRect()
      return { x: fr.left + r.left + r.width * 0.3, y: fr.top + r.top + r.height / 2 }
    })
    if (at) await page.mouse.click(at.x, at.y)
    const word = await waitFor(from, (x) => x.type === 'word' || x.type === 'tap', 'a word or tap').catch(() => null)
    check(word?.type === 'word' && /\p{L}/u.test(word.word) && /Sphinx/.test(word.sentence) && word.cfi === null,
      `a tap on the text layer answers a word with its sentence and no CFI (${word?.type} ${word?.word ?? ''} ${word?.cfi})`)
    call(`window.__fol.showTranslation('epubcfi(/6/2!/4/2/1:0)', 0, 'x')`)
    from = messages.length
    call('window.__fol.next()')
    let stored = await storeFrom(from, 'a store after a page turn')
    const p = stored?.position
    check(p?.page === 2 && p.index === 1 && !('cfi' in p) && !('quote' in p), `the page turn saved { page: 2 }, no CFI, no quote (${JSON.stringify(p)})`)
    check(await textLayer(2), 'page 2 is drawn with a text layer')
    for (const step of ['next', 'next', 'prev']) { call(`window.__fol.${step}()`); await page.waitForTimeout(400) }
    await page.waitForTimeout(800)
    stored = JSON.parse(messages.filter((x) => x.type === 'store').at(-1).json)
    check(stored.position?.page === 3, `next, next, prev: page 3 saved (${JSON.stringify(stored.position)})`)
    // A PDF that needs a password fails before the teardown: the PDF on screen keeps its page, turns and saves.
    m = await open('tslocked.pdf')
    check(m.type === 'open-failed' && /password-protected/.test(m.error), `a password-protected PDF fails to open: ${m.error}`)
    from = messages.length
    call('window.__fol.next()')
    const afterLocked = await storeFrom(from, 'a store after a failed PDF open')
    check(afterLocked?.position?.page === 4 && afterLocked.book.sha256 === stored.book.sha256, `and the PDF on screen turns and saves page 4 (${JSON.stringify(afterLocked?.position)})`)
    m = await open('tsformat.pdf', JSON.stringify(stored))
    check(m.restored.position === 'restored', `reopened, the saved page is restored (${m.restored.position})`)
    check(!!(await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 2, 'relocate to page 3').catch(() => null)), 'and the view shows page 3')
    check(await textLayer(3), 'page 3 is drawn')
    await page.waitForTimeout(600)
    check(storesFrom(m.from).length === 0, 'the restore saved nothing')
    const pdfBook = m.book
    // Scheme fits the file: a CFI or a fraction is never applied to a PDF, a page number never to another format.
    const pdfEntry = (position) => JSON.stringify({ v: 1, book: pdfBook, highlights: [], position })
    m = await open('tsformat.pdf', pdfEntry({ cfi: 'epubcfi(/6/4)', quote: 'Page 2', index: 1, fraction: 0.4, at: 1 }))
    check(m.restored.position === 'wrong position kind, stayed at start', `a CFI position on a PDF is not applied (${m.restored.position})`)
    m = await open('tsformat.pdf', pdfEntry({ fraction: 0.8, at: 1 }))
    check(m.restored.position === 'wrong position kind, stayed at start', `a fraction-only position on a PDF is not applied (${m.restored.position})`)
    m = await open('tsformat.pdf', pdfEntry({ page: 9, index: 8, fraction: 1, at: 1 }))
    check(m.restored.position === 'page not found, stayed at start', `a page past the end is not applied (${m.restored.position})`)
    m = await open('tsformat.fb2')
    m = await open('tsformat.fb2', JSON.stringify({ v: 1, book: m.book, highlights: [], position: { page: 2, index: 1, fraction: 0.5, at: 1 } }))
    check(m.restored.position === 'wrong position kind, stayed at start', `a page number on an FB2 is not applied (${m.restored.position})`)
    from = messages.length
    call('window.__fol.goTo({ page: 2, index: 1, fraction: 0.5, at: 2 })')
    await waitFor(from, (x) => x.type === 'log' && /wrong position kind/.test(x.msg), 'a page goTo on an FB2 ignored')
    check(true, 'a host goTo { page } on an FB2 is ignored')
    // A host goTo by page (a sync adopt): arrives, saves nothing; a CFI or fraction goTo is ignored.
    m = await open('tsformat.pdf', JSON.stringify(stored))
    await settle()
    from = messages.length
    call('window.__fol.goTo({ page: 5, index: 4, fraction: 1, at: 2 })')
    check(!!(await waitFor(from, (x) => x.type === 'relocate' && x.index === 4, 'relocate to page 5').catch(() => null)), 'a host goTo { page: 5 } arrives')
    await settle()
    check(storesFrom(from).length === 0, 'and saves nothing')
    for (const target of [{ cfi: 'epubcfi(/6/4)', quote: 'Page 2', index: 1, fraction: 0.4, at: 3 }, { fraction: 0.2, at: 3 }, 'epubcfi(/6/6!/4/2/1:0)']) {
      from = messages.length
      call(`window.__fol.goTo(${JSON.stringify(target)})`)
      await waitFor(from, (x) => x.type === 'log' && /wrong position kind/.test(x.msg), 'a wrong-kind goTo ignored')
      await page.waitForTimeout(300)
      check(!messages.slice(from).some((x) => x.type === 'relocate' || x.type === 'store'), `a host goTo ${typeof target === 'string' ? 'raw CFI' : Object.keys(target).join('+')} on a PDF is ignored: no move, no save`)
    }
    // The page holds the goTo's page as its own: the next save (a page turn back) is page 4, once.
    from = messages.length
    call('window.__fol.prev()')
    const back = await storeFrom(from, 'a store after a turn following a host goTo')
    check(back?.position?.page === 4, `the next page turn saves page 4 (${JSON.stringify(back?.position)})`)
    // Chosen (a taken offer): the page it landed on is saved, once.
    await settle()
    from = messages.length
    call('window.__fol.goTo({ page: 2, index: 1, fraction: 0.4, at: 4 }, true)')
    const chosen = await storeFrom(from, 'a store after a chosen page goTo')
    await settle()
    check(chosen?.position?.page === 2 && storesFrom(from).length === 1, `a chosen goTo { page: 2 } saves page 2, once (${JSON.stringify(storesFrom(from))})`)
    // A predefined cMap (CJK): the cMap chunk runs on first need, and the text draws and extracts.
    check(!(await loaded()).split(',').includes('pdfcmaps'), 'no cMap chunk has run for a Latin PDF')
    m = await open('tscjk.pdf')
    check(m.type === 'opened' && m.format === 'pdf', `a CJK PDF on a predefined cMap opens (${m.type})`)
    check(await shown(() => document.querySelector('.textLayer')?.textContent.includes('中文')), 'its text layer has the CJK text')
    check((await loaded()).split(',').includes('pdfcmaps'), 'the cMap chunk ran for it')
    const seen = (await violations()).slice(before)
    check(seen.length === 0, `no CSP violation while reading a PDF (${seen.join('; ')})`)

    console.log('pdf hostile')
    const hits = []
    const server = createServer((req, res) => { hits.push(req.url); res.end('') })
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
    try {
      const evil = `http://127.0.0.1:${server.address().port}`
      writeFileSync(resolve(dir, 'tshostile.pdf'), hostilePdf(evil))
      m = await open('tshostile.pdf')
      check(m.type === 'opened' && m.format === 'pdf', `the hostile PDF opens (${m.type}${m.error ? `, ${m.error}` : ''})`)
      check(await shown(() => document.querySelectorAll('.annotationLayer section').length > 0), 'its link annotations are drawn')
      const f = await frame()
      const links = await f?.evaluate(() => [...document.querySelectorAll('.annotationLayer section')].map((s) => {
        const r = s.getBoundingClientRect()
        const fr = frameElement.getBoundingClientRect()
        return { x: fr.left + r.left + r.width / 2, y: fr.top + r.top + r.height / 2 }
      })) ?? []
      check(links.length === 5, `five link annotations drawn (${links.length})`)
      from = messages.length
      for (const l of links) { await page.mouse.click(l.x, l.y); await page.waitForTimeout(200) }
      await page.waitForTimeout(1000)
      const pwned = (await Promise.all(page.frames().map((fr) => fr.evaluate(() => !!window.__pwned).catch(() => false)))).some(Boolean)
      check(!pwned, 'no PDF script ran (OpenAction, JavaScript link, javascript: URI)')
      check(hits.length === 0, `nothing reached the logging server (${hits.join(', ')})`)
      check(page.frames().every((fr) => /^(file:|blob:|about:blank)/.test(fr.url())), `no frame left the book (${page.frames().map((fr) => fr.url().slice(0, 30)).join(', ')})`)
      const handed = messages.slice(from).filter((x) => x.type === 'openLink').map((x) => x.href)
      // pdf.js turns a GoToR whose file is an http URL into that URL: a link like the URI one, handed to the
      // host's allowlist like any http link in an EPUB. The Launch and script ones never.
      check(handed.length === 2 && handed[0].startsWith(`${evil}/gotor.pdf`) && handed[1] === `${evil}/uri`,
        `only the two http links are handed to the host, never followed (${handed.join(', ')})`)
      const hostile = (await violations()).slice(before)
      console.log(`  info  CSP violations reported while the hostile PDF was open: ${hostile.length ? hostile.join('; ') : 'none'}`)
    } finally {
      server.close()
      await page.setViewportSize({ width: 1280, height: 720 })
    }
  }

  /**
   * #1128 S5 QA: the open order (the book made before the open one is torn down) and PDF edges, on a page
   * of its own. `known(reproduces, what)` is a bug this check documents and does not fix: it passes while the
   * bug reproduces, and fails once it is fixed, so the line is turned into a `check` then.
   */
  async function checkOpenOrder() {
    console.log('open order (S5 QA)')
    const known = (reproduces, what) => { console.log(`  ${reproduces ? 'bug ' : 'FIXED'}  ${what}`); if (!reproduces) failures.push(`known bug no longer reproduces, make it a check: ${what}`) }
    const qa = await browser.newPage()
    const msgs = []
    const pageErrors = []
    qa.on('pageerror', (e) => pageErrors.push(e.message))
    await qa.exposeFunction('__toHost', (json) => msgs.push(JSON.parse(json)))
    await qa.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
    await qa.goto(pathToFileURL(resolve(dir, 'page.html')).href)
    const run = (js) => qa.evaluate(js)
    const until = async (from, match, what) => {
      for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await qa.waitForTimeout(50)) { const m = msgs.slice(from).find(match); if (m) return m }
      throw new Error(`timed out waiting for ${what}`)
    }
    const send = (file) => run(`window.__fol.openUrl(${JSON.stringify(pathToFileURL(resolve(dir, file)).href)}, ${JSON.stringify(file)})`)
    const openQa = async (file, stored = null) => {
      const from = msgs.length
      await send(file)
      const m = await until(from, (x) => (x.type === 'opened' || x.type === 'open-failed') && (x.book?.name ?? x.name) === file, `${file} to open`)
      if (m.type === 'opened') {
        await run(`window.__fol.restore(${JSON.stringify(stored)})`)
        m.restored = await until(from, (x) => x.type === 'restored', `${file} restored`)
      }
      return { ...m, from }
    }
    const settle = () => qa.waitForTimeout(1200)
    const storesQa = (from) => msgs.slice(from).filter((x) => x.type === 'store')
    const views = () => run('document.querySelectorAll("foliate-view").length')
    const flag = (js) => (async () => { for (const t0 = Date.now(); !(await run(js)) && Date.now() - t0 < TIMEOUT_MS;) await qa.waitForTimeout(20) })()
    await until(0, (x) => x.type === 'ready', 'ready (open order)')
    await openQa('tsformat.pdf')
    // The PDF reader, spied: `__holdNext` holds the next makePDF until `__release()` / `__reject(e)`; `__destroyed` counts book.destroy().
    await run(`(() => {
      const f = window.__tsFormats.pdf, make = f.makePDF
      window.__destroyed = 0
      f.makePDF = async (...a) => {
        if (window.__holdNext) {
          window.__holdNext = false
          await new Promise((ok, no) => { window.__release = ok; window.__reject = no; window.__held = true })
        }
        const b = await make(...a), destroy = b.destroy
        b.destroy = () => { window.__destroyed++; return destroy() }
        return b
      }
    })()`)
    const password = `Object.assign(new Error('No password given'), { name: 'PasswordException' })`

    // One page per screen (spread 'none'): in a landscape view foliate would pair pages 2-3, and `next`
    // from page 1 then page 2 would save page 4. Each turn saves the page it shows.
    await qa.setViewportSize({ width: 1280, height: 720 })
    let m = await openQa('tsformat.pdf')
    const fmt = m.book
    // I6: the label is refused where `annotatable` is false (the call answers false, nothing is drawn).
    const label = `window.__fol.showTranslation('epubcfi(/6/2!/4/2/1:0)', 0, 'x')`
    check(await run(label) === false, 'showTranslation is refused on a PDF')
    let from = msgs.length
    for (const _ of [1, 2]) { run('window.__fol.next()'); await qa.waitForTimeout(500) }
    await settle()
    check(storesQa(from).map((s) => JSON.parse(s.json).position?.page).join() === '2,3', `landscape: next, next saves pages 2 then 3, never a spread (${storesQa(from).map((s) => JSON.parse(s.json).position?.page)})`)
    // I2 on a PDF: a resize (re-layout) and a tap save nothing.
    m = await openQa('tsformat.pdf', JSON.stringify({ v: 1, book: fmt, highlights: [], position: { page: 3, index: 2, fraction: 0.5, at: 1 } }))
    await settle()
    from = msgs.length
    await qa.setViewportSize({ width: 420, height: 760 })
    await settle()
    const cdp = await qa.context().newCDPSession(qa)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 380 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await settle()
    check(m.restored.position === 'restored' && storesQa(from).length === 0, `a restored PDF, resized and tapped, saves nothing (${m.restored.position}, ${JSON.stringify(storesQa(from).map((s) => JSON.parse(s.json).position))})`)

    // Leak: a PDF torn down for the next book keeps its pdf.js document (book.destroy() never called): every
    // PDF opened and left keeps its file's bytes (measured: +21 MB backing store per 20 MB PDF, none with destroy()).
    await run('window.__destroyed = 0')
    await openQa('tsformat.fb2')
    check(await run('window.__destroyed') === 1, `a PDF replaced by the next book is destroyed once (${await run('window.__destroyed')})`)
    // A PDF load that fails (a password) destroys its pdf.js loading task: the page takes it from getDocument.
    await run(`(() => {
      const lib = globalThis.pdfjsLib, get = lib.getDocument
      window.__tasksDestroyed = 0
      lib.getDocument = (p) => { const t = get.call(lib, p), d = t.destroy.bind(t); t.destroy = () => { window.__tasksDestroyed++; return d() }; return t }
    })()`)
    m = await openQa('tslocked.pdf')
    check(m.type === 'open-failed' && await run('window.__tasksDestroyed') === 1, `a PDF that fails to load destroys its loading task (${m.type}, ${await run('window.__tasksDestroyed')})`)

    // I4: a pending save of A (debounced 400 ms) survives B's failed open, under A's key.
    let a = await openQa('tsformat.fb2')
    await settle()
    from = msgs.length
    await run('window.__fol.next(); 0')
    await until(from, (x) => x.type === 'relocate', 'a relocate on A')
    await send('tslocked.pdf')
    await until(from, (x) => x.type === 'open-failed', 'B (password) failed')
    await settle()
    check(storesQa(from).length === 1 && storesQa(from)[0].key === a.book.sha256, `A's pending save lands under A's key after B failed (${storesQa(from).map((s) => s.key === a.book.sha256)})`)
    // …but is cancelled when B opens within the 400 ms: A's last turn is never saved (as before S5).
    a = await openQa('tsformat.fb2')
    await settle()
    from = msgs.length
    await run('window.__fol.next(); 0')
    await until(from, (x) => x.type === 'relocate', 'a relocate on A')
    await send('tsformat.epub')
    await until(from, (x) => x.type === 'opened', 'B opened')
    await settle()
    const flushed = storesQa(from)
    check(flushed.length === 1 && flushed[0].key === a.book.sha256 && JSON.parse(flushed[0].json).book.sha256 === a.book.sha256,
      `A's turn made under 400 ms before B opens is flushed under A's key at the swap, once, never under B's (${flushed.map((s) => s.key === a.book.sha256)})`)

    // I3: A turned while B is being made, B then fails: the turn is neither reported nor saved (A's listener
    // reads openSeq, already B's), and the place A shows is not saved until the reader moves again.
    a = await openQa('tsformat.fb2')
    await settle()
    await run('window.__holdNext = true; window.__held = false')
    from = msgs.length
    await send('tsformat.pdf')
    await flag('window.__held')
    await run('window.__fol.next(); 0')
    await settle()
    // A taken offer on A meanwhile runs on A's own chain and saves under A's key.
    const during = msgs.length
    await run('window.__fol.goTo({ fraction: 0.5, at: 1 }, true); 0')
    await settle()
    check(storesQa(during).length === 1 && storesQa(during)[0].key === a.book.sha256, `a chosen goTo on A while B is made saves under A's key (${storesQa(during).length})`)
    const shownPlace = await run(`document.querySelector('foliate-view').lastLocation?.cfi`)
    await run(`window.__fol.next(); 0`)
    await settle()
    await run(`window.__reject(${password}); 0`)
    await until(from, (x) => x.type === 'open-failed' && x.name === 'tsformat.pdf', 'B failed late in its make')
    await settle()
    const shown = await run(`document.querySelector('foliate-view').lastLocation?.cfi`)
    check(shown !== shownPlace, 'A turned while B was made')
    check(storesQa(from).some((s) => s.key === a.book.sha256 && JSON.parse(s.json).position?.cfi === shown) && msgs.slice(during).some((x) => x.type === 'relocate'),
      'a turn on A while B is made is reported (relocate) and saved under A\'s key')
    from = msgs.length
    await run('window.__fol.next(); 0')
    const later = await until(from, (x) => x.type === 'store', 'a store on A after B failed').catch(() => null)
    check(later?.key === a.book.sha256, 'after B failed, A turns and saves under its own key')

    // The open seq handed back (B failed before teardown) is reused: B made slowly, C fails fast (seq back to A's),
    // D takes B's old seq; B, released, passes its `mine === openSeq` check and replaces D on screen.
    await openQa('tsformat.fb2')
    await run('window.__holdNext = true; window.__held = false')
    from = msgs.length
    await send('tsformat.pdf')
    await flag('window.__held')
    await send('tslocked.pdf')
    await until(from, (x) => x.type === 'open-failed' && x.name === 'tslocked.pdf', 'C failed')
    await send('tsformat.epub')
    await until(from, (x) => x.type === 'opened' && x.book.name === 'tsformat.epub', 'D opened')
    await run('window.__release(); 0')
    await settle()
    const answered = msgs.slice(from).filter((x) => x.type === 'opened').map((x) => x.book.name)
    check(answered.join() === 'tsformat.epub' && await run(`document.querySelector('foliate-view').book.sections.length`) !== 5 && await views() === 1,
      `a superseded open never opens over the newest book, after a failed open in between (${answered})`)

    // While B is made, A is the book on screen: its restore is answered (S5 fix round).
    await openQa('tsformat.fb2')
    await run('window.__holdNext = true; window.__held = false')
    from = msgs.length
    await send('tsformat.pdf')
    await flag('window.__held')
    await run('window.__fol.restore(null); 0')
    const answeredA = await until(from, (x) => x.type === 'restored', 'A restored while B is made').catch(() => null)
    check(answeredA?.position === 'none', `a restore for A while B is made is answered (${JSON.stringify(answeredA)})`)
    await run('window.__release(); 0')
    await until(from, (x) => x.type === 'opened' && x.book.name === 'tsformat.pdf', 'B opened after A restored')

    // Superseded while made: destroyed, never opened; one view.
    await openQa('tsformat.fb2')
    await run('window.__holdNext = true; window.__held = false; window.__destroyed = 0')
    from = msgs.length
    await send('tsformat.pdf')
    await flag('window.__held')
    await send('tsformat.epub')
    await until(from, (x) => x.type === 'opened', 'C opened')
    await run('window.__release(); 0')
    await settle()
    check(msgs.slice(from).filter((x) => x.type === 'opened').map((x) => x.book.name).join() === 'tsformat.epub' && await run('window.__destroyed') === 1 && await views() === 1,
      'a PDF superseded while it is made is destroyed and never opened; one view')

    // A failure after the teardown (view.open throws): `open-failed`, nothing saved for either book, the next open works.
    a = await openQa('tsformat.fb2')
    await run(`(() => { const C = customElements.get('foliate-view'), o = C.prototype.open; C.prototype.open = async function () { C.prototype.open = o; throw new Error('late failure') } })()`)
    from = msgs.length
    m = await openQa('tsformat.epub')
    await run('window.__fol.next(); window.__fol.restore(null); 0')
    await settle()
    check(m.type === 'open-failed' && storesQa(from).length === 0 && !msgs.slice(from).some((x) => x.type === 'restored'), `a late failure answers open-failed, saves and restores nothing (${m.type})`)
    check((await openQa('tsformat.fb2')).restored?.position === 'none', 'and the next open works')

    // Shapes pdf.js survives or refuses before the teardown (the book on screen keeps reading).
    const src = pdf(5).toString('latin1')
    const shapes = {
      'tsjunk.pdf': [Buffer.concat([Buffer.alloc(900, 0x41), pdf(2)]), 'opened'],
      'tsxref.pdf': [Buffer.from(src.replace(/startxref\n\d+/, 'startxref\n99999'), 'latin1'), 'opened'],
      'tscount.pdf': [Buffer.from(pdf(1).toString('latin1').replace('/Count 1', '/Count 2147483647'), 'latin1'), 'opened'],
      'tshalf.pdf': [pdf(5).subarray(0, pdf(5).length >> 1), 'open-failed'],
      'tsnoise.pdf': [Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4000, 0x07)]), 'open-failed'],
    }
    for (const [file, [bytes, expected]] of Object.entries(shapes)) {
      writeFileSync(resolve(dir, file), bytes)
      a = await openQa('tsformat.fb2')
      m = await openQa(file)
      const ok = m.type === expected && (expected === 'opened' ? m.sections >= 1 : true)
      from = msgs.length
      if (m.type === 'open-failed') run('window.__fol.next()')
      const st = m.type === 'open-failed' ? await until(from, (x) => x.type === 'store', 'A saves after a refused PDF').catch(() => null) : null
      check(ok && (m.type === 'opened' || st?.key === a.book.sha256), `${file}: ${m.type} (${m.sections ?? m.error})${st ? ', the book on screen still saves' : ''}`)
    }
    writeFileSync(resolve(dir, 'tszero.pdf'), Buffer.from(pdf(1).toString('latin1').replace('/Count 1', '/Count 0').replace(/\/Kids \[[^\]]*\]/, '/Kids []'), 'latin1'))
    m = await openQa('tszero.pdf')
    from = msgs.length
    run('window.__fol.next()')
    const afterZero = await until(from, (x) => x.type === 'store', 'the book on screen saves after a zero-page PDF').catch(() => null)
    check(m.type === 'open-failed' && /this PDF has no pages/.test(m.error) && afterZero?.key === a.book.sha256,
      `a PDF with no page is refused before the swap; the book on screen still saves (${m.type}, ${m.error ?? m.sections})`)

    // A Named action (Print, NextPage…), like ResetForm and an attachment link, throws in pdf.js's annotation
    // layer (foliate's linkService has no getAnchorUrl): the page's whole annotation layer is lost, uncaught.
    const named = pdf(1, { title: 'TS NAMED', annots: [[
      '<< /Type /Annot /Subtype /Link /Rect [40 700 560 720] /Border [0 0 0] /A << /S /Named /N /NextPage >> >>',
      '<< /Type /Annot /Subtype /Link /Rect [40 660 560 680] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >> >>',
    ]] })
    writeFileSync(resolve(dir, 'tsnamed.pdf'), named)
    check(pageErrors.length === 0, `no page error before the Named-action PDF (${pageErrors.join('; ')})`)
    pageErrors.length = 0
    m = await openQa('tsnamed.pdf')
    await settle()
    let links = 0
    for (const f of qa.frames().filter((f) => f.url().startsWith('blob:'))) links += await f.evaluate(() => document.querySelectorAll('.annotationLayer section').length).catch(() => 0)
    known(m.type === 'opened' && links === 0 && pageErrors.some((e) => /getAnchorUrl/.test(e)), `a Named-action link drops every link of its page with an uncaught error (${links} links; ${pageErrors.join('; ').slice(0, 80)})`)
    // Let through: the known Named-action bug, and `next` on the dead view a late failure leaves (no renderer).
    const expectedError = (msg) => /^open: /.test(msg) || /getAnchorUrl/.test(msg) || /^navigation: TypeError: Cannot read properties of undefined \(reading 'next'\)/.test(msg)
    for (const x of msgs) if (x.type === 'log' && x.level === 'error' && !expectedError(x.msg)) check(false, `page error (open order): ${x.msg.split('\n')[0]}`)
    await qa.close()
    check(true, 'open order done')
  }

  await waitFor(0, (m) => m.type === 'ready', 'ready')
  check(await loaded() === '', 'no format reader has run before a book opens')

  console.log('epub')
  let m = await open('tsformat.epub')
  check(m.type === 'opened' && m.format === 'epub' && m.textual === true && m.annotatable === true && m.title === 'TS EPUB', `opened as epub, textual, annotatable (${m.format}, ${m.title})`)
  check(await loaded() === '', 'an EPUB runs no format reader')
  call('window.__fol.flow("scrolled")')
  check(await call('document.querySelector("foliate-view").renderer.getAttribute("flow")') === 'scrolled', 'flow("scrolled") switches the live renderer')
  check(!messages.slice(m.from).some((x) => x.type === 'ready'), 'the switch did not reload the page')
  const warns = messages.length
  call('window.__fol.flow("sideways")')
  await waitFor(warns, (x) => x.type === 'log' && /flow ignored/.test(x.msg), 'flow ignored')
  check(true, 'an unknown flow is ignored with a warn')

  console.log('mobi')
  m = await open('tsformat.mobi')
  const tel = messages.slice(m.from).find((x) => x.type === 'telemetry')
  check(tel?.event === 'reader-flow' && tel.format === 'epub' && tel.mode === 'scrolled' && tel.switchedInFirst5Min === true,
    `the next open ends the EPUB's telemetry session: ${JSON.stringify(tel)}`)
  check(m.type === 'opened' && m.format === 'mobi' && m.textual && m.title === 'TS MOBI' && m.sections === 2, `opened as mobi, 2 sections (${m.format}, ${m.title}, ${m.sections}${m.error ? `, ${m.error}` : ''})`)
  check(await loaded() === 'mobi', 'the MOBI reader ran on the first MOBI, and only it')
  check(await showsText(), 'its text is rendered')
  call('window.__fol.flow("paginated")')

  for (const file of ['tsformat.fb2', 'tsformat.fbz']) {
    console.log(file.split('.')[1])
    m = await open(file)
    check(m.type === 'opened' && m.format === 'fb2' && m.textual && m.title === 'TS FB2' && m.author === 'Test Author', `${file} opened as fb2 (${m.format}, ${m.title}, ${m.author}${m.error ? `, ${m.error}` : ''})`)
    check(await showsText(), 'its text is rendered')
  }
  check(await loaded() === 'fb2,mobi', 'the FB2 reader ran once, for FB2 and FBZ')
  const tel2 = messages.filter((x) => x.type === 'telemetry').at(-1)
  check(tel2?.format === 'fb2' && tel2.mode === 'paginated' && tel2.switchedInFirst5Min === false, `an unswitched session reports false: ${JSON.stringify(tel2)}`)

  console.log('cbz')
  m = await open('tsformat.cbz')
  check(m.type === 'opened' && m.format === 'cbz' && m.textual === false && m.annotatable === false && m.sections === 2, `opened as cbz, not textual nor annotatable, 2 pages (${m.format}, ${m.textual}, ${m.sections}${m.error ? `, ${m.error}` : ''})`)
  check(await loaded() === 'cbz,fb2,mobi', 'the CBZ reader ran on the first CBZ')
  check(await shown(() => document.querySelector('img')?.naturalWidth === 60), 'its first page image is rendered')
  let from = messages.length
  call('window.__fol.highlightSelection()')
  await waitFor(from, (x) => x.type === 'log' && /has no text/.test(x.msg), 'highlight refused')
  check(true, 'highlightSelection is refused on an image-only book')
  from = messages.length
  call('window.__fol.next()')
  const stored = await waitFor(from, (x) => x.type === 'store', 'a store after the page turn')
  const position = JSON.parse(stored.json).position
  check(position?.page === 'p02.png' && !('quote' in position) && position.cfi.startsWith('epubcfi('), `the page turn saved page 2 by its entry name, no quote (${JSON.stringify(position)})`)
  check(m.reflowable === false, 'opened.reflowable is false for a CBZ (hosts disable the flow toggle)')
  // flow() on a fixed layout changes nothing, so it is no switch.
  call('window.__fol.flow("scrolled")')
  m = await open('tsformat.cbz', stored.json)
  const cbzTel = messages.slice(m.from).find((x) => x.type === 'telemetry')
  check(cbzTel?.format === 'cbz' && cbzTel.switchedInFirst5Min === false, `a flow() on a CBZ is not reported as a switch: ${JSON.stringify(cbzTel)}`)
  call('window.__fol.flow("paginated")')
  check(m.restored.position === 'restored', `reopened, the saved page is restored (${m.restored.position})`)
  const at = await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 1, 'relocate to page 2').catch(() => null)
  check(!!at, 'and the view shows page 2')

  // Positions of the other shape: neither is applied (store.mjs keeps both shapes; restore tells them apart).
  const cbzBook = m.book
  m = await open('tsformat.cbz', JSON.stringify({ v: 1, book: cbzBook, highlights: [], position: { cfi: 'epubcfi(/6/4)', quote: 'Paragraph', index: 1, fraction: 1, at: 1 } }))
  check(m.restored.position === 'page not found, stayed at start', `a quoted position on a CBZ is not applied (${m.restored.position})`)
  m = await open('tsformat.fb2')
  // A CFI that does point at text (the book's own first relocate), so only the missing quote can refuse it.
  const textCfi = (await waitFor(m.from, (x) => x.type === 'relocate' && x.cfi, 'a relocate with a CFI')).cfi
  m = await open('tsformat.fb2', JSON.stringify({ v: 1, book: m.book, highlights: [], position: { cfi: textCfi, page: 'p02.png', index: 0, fraction: 0, at: 1 } }))
  check(m.restored.position === 'quote mismatch, stayed at start', `a page position on a textual book is not applied (${m.restored.position})`)

  // A fraction-only position (a transitional server locator, #1187): restored by fraction, and nothing
  // saved until the reader moves (the server's locator is not rewritten by opening the book).
  console.log('fraction')
  const fb2Book = m.book
  const byFraction = (position) => JSON.stringify({ v: 1, book: fb2Book, highlights: [], position })
  const settle = () => page.waitForTimeout(1200)
  const lastRelocate = (from) => messages.slice(from).filter((x) => x.type === 'relocate').at(-1)
  const storeFrom = (from, what) => waitFor(from, (x) => x.type === 'store', what).then((s) => JSON.parse(s.json)).catch(() => null)
  const storesFrom = (from) => messages.slice(from).filter((x) => x.type === 'store').map((x) => JSON.parse(x.json).position)
  /** The entry as the page holds it: a highlight on the shown page saves it whole. */
  const heldEntry = async () => {
    await call(`(() => { const c = document.querySelector('foliate-view').renderer.getContents()[0]; c.doc.getSelection().selectAllChildren(c.doc.querySelector('p')) })()`)
    await page.waitForTimeout(150)
    const from = messages.length
    call('window.__fol.highlightSelection()')
    return storeFrom(from, 'a store after a highlight')
  }
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  check(m.restored.position === 'restored by fraction', `a fraction-only position is restored (${m.restored.position})`)
  const far = await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 1 && x.fraction > 0.5, 'relocate near the end').catch(() => null)
  check(!!far, `and the view is past the start (${JSON.stringify(messages.filter((x) => x.type === 'relocate').at(-1))})`)
  // foliate relocates at the landed place again after `restored`: those relocates must not save either.
  await page.waitForTimeout(1500)
  check(!messages.slice(m.from).some((x) => x.type === 'store'), 'restoring by fraction saves nothing')
  // A host goTo (not chosen: a sync adopt or move) saves nothing, and the page takes its position as its own.
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.05, at: 2 })')
  await settle()
  check(storesFrom(from).length === 0, `a host fraction goTo saves nothing (${JSON.stringify(storesFrom(from))})`)
  const quietPos = (await heldEntry())?.position
  check(quietPos?.fraction === 0.05 && !('cfi' in quietPos), `and the page holds its fraction-only position, no CFI (${JSON.stringify(quietPos)})`)
  from = messages.length
  call('window.__fol.next()')
  const moved = await waitFor(from, (x) => x.type === 'store', 'a store after the reader moves').catch(() => null)
  check(JSON.parse(moved?.json ?? '{}').position?.cfi?.startsWith('epubcfi('), 'the reader moving saves a CFI position')
  m = await open('tsformat.fb2', byFraction({ fraction: 2, at: 1 }))
  check(m.restored.rejected === false && m.restored.position === 'none', `a fraction outside [0, 1] is not applied (${m.restored.position})`)
  from = messages.length
  call('window.__fol.next()')
  check(!!(await waitFor(from, (x) => x.type === 'store', 'a store after a refused fraction').catch(() => null)), 'and the book still turns and saves')

  // After a fraction landing (#1187 QA): the save rule holds the landing, and nothing more.
  console.log('fraction hold')
  for (const fraction of [0, 1]) {
    m = await open('tsformat.fb2', byFraction({ fraction, at: 1 }))
    await settle()
    check(m.restored.position === 'restored by fraction' && (fraction ? lastRelocate(m.from)?.fraction === 1 : lastRelocate(m.from)?.index === 0 && lastRelocate(m.from).fraction < 0.5) && !messages.slice(m.from).some((x) => x.type === 'store'),
      `fraction ${fraction} is restored at that end and saves nothing (${m.restored.position}, ${lastRelocate(m.from)?.fraction})`)
  }
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  await settle()
  const held = lastRelocate(m.from).cfi
  // A refused open, or one that fails before the teardown (a PDF that needs a password, #1128 S5), leaves
  // the held book as it was: it still turns and saves.
  check((await open('tsplain.txt')).type === 'open-failed', 'a non-book picked over a fraction landing is refused')
  check((await open('tslocked.pdf')).type === 'open-failed', 'a password-protected PDF picked over a fraction landing fails')
  from = messages.length
  call('window.__fol.next()')
  const afterRefusal = await storeFrom(from, 'a store after a refusal over a fraction landing')
  check(afterRefusal?.position?.cfi?.startsWith('epubcfi('), 'and the held book still turns and saves a CFI')
  // I5: once moved, coming back to the very place the fraction landed on is a move like any other.
  from = messages.length
  call('window.__fol.prev()')
  const back = await storeFrom(from, 'a store after moving back to the landing')
  check(back?.position?.cfi === held, `moving back onto the landed CFI saves it (${back?.position?.cfi} vs ${held})`)
  // A host CFI goTo (round 3): saves nothing; the next real page turn saves a CFI from the new place.
  // Chosen (a taken offer), the same CFI goTo saves where it landed.
  m = await open('tsformat.fb2')
  await settle()
  from = messages.length
  call(`window.__fol.goTo(${JSON.stringify(held)})`)
  await settle()
  check(storesFrom(from).length === 0 && lastRelocate(from)?.index === 1, `a host CFI goTo moves the view and saves nothing (${JSON.stringify(storesFrom(from))})`)
  from = messages.length
  call('window.__fol.prev()')
  const fromThere = await storeFrom(from, 'a store after a page turn following a host CFI goTo')
  check(fromThere?.position?.cfi?.startsWith('epubcfi(/6/4') && fromThere.position.index === 1, `and the next page turn saves a CFI from the new place (${fromThere?.position?.cfi})`)
  m = await open('tsformat.fb2')
  await settle()
  from = messages.length
  call(`window.__fol.goTo(${JSON.stringify(held)}, true)`)
  const reopened = await storeFrom(from, 'a store after a chosen CFI goTo in a reopened book')
  check(reopened?.position?.cfi === held, `a chosen CFI goTo saves the place it landed on (${reopened?.position?.cfi})`)
  // A host fraction goTo saves nothing, now or after foliate's relocates at the landing.
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.5, at: 3 })')
  await settle()
  check(storesFrom(from).length === 0, `a host fraction goTo saves nothing, then nothing (${storesFrom(from).length} stores)`)
  // The same right after `restored` (a host's sync adopt at open): the opening layout still relocates,
  // at the landing, after the goTo has settled; none of that may save, and the page holds the fraction.
  m = await open('tsformat.fb2')
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.9, at: 6 })')
  await settle()
  check(storesFrom(from).length === 0, `a host fraction goTo right after restored saves nothing (${JSON.stringify(storesFrom(from))})`)
  const early = (await heldEntry())?.position
  check(early?.fraction === 0.9 && !('cfi' in early), `and the page holds the fraction (${JSON.stringify(early)})`)

  // Highlights on an entry whose position is fraction-only: drawn, and kept by every later save.
  const hl = await call(`(() => {
    const v = document.querySelector('foliate-view')
    const c = v.renderer.getContents().find((x) => x.doc.querySelector('p'))
    const t = c.doc.querySelector('p').firstChild, i = t.data.indexOf('Sphinx')
    const r = c.doc.createRange(); r.setStart(t, i); r.setEnd(t, i + 6)
    return { id: '11111111-1111-4111-8111-111111111111', cfi: v.getCFI(c.index, r), index: c.index, quote: 'Sphinx', selectedText: 'Sphinx', prefix: '', suffix: '', color: 'yellow', at: 1 }
  })()`)
  m = await open('tsformat.fb2', JSON.stringify({ v: 1, book: fb2Book, highlights: [hl], position: { fraction: 0.9, at: 1 } }))
  check(m.restored.position === 'restored by fraction' && m.restored.highlights[0]?.status === 'restored', `a fraction-only entry's highlight is restored (${JSON.stringify(m.restored.highlights)})`)
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.2, at: 4 })')
  await settle()
  check(storesFrom(from).length === 0, 'a host fraction goTo on an entry with a highlight saves nothing')
  from = messages.length
  call('window.__fol.next()')
  const movedHl = await storeFrom(from, 'a store after a move with a highlight')
  check(movedHl?.highlights?.[0]?.id === hl.id && movedHl.position.cfi?.startsWith('epubcfi('), 'and so does the first real move')

  // A fixed-layout book (CBZ) lands a fraction on its page, quietly too, and saves its page once moved.
  m = await open('tsformat.cbz', JSON.stringify({ v: 1, book: cbzBook, highlights: [], position: { fraction: 0.9, at: 1 } }))
  await settle()
  check(m.restored.position === 'restored by fraction' && lastRelocate(m.from)?.index === 1 && !messages.slice(m.from).some((x) => x.type === 'store'),
    `a CBZ fraction lands on its page, saving nothing (${m.restored.position}, page ${lastRelocate(m.from)?.index})`)
  from = messages.length
  call('window.__fol.prev()')
  const cbzMoved = await storeFrom(from, 'a store after a CBZ page turn')
  check(cbzMoved?.position?.page === 'p01.png', `and its page turn saves the page (${JSON.stringify(cbzMoved?.position)})`)

  console.log('more shapes')
  m = await open('tsupper.cbz')
  check(m.type === 'open-failed' ? false : m.format === 'cbz' && m.sections === 2, `a CBZ with upper-case extensions keeps every page (${m.sections ?? m.error})`)
  check(await shown(() => document.querySelector('img')?.naturalWidth === 60), 'its first page image is rendered')
  call('window.__fol.next()')
  check(await shown(async () => {
    const img = document.querySelector('img')
    return img?.naturalWidth === 60 && (await (await fetch(img.src)).blob()).type === 'image/svg+xml'
  }), 'its SVG page is rendered as an image (typed image/svg+xml)')
  m = await open('tsutf16.fb2')
  check(m.type === 'opened' && m.format === 'fb2' && m.title === 'TS FB2', `a UTF-16 FB2 opens (${m.title ?? m.error})`)
  check(await showsText(), 'its text is rendered')
  m = await open('tscombo.mobi')
  check(m.type === 'opened' && m.format === 'mobi' && m.title === 'TS COMBO', `a combo whose KF8 boundary holds no MOBI header opens as its MOBI6 half (${m.title ?? m.error})`)
  check(await showsText(), 'its text is rendered')

  // KF8 (#1182), on the SYNTHETIC Calibre-made books in synthetic/ (kf8fixture.mjs): says nothing about
  // real-world Kindle files.
  console.log('kf8 (synthetic)')
  m = await open('tssynthetic-kf8.azw3')
  check(m.type === 'opened' && m.format === 'mobi' && m.textual && m.title === 'TS Synthetic KF8' && m.author === 'TextStack Fixture' && m.sections === 3
    && m.toc.map((t) => t.label).join() === 'Part One,Part Two,Part Three', `an AZW3 opens: 3 sections, its TOC (${m.title ?? m.error}, ${m.sections}, ${m.toc?.map((t) => t.label)})`)
  const kf8Book = m.book
  for (const [i, text] of [[0, 'Kestrel lanterns'], [1, 'Copper gulls'], [2, 'harbour keeps its lamps']]) {
    call(`window.__fol.goTo(${i})`)
    check(await shown(`!!document.body?.innerText.includes(${JSON.stringify(text)})`), `section ${i} renders its own text`)
  }
  call('window.__fol.goTo(0)')
  check(await shown(async () => {
    const [css, png, svg, mark] = [document.querySelector('link[rel=stylesheet]'), document.querySelector('img.plate'), document.querySelector('img.badge'), document.querySelector('p.mark')]
    const type = async (url) => (await (await fetch(url)).blob()).type
    return !!(css && png && svg && mark) && png.naturalWidth === 120 && svg.naturalWidth === 80 && getComputedStyle(mark).color === 'rgb(10, 120, 30)'
      && await type(css.href) === 'text/css' && await type(png.src) === 'image/png' && await type(svg.src) === 'image/svg+xml'
  }), 'its resources are typed (text/css, image/png, image/svg+xml): the CSS applies, the PNG and the SVG render')
  // Section 2 carries a refresh meta to section 1: dropped through the KF8 transformTarget, so its frame stays.
  call('window.__fol.goTo(1)')
  check(await shown(() => document.body?.innerText.includes('Copper gulls') && ![...document.querySelectorAll('meta[http-equiv]')].some((x) => /refresh/i.test(x.getAttribute('http-equiv')))), 'the refresh meta of a KF8 section is stripped')
  await settle()
  check(await shown(() => document.body?.innerText.includes('Copper gulls')), 'and its section still shows after the refresh delay')
  // The internal link (kindle:pos) goes to section 3's harbour paragraph, inside the book: no openLink.
  call('window.__fol.goTo(0)')
  await shown(() => document.body?.innerText.includes('Kestrel lanterns'))
  from = messages.length
  for (const f of page.frames().filter((f) => f.url().startsWith('blob:'))) await f.evaluate(() => document.querySelector('a[href]')?.click()).catch(() => {})
  const linked = await storeFrom(from, 'a store after the internal link')
  check(lastRelocate(from)?.index === 2 && linked?.position?.index === 2 && !messages.slice(from).some((x) => x.type === 'openLink'),
    `the internal link goes to section 3 and saves there, no openLink (${lastRelocate(from)?.index}, ${JSON.stringify(linked?.position)})`)
  m = await open('tssynthetic-kf8.azw3', JSON.stringify(linked))
  await settle()
  check(m.restored.position === 'restored' && lastRelocate(m.from)?.cfi === linked?.position?.cfi, `reopened, its position is restored (${m.restored.position}, ${lastRelocate(m.from)?.cfi} vs ${linked?.position?.cfi})`)
  check(m.book.sha256 === kf8Book.sha256, 'the same book')
  m = await open('tssynthetic-combo.mobi')
  check(m.type === 'opened' && m.sections === 3 && m.toc.map((t) => t.label).join() === 'Part One,Part Two,Part Three', `a MOBI/KF8 combo reads its KF8 half: 3 sections, its TOC (${m.sections ?? m.error})`)
  check(await shown(() => { const p = document.querySelector('p.mark'); return !!p && getComputedStyle(p).color === 'rgb(10, 120, 30)' }), 'with its CSS (the MOBI6 half has none)')

  console.log('refused')
  // A refusal leaves the open book as it was: it keeps relocating and saving (no seq turnover, no session end).
  m = await open('tsformat.epub')
  const alive = messages.length
  // KF8: the synthetic AZW3 with the DRM flag; with its SKEL index pointing at a text record (damaged); a
  // header with no indexes at all (tskf8.mobi). foliate would fail on the last two only after teardown.
  const azw3 = readFileSync(resolve(dir, 'tssynthetic-kf8.azw3'))
  const r0 = azw3.readUInt32BE(78)
  const patched = (write) => { const b = Buffer.from(azw3); write(b); return b }
  writeFileSync(resolve(dir, 'tsdrm.azw3'), patched((b) => b.writeUInt16BE(2, r0 + 12)))
  writeFileSync(resolve(dir, 'tsdamaged.azw3'), patched((b) => b.writeUInt32BE(1, r0 + 252)))
  for (const [file, error] of [['tsdrm.mobi', /DRM/], ['tsdrm.azw3', /DRM/], ['tsdamaged.azw3', /truncated or damaged/], ['tskf8.mobi', /truncated or damaged/], ['tsplain.txt', /not a book this reader opens/], ['tslocked.pdf', /password-protected/]]) {
    const r = await open(file)
    check(r.type === 'open-failed' && error.test(r.error), `${file} is refused: ${r.error}`)
  }
  // Entities, flat or nested: refused before the XML parser sees them (a flat one ×30k hangs the page).
  const lol = ['<!ENTITY l0 "lol">', ...Array.from({ length: 9 }, (_, i) => `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`)].join('')
  writeFileSync(resolve(dir, 'tsbomb.fb2'), fb2('TS bomb', '<section><p>&l9;</p></section>', `<!DOCTYPE FictionBook [${lol}]>`))
  writeFileSync(resolve(dir, 'tsflat.fb2'), fb2('TS flat', `<section><p>${'&e;'.repeat(30000)}</p></section>`, `<!DOCTYPE FictionBook [<!ENTITY e "${'x'.repeat(800)}">]>`))
  writeFileSync(resolve(dir, 'tsxxe.fb2'), fb2('TS xxe', '<section><p>&x;</p></section>', '<!DOCTYPE FictionBook [<!ENTITY x SYSTEM "file:///etc/passwd">]>'))
  for (const file of ['tsbomb.fb2', 'tsflat.fb2', 'tsxxe.fb2']) {
    const r = await open(file).catch((e) => ({ type: 'hung', error: e.message }))
    check(r.type === 'open-failed' && /custom entities/.test(r.error), `${file} is refused before parsing: ${r.error}`)
  }
  call('window.__fol.next()')
  check(!!(await waitFor(alive, (x) => x.type === 'store', 'a store after the refusals').catch(() => null)), 'the EPUB open before the refusals still turns and saves')
  check(!messages.slice(alive).some((x) => x.type === 'telemetry'), 'and its telemetry session was not ended by them')

  // A re-layout right after a fraction landing — the WebView resized (the host's offer banner or error
  // line appearing above it, rotation), a font or flow change — is not the reader moving: it saves no CFI
  // over the server's transitional locator (I1). The first real move after it does save one (I5).
  // (The resize logs a benign ResizeObserver error: the page-error sweep at the end lets that one through.)
  console.log('re-layout after a fraction landing')
  for (const [what, relayout, restore] of [
    ['a resize', () => page.setViewportSize({ width: 500, height: 400 }), () => page.setViewportSize({ width: 1280, height: 720 })],
    ['a font change', () => call('window.__fol.font(6)'), () => call('window.__fol.font(-6)')],
    ['a flow switch', () => call('window.__fol.flow("scrolled")'), () => call('window.__fol.flow("paginated")')],
  ]) {
    m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
    await settle()
    from = messages.length
    await relayout()
    await settle()
    const relaid = messages.slice(from).filter((x) => x.type === 'relocate').length
    check(relaid > 0 && storesFrom(from).length === 0, `${what} after a fraction landing relocates (${relaid}) but saves nothing (${JSON.stringify(storesFrom(from))})`)
    // Back, not forward: scrolled at 0.9 the section's end can already be on screen, with no next to go to.
    from = messages.length
    call('window.__fol.prev()')
    const turned = await storeFrom(from, `a store after a page turn following ${what}`)
    check(turned?.position?.cfi?.startsWith('epubcfi('), `and the page turn after ${what} saves a CFI`)
    await restore()
    await settle()
  }

  // A goTo still loading its section when another book opens never settles on the closed view; the next
  // book starts a navigation chain of its own, so it still restores, turns and saves (and the stale goTo
  // never moves it). A host goTo (a sync adopt, a taken offer) followed by a book switch.
  console.log('goTo across an open')
  m = await open('tsformat.fb2')
  from = messages.length
  await call(`window.__fol.goTo({ fraction: 0.8, at: 5 }); window.__fol.openUrl(${JSON.stringify(pathToFileURL(resolve(dir, 'tsformat.epub')).href)}, 'tsformat.epub')`)
  const next = await waitFor(from, (x) => x.type === 'opened', 'the next book opened')
  // Not awaited: on a wedged chain restore never settles, and the check must fail, not hang.
  call(`window.__fol.restore(${JSON.stringify(JSON.stringify({ v: 1, book: next.book, highlights: [], position: { fraction: 0.5, at: 1 } }))})`).catch(() => {})
  const answered = await waitFor(from, (x) => x.type === 'restored', 'restored after a goTo across an open').catch(() => null)
  check(answered?.position === 'restored by fraction', `a goTo in flight across openUrl does not hold up the next book (${answered?.position})`)
  check(!messages.slice(from).some((x) => x.type === 'store' && x.key !== next.book.sha256), 'nothing is saved for the previous book after the switch')
  from = messages.length
  call('window.__fol.next()')
  check(!!(await waitFor(from, (x) => x.type === 'store' && x.key === next.book.sha256, 'a store after the switch').catch(() => null)), 'and the next book turns and saves')

  // The save rule (#1187 round 2): a relocate saves only when it is not a re-layout ('anchor') and its CFI
  // differs from the previous relocate's. A tap ends in foliate's touchend 'snap', a relocate where the
  // view already is: no move, so no save, after a re-layout moved the anchor too.
  console.log('save rule')
  const cdp = await page.context().newCDPSession(page)
  const tap = async () => {
    const at = { x: 640, y: 360 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  const entryOf = (b, position) => JSON.stringify({ v: 1, book: b, highlights: [], position })
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  await settle()
  await call('window.__fol.font(4)')
  await settle()
  from = messages.length
  await tap()
  await settle()
  check(messages.slice(from).some((x) => x.type === 'relocate') && storesFrom(from).length === 0,
    `a tap after a fraction landing and a font change relocates (snap) but saves nothing (${JSON.stringify(storesFrom(from))})`)
  await call('window.__fol.font(-4)')
  // A CFI restore: opening the book re-stamps nothing; only a real page turn saves.
  const cfiEntry = moved.json
  m = await open('tsformat.fb2', cfiEntry)
  await settle()
  await tap()
  await settle()
  check(m.restored.position === 'restored' && storesFrom(m.from).length === 0, `a CFI restore, settled and tapped, saves nothing (${m.restored.position}, ${JSON.stringify(storesFrom(m.from))})`)
  from = messages.length
  call('window.__fol.next()')
  const turnedCfi = await storeFrom(from, 'a store after a page turn on a CFI restore')
  check(turnedCfi?.position?.cfi?.startsWith('epubcfi('), 'and its first page turn saves a CFI')

  // A taken offer (goTo chosen): the place the fraction landed on is saved as a CFI position, once.
  console.log('taken offer')
  m = await open('tsformat.fb2')
  await settle()
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.6, at: 7 }, true)')
  const taken = await storeFrom(from, 'a store after a taken fraction offer')
  await settle()
  const landedAt = lastRelocate(from)
  check(taken?.position?.cfi === landedAt?.cfi && taken.position.quote && taken.position.index === landedAt.index && storesFrom(from).length === 1,
    `a taken fraction offer saves the landed place as a CFI, once (${JSON.stringify(taken?.position)} vs ${landedAt?.cfi})`)

  // Arrival (#1187 round 2): foliate's goTo resolves with what it resolved, arrived or not. A view that
  // does not get there (here: a goTo that resolves section 1 and stays put) changes nothing and says so.
  console.log('fraction not arrived')
  const stuck = `document.querySelector('foliate-view').goTo = async () => ({ index: 1 })`
  m = await open('tsformat.fb2')
  await settle()
  await call(stuck)
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.9, at: 8 }, true)')
  await waitFor(from, (x) => x.type === 'log' && /did not land/.test(x.msg), 'a not-landed warn')
  await settle()
  check(storesFrom(from).length === 0, 'a taken fraction offer that did not arrive saves nothing')
  from = messages.length
  await call(`window.__fol.openUrl(${JSON.stringify(pathToFileURL(resolve(dir, 'tsformat.fb2')).href)}, 'tsformat.fb2')`)
  await waitFor(from, (x) => x.type === 'opened', 'opened for a not-arrived restore')
  await call(stuck)
  call(`window.__fol.restore(${JSON.stringify(byFraction({ fraction: 0.9, at: 1 }))})`).catch(() => {})
  const notArrived = await waitFor(from, (x) => x.type === 'restored', 'restored, not arrived')
  await settle()
  check(notArrived.position === 'navigation failed, stayed at start' && storesFrom(from).length === 0,
    `a fraction restore that did not arrive says so and saves nothing (${notArrived.position})`)

  // Fraction 0 (never read on the other device): the text start init showed, not the cover before it.
  console.log('fraction 0')
  m = await open('tscover.epub')
  const coverBook = m.book
  check(lastRelocate(m.from)?.index === 1, `a book with a non-linear cover first opens at its text start (section ${lastRelocate(m.from)?.index})`)
  m = await open('tscover.epub', entryOf(coverBook, { fraction: 0, at: 1 }))
  await settle()
  check(m.restored.position === 'restored by fraction' && lastRelocate(m.from)?.index === 1 && storesFrom(m.from).length === 0,
    `fraction 0 restores at the text start, not the cover, saving nothing (${m.restored.position}, section ${lastRelocate(m.from)?.index})`)
  call('window.__fol.next()')
  await settle()
  from = messages.length
  call('window.__fol.goTo({ fraction: 0, at: 9 })')
  await settle()
  check(lastRelocate(from)?.index === 1 && storesFrom(from).length === 0, `a fraction 0 goTo goes to the text start, saving nothing (section ${lastRelocate(from)?.index})`)

  // The stale-call window: the next book's openUrl has turned the open seq over while its bytes are still
  // hashing, and the previous view still shows. A `next` queued on that view and a `restore` for it, made
  // in the window, never run on or answer for the next book. Deterministic: the previous view's goTo is
  // held, and the next book's file read is released by the check, in the same turn as the two calls.
  // (#1128 S5: the restore is now accepted for the view on screen, and queued behind its held goTo; the
  // swap drops that chain, so it never runs. That an unheld one IS answered: checkOpenOrder.)
  console.log('stale-call window')
  m = await open('tsformat.fb2')
  const previousBook = m.book
  await settle()
  await call(`(() => {
    const v = document.querySelector('foliate-view')
    const held = new Promise((ok) => { window.__releasePrevious = ok })
    v.goTo = () => held.then(() => undefined)
    const send = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function () {
      XMLHttpRequest.prototype.send = send
      const x = this, load = x.onload
      x.onload = () => { window.__loadNext = () => load.call(x) }
      return send.call(x)
    }
  })()`)
  // Held: the previous view's chain is busy from here on (not awaited: it settles only on release).
  call('window.__fol.section(1)').catch(() => {})
  from = messages.length
  await call(`window.__fol.openUrl(${JSON.stringify(pathToFileURL(resolve(dir, 'tsformat.epub')).href)}, 'tsformat.epub')`)
  for (const t0 = Date.now(); !(await call('!!window.__loadNext')) && Date.now() - t0 < TIMEOUT_MS;) await page.waitForTimeout(20)
  // Both calls queue on the previous view's (held) chain, which the swap drops.
  await call(`window.__loadNext(); window.__fol.next(); window.__fol.restore(null); window.__fol.restore(${JSON.stringify(entryOf(previousBook, { fraction: 0.9, at: 1 }))}); 0`)
  const nextBook = await waitFor(from, (x) => x.type === 'opened', 'the next book opened after the window')
  const afterOpened = messages.length
  await call('window.__releasePrevious()')
  await settle()
  check(!messages.slice(from).some((x) => x.type === 'restored'), 'a restore made in the window answers nothing')
  check(!messages.slice(afterOpened).some((x) => x.type === 'relocate'), 'a next queued in the window never moves the next book')
  // The next book is still restoring: a turn before its own restore saves nothing.
  from = messages.length
  call('window.__fol.next()')
  await settle()
  check(storesFrom(from).length === 0, 'the next book saves nothing before its own restore (the stale restore did not end it)')
  from = messages.length
  call('window.__fol.restore(null)').catch(() => {})
  const own = await waitFor(from, (x) => x.type === 'restored', 'the next book restored').catch(() => null)
  check(own?.found === false && own.position === 'none', `the next book answers its own restore (${JSON.stringify(own)})`)
  call('window.__fol.next()')
  check(!!(await waitFor(from, (x) => x.type === 'store' && x.key === nextBook.book.sha256, 'a store on the next book').catch(() => null)), 'and then turns and saves')

  // Restore takes its slot in the navigation queue when called (round 3): a host goTo sent while the
  // restore still checks its quotes runs after it and wins: the view ends where the goTo went, and the
  // page holds the goTo's position, not the restored one.
  console.log('restore then goTo')
  m = await open('tsformat.fb2')
  await settle()
  from = messages.length
  call('window.__fol.next()')
  const startEntry = await waitFor(from, (x) => x.type === 'store', 'a store at the start').then((x) => x.json)
  from = messages.length
  await call(`window.__fol.openUrl(${JSON.stringify(pathToFileURL(resolve(dir, 'tsformat.fb2')).href)}, 'tsformat.fb2')`)
  await waitFor(from, (x) => x.type === 'opened', 'opened for restore then goTo')
  await call(`window.__fol.restore(${JSON.stringify(startEntry)}); window.__fol.goTo({ fraction: 0.9, at: 10 }); 0`)
  const restoredFirst = await waitFor(from, (x) => x.type === 'restored', 'restored before the goTo')
  await settle()
  const ended = lastRelocate(from)
  check(restoredFirst.position === 'restored' && ended?.index === 1 && ended.fraction > 0.5 && storesFrom(from).length === 0,
    `a goTo sent during a restore lands last and nothing is saved (${restoredFirst.position}, section ${ended?.index}, ${ended?.fraction})`)
  const won = (await heldEntry())?.position
  check(won?.fraction === 0.9 && !('cfi' in won), `and the page holds the goTo's position (${JSON.stringify(won)})`)

  // A restore for a view still opening (round 3): the same file opened twice, the host answering the
  // first `opened` while the second open builds its view. Refused, so the second view's text-start
  // relocate is never saved over the stored place. Deterministic: the second view's open is held.
  console.log('restore during an open')
  m = await open('tsformat.fb2')
  await settle()
  const fb2Entry = byFraction({ fraction: 0.9, at: 1 })
  await call(`(() => {
    const C = customElements.get('foliate-view'), open = C.prototype.open
    const held = new Promise((ok) => { window.__releaseOpen = ok })
    C.prototype.open = async function (b) { C.prototype.open = open; window.__inOpen = true; await held; return open.call(this, b) }
  })()`)
  from = messages.length
  await call(`window.__fol.openUrl(${JSON.stringify(pathToFileURL(resolve(dir, 'tsformat.fb2')).href)}, 'tsformat.fb2')`)
  for (const t0 = Date.now(); !(await call('!!window.__inOpen')) && Date.now() - t0 < TIMEOUT_MS;) await page.waitForTimeout(20)
  await call(`window.__fol.restore(${JSON.stringify(fb2Entry)}); window.__releaseOpen(); 0`)
  await waitFor(from, (x) => x.type === 'opened', 'the second open answered')
  await settle()
  check(!messages.slice(from).some((x) => x.type === 'restored') && storesFrom(from).length === 0,
    `a restore for a view still opening is refused: no answer, nothing saved (${JSON.stringify(storesFrom(from))})`)
  from = messages.length
  call(`window.__fol.restore(${JSON.stringify(fb2Entry)})`).catch(() => {})
  check((await waitFor(from, (x) => x.type === 'restored', 'the second open restored'))?.position === 'restored by fraction', 'and the opened view takes its own restore')

  // A taken offer saves what a relocate would save (round 3, one builder). A pre-paginated EPUB has text
  // but no range from foliate's fixed-layout renderer: nothing to save, and nothing throws.
  console.log('fixed layout')
  m = await open('tsfixed.epub')
  check(m.type === 'opened' && m.reflowable === false && m.textual === true, `a pre-paginated EPUB opens fixed-layout, textual (${m.reflowable}, ${m.textual}${m.error ? `, ${m.error}` : ''})`)
  m = await open('tsfixed.epub', entryOf(m.book, null))
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.9, at: 11 }, true)')
  await waitFor(from, (x) => x.type === 'log' && /nothing to save here/.test(x.msg), 'nothing to save on a pre-paginated EPUB').catch(() => null)
  await settle()
  check(storesFrom(from).length === 0 && messages.slice(from).some((x) => x.type === 'log' && /nothing to save here/.test(x.msg)),
    'a taken offer on a pre-paginated EPUB saves nothing and says so')
  m = await open('tsformat.cbz', entryOf(cbzBook, null))
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.9, at: 12 }, true)')
  const cbzTaken = await storeFrom(from, 'a store after a taken offer on a CBZ')
  check(cbzTaken?.position?.page === 'p02.png' && !('quote' in cbzTaken.position), `a taken offer on a CBZ saves its page, as a page turn does (${JSON.stringify(cbzTaken?.position)})`)
  // Arrival on a fixed layout: a target in the spread already shown emits no relocate, and is arrived.
  m = await open('tsthree.cbz')
  m = await open('tsthree.cbz', entryOf(m.book, null))
  const paired = await call(`(() => { const v = document.querySelector('foliate-view'), r = v.renderer, s = v.book.sections; return r.getSpreadOf(s[1]).index === r.getSpreadOf(s[2]).index })()`)
  check(paired, 'tsthree.cbz pairs its 2nd and 3rd pages in one spread')
  call('window.__fol.goTo(1)')
  await settle()
  from = messages.length
  call('window.__fol.goTo(2, true)')
  await settle()
  check(!messages.slice(from).some((x) => x.type === 'log' && /did not land/.test(x.msg)) && storesFrom(from).length === 1,
    `a taken goTo to the other page of the shown spread arrives and saves (${JSON.stringify(storesFrom(from))})`)

  await checkPdf()
  await checkOpenOrder()

  // Every page error on this page, last so that every block above is covered. One benign message is let
  // through by its exact text: Chromium's ResizeObserver loop notice, from the resize above.
  const BENIGN = 'ResizeObserver loop completed with undelivered notifications.'
  for (const x of messages) if (x.type === 'log' && x.level === 'error' && !/^open: /.test(x.msg) && x.msg !== BENIGN) check(false, `page error: ${x.msg.split('\n')[0]}`)

  // The 5-minute boundary, on a page with a fake clock: the session ends by its own timer (no next open),
  // a switch inside the window counts, a switch after it does not and sends nothing more.
  console.log('telemetry clock')
  const timed = await browser.newPage()
  const sent = []
  await timed.clock.install()
  await timed.exposeFunction('__toHost', (json) => sent.push(JSON.parse(json)))
  await timed.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
  await timed.goto(pathToFileURL(resolve(dir, 'page.html')).href)
  const until = async (match, what) => {
    for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await new Promise((ok) => setTimeout(ok, 50))) { const x = sent.find(match); if (x) return x }
    throw new Error(`timed out waiting for ${what}`)
  }
  const openTimed = async (file) => {
    const from = sent.length
    await timed.evaluate((u) => window.__fol.openUrl(u, 'timed'), pathToFileURL(resolve(dir, file)).href)
    // foliate's own timers run on the fake clock too: keep it moving in small steps until the book opens.
    for (const t0 = Date.now(); !sent.slice(from).some((x) => x.type === 'opened') && Date.now() - t0 < TIMEOUT_MS;) await timed.clock.runFor(50)
    return sent.slice(from).find((x) => x.type === 'opened')
  }
  const telemetry = () => sent.filter((x) => x.type === 'telemetry')
  await until((x) => x.type === 'ready', 'ready (timed)')
  check(!!(await openTimed('tsformat.fb2')), 'opened under the fake clock')
  await timed.clock.runFor(4 * 60 * 1000 + 59 * 1000)
  check(telemetry().length === 0, 'nothing is sent before 5 minutes')
  await timed.evaluate(() => window.__fol.flow('scrolled'))
  await timed.clock.runFor(2000)
  check(telemetry().length === 1 && telemetry()[0].switchedInFirst5Min === true && telemetry()[0].mode === 'scrolled',
    `a switch at 4:59 counts, the timer sends it at 5:00: ${JSON.stringify(telemetry())}`)
  check(!!(await openTimed('tsformat.fb2')), 'the same book reopened')
  await timed.clock.runFor(5 * 60 * 1000 + 1000)
  await timed.evaluate(() => window.__fol.flow('paginated'))
  await timed.clock.runFor(1000)
  check(telemetry().length === 2 && telemetry()[1].switchedInFirst5Min === false && telemetry()[1].mode === 'scrolled',
    `a switch after 5:00 is not counted and sends nothing more: ${JSON.stringify(telemetry())}`)
  // A late timer (a backgrounded WebView throttles them): the clock passes 5:00 without the timer firing,
  // and a switch then is still not counted.
  check(!!(await openTimed('tsformat.fb2')), 'reopened for a late timer')
  await timed.clock.setSystemTime(await timed.evaluate(() => Date.now()) + 6 * 60 * 1000)
  await timed.evaluate(() => window.__fol.flow('scrolled'))
  // setSystemTime moves Date only; the timer is still 5 minutes of ticks away.
  await timed.clock.runFor(5 * 60 * 1000 + 1000)
  check(telemetry().length === 3 && telemetry()[2].switchedInFirst5Min === false,
    `a switch past 5:00 before the late timer fires is not counted: ${JSON.stringify(telemetry().at(-1))}`)
} catch (e) {
  check(false, String(e?.message ?? e))
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n[check:v2-reader-formats] ${failures.length ? 'FAILED' : 'ok'}`)
process.exit(failures.length ? 1 : 0)
