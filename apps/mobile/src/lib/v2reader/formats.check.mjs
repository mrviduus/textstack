// The format check (#1128): the committed page, in Chromium as file:// (the dev route's origin), opens one
// small book per format (fixtures.mjs writeFormatFixtures) and must answer as README "Formats" says:
// each format reader runs only when its first book opens, CBZ has no text features and still saves and
// restores its page, a fraction-only position (#1187) restores without saving, a DRM-flagged MOBI and a
// PDF are refused, and flow() switches the live view and is reported once per book in `telemetry`.
//
//   node --experimental-strip-types formats.check.mjs      (pnpm -C apps/web check:v2-reader-formats)
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fb2, writeFormatFixtures } from './fixtures.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(resolve(here, '../../../../web/package.json'))('@playwright/test')
const TIMEOUT_MS = 15000

const failures = []
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }
/**
 * A known, open bug (as vitest's it.fails): reported while it reproduces, a failure once it no longer does
 * (update the check). `racy`: the repro depends on timing, so a run that misses it only says so.
 */
const known = (reproduces, what, racy = false) => (reproduces ? console.log(`  KNOWN ${what}`)
  : racy ? console.log(`  (not reproduced this run, timing) ${what}`) : check(false, `no longer reproduces, turn it into a check: ${what}`))

