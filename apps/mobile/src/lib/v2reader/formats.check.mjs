// The format check (#1128): the committed page, in Chromium as file:// (the dev route's origin), opens one
// small book per format (fixtures.mjs writeFormatFixtures) and must answer as README "Formats" says:
// each format reader runs only when its first book opens, CBZ has no text features and still saves and
// restores its page, a DRM-flagged MOBI and a PDF are refused, and flow() switches the live view and is
// reported once per book in `telemetry`.
//
//   node --experimental-strip-types formats.check.mjs      (pnpm -C apps/web check:v2-reader-formats)
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  // EXPERIMENTAL (#1182): the SYNTHETIC Calibre-made AZW3 (synthetic/, kf8fixture.mjs) opens through the fork's KF8 reader.
  console.log('kf8 (synthetic)')
  copyFileSync(resolve(here, 'synthetic/tssynthetic-kf8.azw3'), resolve(dir, 'tssynthetic-kf8.azw3'))
  m = await open('tssynthetic-kf8.azw3')
  check(m.type === 'opened' && m.format === 'mobi' && m.sections === 3 && m.toc.length === 3, `a synthetic AZW3 opens: 3 sections, 3 TOC entries (${m.sections ?? m.error})`)
  check(await shown(() => document.body?.innerText.includes('Kestrel lanterns')), 'its first section is rendered')
  check(await shown(async () => { const i = document.querySelector('img.badge'); return !!i && i.naturalWidth === 80 && (await (await fetch(i.src)).blob()).type === 'image/svg+xml' }), 'its SVG image renders, typed image/svg+xml')

  console.log('refused')
  // A refusal leaves the open book as it was: it keeps relocating and saving (no seq turnover, no session end).
  m = await open('tsformat.epub')
  const alive = messages.length
  // EXPERIMENTAL (#1182): KF8 is read; a header-only one (no SKEL/FRAG index) is refused as damaged.
  for (const [file, error] of [['tsdrm.mobi', /DRM/], ['tskf8.mobi', /truncated or damaged/], ['tsformat.pdf', /PDF is not supported yet/]]) {
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
