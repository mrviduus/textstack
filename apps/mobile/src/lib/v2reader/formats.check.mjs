// The format check (#1128): the committed page, in Chromium as file:// (the dev route's origin), opens one
// small book per format (fixtures.mjs writeFormatFixtures) and must answer as README "Formats" says:
// each format reader runs only when its first book opens, CBZ has no text features and still saves and
// restores its page, a DRM-flagged MOBI and a PDF are refused, and flow() switches the live view and is
// reported once per book in `telemetry`.
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
  m = await open('tsformat.cbz', stored.json)
  check(m.restored.position === 'restored', `reopened, the saved page is restored (${m.restored.position})`)
  const at = await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 1, 'relocate to page 2').catch(() => null)
  check(!!at, 'and the view shows page 2')

  console.log('refused')
  m = await open('tsdrm.mobi')
  check(m.type === 'open-failed' && /DRM/.test(m.error), `a DRM-flagged MOBI is refused: ${m.error}`)
  // Billion laughs: Blink's XML parser stops entity amplification; the page must answer either way, not hang.
  const lol = ['<!ENTITY l0 "lol">', ...Array.from({ length: 9 }, (_, i) => `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`)].join('')
  writeFileSync(resolve(dir, 'tsbomb.fb2'), fb2('TS bomb', '<section><p>&l9;</p></section>', `<!DOCTYPE FictionBook [${lol}]>`))
  const t0 = Date.now()
  m = await open('tsbomb.fb2').catch((e) => ({ type: 'hung', error: e.message }))
  check(m.type !== 'hung', `an entity-bomb FB2 answers (${m.type}${m.error ? `: ${m.error}` : ''}, ${Date.now() - t0} ms)`)
  m = await open('tsformat.pdf')
  check(m.type === 'open-failed' && /PDF/.test(m.error), `a PDF is refused (its gate is a later slice): ${m.error}`)
  for (const x of messages) if (x.type === 'log' && x.level === 'error' && !/^open: /.test(x.msg)) check(false, `page error: ${x.msg.split('\n')[0]}`)
} catch (e) {
  check(false, String(e?.message ?? e))
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n[check:v2-reader-formats] ${failures.length ? 'FAILED' : 'ok'}`)
process.exit(failures.length ? 1 : 0)