const dir = mkdtempSync(resolve(tmpdir(), 'ts-v2-formats-'))
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] })
try {
  writeFormatFixtures(dir)
  writeFileSync(resolve(dir, 'tsformat.pdf'), '%PDF-1.4\n%%EOF\n')
  writeFileSync(resolve(dir, 'page.html'), v2ReaderPageHtml(randomBytes(18).toString('base64')))
  const page = await browser.newPage()
  const messages = []
  page.on('pageerror', (e) => check(false, `pageerror: ${e.message}`))
  await page.exposeFunction('__toHost', (json) => messages.push(JSON.parse(json)))
  await page.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
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

  await waitFor(0, (m) => m.type === 'ready', 'ready')
  check(await loaded() === '', 'no format reader has run before a book opens')

  console.log('epub')
  let m = await open('tsformat.epub')
  check(m.type === 'opened' && m.format === 'epub' && m.textual === true && m.title === 'TS EPUB', `opened as epub, textual (${m.format}, ${m.title})`)
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
  check(m.type === 'opened' && m.format === 'cbz' && m.textual === false && m.sections === 2, `opened as cbz, not textual, 2 pages (${m.format}, ${m.textual}, ${m.sections}${m.error ? `, ${m.error}` : ''})`)
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
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  check(m.restored.position === 'restored by fraction', `a fraction-only position is restored (${m.restored.position})`)
  const far = await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 1 && x.fraction > 0.5, 'relocate near the end').catch(() => null)
  check(!!far, `and the view is past the start (${JSON.stringify(messages.filter((x) => x.type === 'relocate').at(-1))})`)
  // foliate relocates at the landed place again after `restored`: those relocates must not save either.
  await page.waitForTimeout(1500)
  check(!messages.slice(m.from).some((x) => x.type === 'store'), 'restoring by fraction saves nothing')
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.05, at: 2 })')
  const quietStore = await waitFor(from, (x) => x.type === 'store', 'a store after a fraction goTo').catch(() => null)
  const quietPos = quietStore && JSON.parse(quietStore.json).position
  check(quietPos?.fraction === 0.05 && !('cfi' in quietPos), `a fraction goTo saves the fraction-only position, no CFI (${JSON.stringify(quietPos)})`)
  from = messages.length
  call('window.__fol.next()')
  const moved = await waitFor(from, (x) => x.type === 'store', 'a store after the reader moves').catch(() => null)
  check(JSON.parse(moved?.json ?? '{}').position?.cfi?.startsWith('epubcfi('), 'the reader moving saves a CFI position')
  m = await open('tsformat.fb2', byFraction({ fraction: 2, at: 1 }))
  check(m.restored.rejected === false && m.restored.position === 'none', `a fraction outside [0, 1] is not applied (${m.restored.position})`)
  from = messages.length
  call('window.__fol.next()')
  check(!!(await waitFor(from, (x) => x.type === 'store', 'a store after a refused fraction').catch(() => null)), 'and the book still turns and saves')

  // The hold after a fraction landing (#1187 QA): what it holds, and that it holds nothing more.
  console.log('fraction hold')
  const settle = () => page.waitForTimeout(1200)
  const lastRelocate = (from) => messages.slice(from).filter((x) => x.type === 'relocate').at(-1)
  const storeFrom = (from, what) => waitFor(from, (x) => x.type === 'store', what).then((s) => JSON.parse(s.json)).catch(() => null)
  for (const fraction of [0, 1]) {
    m = await open('tsformat.fb2', byFraction({ fraction, at: 1 }))
    await settle()
    check(m.restored.position === 'restored by fraction' && (fraction ? lastRelocate(m.from)?.fraction === 1 : lastRelocate(m.from)?.index === 0 && lastRelocate(m.from).fraction < 0.5) && !messages.slice(m.from).some((x) => x.type === 'store'),
      `fraction ${fraction} is restored at that end and saves nothing (${m.restored.position}, ${lastRelocate(m.from)?.fraction})`)
  }
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  await settle()
  const held = lastRelocate(m.from).cfi
  // A refused open leaves the held book as it was: it still turns and saves.
  check((await open('tsformat.pdf')).type === 'open-failed', 'a PDF picked over a fraction landing is refused')
  from = messages.length
  call('window.__fol.next()')
  const afterRefusal = await storeFrom(from, 'a store after a refusal over a fraction landing')
  check(afterRefusal?.position?.cfi?.startsWith('epubcfi('), 'and the held book still turns and saves a CFI')
  // I5: once moved, coming back to the very place the fraction landed on is a move like any other.
  from = messages.length
  call('window.__fol.prev()')
  const back = await storeFrom(from, 'a store after moving back to the landing')
  check(back?.position?.cfi === held, `moving back onto the landed CFI saves it (${back?.position?.cfi} vs ${held})`)
  // The hold does not outlive its book: reopened at the start, a host goTo to that same CFI saves it.
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  await settle()
  m = await open('tsformat.fb2')
  await settle()
  from = messages.length
  call(`window.__fol.goTo(${JSON.stringify(held)})`)
  const reopened = await storeFrom(from, 'a store after a CFI goTo in a reopened book')
  check(reopened?.position?.cfi === held, `a reopened book's move onto the previous landing's CFI is saved (${reopened?.position?.cfi})`)
  // A fraction goTo saves once: foliate's relocates at the landing afterwards save nothing more.
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.5, at: 3 })')
  const once = await storeFrom(from, 'a store after a fraction goTo')
  await settle()
  const stores = messages.slice(from).filter((x) => x.type === 'store')
  check(once?.position?.fraction === 0.5 && stores.length === 1, `a fraction goTo saves its position once, then nothing (${stores.length} stores)`)
  // The same right after `restored` (a host's sync adopt at open): the opening layout still relocates,
  // at the landing, after the goTo has settled; none of that may save a CFI over the fraction.
  m = await open('tsformat.fb2')
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.9, at: 6 })')
  await settle()
  const early = messages.slice(from).filter((x) => x.type === 'store').map((x) => JSON.parse(x.json).position)
  check(early.length > 0 && early.every((p) => p.fraction === 0.9 && !('cfi' in p)), `a fraction goTo right after restored saves only the fraction (${JSON.stringify(early)})`)

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
  const withHl = await storeFrom(from, 'a store after a fraction goTo with a highlight')
  check(withHl?.highlights?.[0]?.id === hl.id && withHl.position.fraction === 0.2, 'a fraction goTo keeps the highlight')
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
  check(m.type === 'opened' && m.format === 'mobi' && m.title === 'TS COMBO', `a MOBI/KF8 combo opens as its MOBI6 half (${m.title ?? m.error})`)
  check(await showsText(), 'its text is rendered')

  console.log('refused')
  // A refusal leaves the open book as it was: it keeps relocating and saving (no seq turnover, no session end).
  m = await open('tsformat.epub')
  const alive = messages.length
  for (const [file, error] of [['tsdrm.mobi', /DRM/], ['tskf8.mobi', /AZW3 \(KF8\) is not supported yet/], ['tsformat.pdf', /PDF is not supported yet/]]) {
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
  for (const x of messages) if (x.type === 'log' && x.level === 'error' && !/^open: /.test(x.msg)) check(false, `page error: ${x.msg.split('\n')[0]}`)

  // KNOWN (#1187 QA): a re-layout right after a fraction landing — the WebView resized (the host's offer
  // banner or error line appearing above it, rotation) — relocates at another CFI and saves it: the
  // server's transitional locator is rewritten by opening the book (I1). Font and flow do the same.
  // After the page-error sweep: the resize logs a benign ResizeObserver error.
  console.log('resize after a fraction landing')
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  await settle()
  from = messages.length
  await page.setViewportSize({ width: 500, height: 400 })
  await settle()
  const relayout = messages.slice(from).filter((x) => x.type === 'store').map((x) => JSON.parse(x.json).position)
  known(relayout.some((p) => p.cfi), `a resize after a fraction landing saves a CFI (${JSON.stringify(relayout.at(-1))})`)
  await page.setViewportSize({ width: 1280, height: 720 })

  // KNOWN (#1187 QA; not new: a CFI goTo does the same): a goTo still loading its section when another
  // book opens never settles, and the page's one navigation chain waits on it for good — the next book
  // never answers `restored` for a stored position and never turns or saves. A host goTo (a sync adopt,
  // a taken offer) followed by a book switch. Last on this page: the chain stays wedged.
  console.log('goTo across an open')
  m = await open('tsformat.fb2')
  from = messages.length
  await call(`window.__fol.goTo({ fraction: 0.8, at: 5 }); window.__fol.openUrl(${JSON.stringify(pathToFileURL(resolve(dir, 'tsformat.epub')).href)}, 'tsformat.epub')`)
  const wedged = await waitFor(from, (x) => x.type === 'opened', 'the next book opened')
  call(`window.__fol.restore(${JSON.stringify(JSON.stringify({ v: 1, book: wedged.book, highlights: [], position: { fraction: 0.5, at: 1 } }))})`).catch(() => {})
  const answered = await waitFor(from, (x) => x.type === 'restored', 'restored after a goTo across an open').catch(() => null)
  known(!answered, 'a goTo in flight across openUrl wedges the next book: no `restored`, no turns, no saves', true)

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
