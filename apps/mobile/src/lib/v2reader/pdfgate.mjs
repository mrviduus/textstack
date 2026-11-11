// The ADR-032 PDF gate (#1128 S5): "open, page, select and resume on the existing real PDF uploads",
// through the committed page in headless Chromium under the Android host's origin (bookOriginRoute.mjs), one fresh page per file.
//
//   node --experimental-strip-types pdfgate.mjs <corpusDir> [--map <file>] [--only 3,7]
//
// The corpus is private user data and never enters the repo. This script prints no file name, path, title
// or text: a file is `pdf-NN` (its rank in sorted path order), its size a bucket. `--map <file>` writes the
// index → path map to a file the operator chooses (keep it beside the corpus). Error messages are not printed
// either (pdf.js's can quote a font or object name): only a class.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOOK_ORIGIN } from './bookOrigin.mjs'
import { PAGE_URL, routeBookOrigin } from './bookOriginRoute.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(resolve(here, '../../../../web/package.json'))('@playwright/test')
const STEP_MS = 90_000

const args = process.argv.slice(2)
const corpus = args[0]
if (!corpus || corpus.startsWith('--')) { console.error('usage: pdfgate.mjs <corpusDir> [--map <file>] [--only 3,7]'); process.exit(2) }
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.pdf$/i.test(e.name) ? [join(d, e.name)] : []))
const files = walk(resolve(corpus)).sort()
const label = (i) => `pdf-${String(i + 1).padStart(2, '0')}`
if (opt('--map')) writeFileSync(opt('--map'), files.map((f, i) => `${label(i)}\t${f}`).join('\n') + '\n', { mode: 0o600 })
const only = opt('--only')?.split(',').map(Number)

const MB = 1 << 20
const bucket = (n) => (n < MB ? '<1MB' : n < 5 * MB ? '1-5MB' : n < 10 * MB ? '5-10MB' : n < 25 * MB ? '10-25MB' : '25-50MB')

/** An error's class, never its text: pdf.js exception names, then coarse shapes. */
function classOf(msg) {
  const m = String(msg)
  for (const k of ['PasswordException', 'InvalidPDFException', 'MissingPDFException', 'UnexpectedResponseException', 'FormatError', 'UnknownErrorException', 'AbortException'])
    if (m.includes(k)) return k
  if (/timed out/.test(m)) return `timeout(${m.replace(/^.*timed out waiting for /, '').slice(0, 30)})`
  if (/crash/i.test(m)) return 'renderer-crash'
  if (/out of memory|Array buffer allocation/i.test(m)) return 'out-of-memory'
  const name = /^(\w*Error)\b/.exec(m)?.[1]
  return name ?? 'other'
}

const dir = mkdtempSync(resolve(tmpdir(), 'ts-pdfgate-'))
writeFileSync(resolve(dir, 'page.html'), v2ReaderPageHtml(randomBytes(18).toString('base64')))
const browser = await chromium.launch()
const rows = []

async function gate(file) {
  const r = { size: statSync(file).size, pages: null, openMs: null, firstPageMs: null, inked: null, forward: null, last: null, textLayer: null, textPage: null, selection: null, resume: null, heapMB: null, longTaskMs: null, warnings: {}, errors: [] }
  const page = await browser.newPage({ viewport: { width: 420, height: 760 } })
  // The corpus file is the one book served; its path never enters a URL.
  await routeBookOrigin(page, dir, (u) => (u === `${BOOK_ORIGIN}/v2/books/gate.pdf` ? file : null))
  const messages = []
  const errors = new Set()
  page.on('pageerror', (e) => errors.add(classOf(`${e.name}: ${e.message}`)))
  page.on('crash', () => errors.add('renderer-crash'))
  // pdf.js's own warnings, by class only (their text can name a font or object of the document).
  page.on('console', (c) => {
    const t = c.text()
    if (!/^Warning:/.test(t)) return
    const k = /cMap|CMap/.test(t) ? 'cmap' : /standardFontData|standard font|loadFont|translateFont|font/i.test(t) ? 'font'
      : /JPX|Jpx|OpenJPEG|wasm/i.test(t) ? 'jpx/wasm' : /image|JBIG|CCITT|DCT/i.test(t) ? 'image' : 'other'
    r.warnings[k] = (r.warnings[k] ?? 0) + 1
  })
  await page.exposeFunction('__toHost', (json) => {
    const m = JSON.parse(json)
    messages.push(m)
    if (m.type === 'log' && m.level === 'error') errors.add(classOf(m.msg))
  })
  await page.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
  // The longest main-thread task: pdf.js runs its worker on this thread, so a long parse or render is input lag.
  await page.addInitScript(() => {
    if (window !== top) return
    window.__longest = 0
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longest = Math.max(window.__longest, e.duration) }).observe({ type: 'longtask', buffered: true })
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  let heap = 0
  const sampler = setInterval(() => cdp.send('Performance.getMetrics').then(({ metrics }) => {
    heap = Math.max(heap, metrics.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0)
  }).catch(() => {}), 200)

  const waitFor = async (from, match, what) => {
    for (const t0 = Date.now(); Date.now() - t0 < STEP_MS; await page.waitForTimeout(50)) {
      const m = messages.slice(from).find(match)
      if (m) return m
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  /** The section frame on screen: canvas drawn, and whether its text layer has any text. */
  const shownPage = async () => {
    for (const f of page.frames().filter((f) => f.url().startsWith('blob:'))) {
      const s = await f.evaluate(() => {
        if (getComputedStyle(frameElement.parentElement).display === 'none') return null
        const c = document.querySelector('#canvas canvas')
        let inked = false
        if (c?.width && c.height) {
          // Any pixel that is not near-white, on a grid: the page shows something (not only a blank sheet).
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
          for (let i = 0; i < d.length && !inked; i += 4 * 97) inked = d[i + 3] > 0 && (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200)
        }
        return { drawn: !!c && c.width > 0 && c.height > 0, inked, text: !!document.querySelector('.textLayer')?.textContent.trim() }
      }).catch(() => null)
      if (s) return s
    }
    return null
  }
  const drawn = async (ms = STEP_MS) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await page.waitForTimeout(100)) if ((await shownPage())?.drawn) return true
    return false
  }
  const at = (from, index, ms = STEP_MS) => {
    const until = Date.now() + ms
    const poll = async () => {
      for (; Date.now() < until; await page.waitForTimeout(50)) if (messages.slice(from).some((x) => x.type === 'relocate' && x.index === index)) return true
      return false
    }
    return poll()
  }
  const call = (js) => page.evaluate(js)
  const url = `${BOOK_ORIGIN}/v2/books/gate.pdf`
  const open = async (stored) => {
    const from = messages.length
    const t0 = Date.now()
    await call(`window.__fol.openUrl(${JSON.stringify(url)}, 'gate')`)
    const m = await waitFor(from, (x) => x.type === 'opened' || x.type === 'open-failed', 'opened')
    if (m.type === 'open-failed') throw new Error(`open-failed: ${m.error}`)
    const openMs = Date.now() - t0
    await call(`window.__fol.restore(${JSON.stringify(stored)})`)
    const restored = await waitFor(from, (x) => x.type === 'restored', 'restored')
    return { m, from, t0, openMs, restored }
  }

  try {
    await page.goto(PAGE_URL)
    await waitFor(0, (x) => x.type === 'ready', 'ready')
    // Open → page 1 drawn.
    const o = await open(null)
    r.pages = o.m.sections
    r.openMs = o.openMs
    r.firstPageMs = (await drawn()) ? Date.now() - o.t0 : null
    // The canvas is replaced as the render finishes: give it a moment before reading pixels.
    for (const t0 = Date.now(); Date.now() - t0 < 5000 && !r.inked; await page.waitForTimeout(250)) r.inked = !!(await shownPage())?.inked
    const N = r.pages
    // Forward ×3 (as far as the book goes), each page arrived and drawn.
    let ok = true
    for (let i = 1; i <= Math.min(3, N - 1); i++) {
      const from = messages.length
      await call('window.__fol.next()')
      ok = ok && (await at(from, i)) && (await drawn(STEP_MS / 3))
    }
    r.forward = N > 1 ? ok : 'n/a'
    // Jump to the last page as the reader's own choice (saved), arrived and drawn.
    // Already there (the forward steps ended on it, 2-4 pages): no relocate will come, so none is waited for.
    const there = messages.filter((x) => x.type === 'relocate').at(-1)?.index === N - 1
    let from = messages.length
    await call(`window.__fol.goTo(${N - 1}, true)`)
    const lastArrived = N === 1 || ((there || (await at(from, N - 1))) && (await drawn(STEP_MS / 3)))
    const store = await waitFor(from, (x) => x.type === 'store', 'store').catch(() => null)
    const saved = store && JSON.parse(store.json)
    r.last = lastArrived && (N === 1 || saved?.position?.page === N)
    // Save + reopen: resumes at the saved page (page 1 of a one-page file has nothing to move to).
    if (saved?.position?.page) {
      const again = await open(JSON.stringify(saved))
      r.resume = again.restored.position === 'restored' && (await at(again.from, saved.position.page - 1)) && (await drawn())
    } else r.resume = N === 1 ? 'n/a' : false
    // Text selection on the first page whose text layer has text: pages 1-10, then every 10th page (a scan's
    // front matter can be images only). Host moves: nothing is saved.
    r.textLayer = false
    const probes = [...Array(Math.min(N, 10)).keys(), ...Array.from({ length: Math.max(0, Math.ceil((N - 10) / 10)) }, (_, k) => 10 + k * 10)].slice(0, 40)
    for (const i of probes) {
      if (r.textLayer) break
      from = messages.length
      await call(`window.__fol.goTo(${i})`)
      // The page already shown answers no relocate: a short wait, its result not needed.
      await at(from, i, 5000)
      await drawn(STEP_MS / 3)
      // The text layer renders after the canvas.
      for (const t0 = Date.now(); Date.now() - t0 < 3000 && !r.textLayer; await page.waitForTimeout(150)) r.textLayer = !!(await shownPage())?.text
      if (r.textLayer) r.textPage = i + 1
    }
    if (r.textLayer) {
      for (const f of page.frames().filter((f) => f.url().startsWith('blob:'))) {
        const s = await f.evaluate(() => {
          if (getComputedStyle(frameElement.parentElement).display === 'none') return null
          const sel = getSelection()
          sel.selectAllChildren(document.querySelector('.textLayer'))
          return sel.toString().trim().length > 0
        }).catch(() => null)
        if (s !== null) { r.selection = s; break }
      }
    } else r.selection = 'n/a'
  } catch (e) {
    errors.add(classOf(e?.message ?? e))
  } finally {
    r.longTaskMs = await page.evaluate(() => Math.round(window.__longest)).catch(() => null)
    clearInterval(sampler)
    r.heapMB = heap ? Math.round(heap / MB) : null
    r.errors = [...errors]
    await page.close().catch(() => {})
  }
  return r
}

const yn = (v) => (v === true ? 'yes' : v === false ? 'NO' : v ?? '-')
console.log('| file | size | pages | open ms | first page ms | page 1 inked | forward x3 | last page | resume | text layer (page) | selection | peak JS heap MB | longest task ms | pdf.js warnings | errors |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
try {
  for (let i = 0; i < files.length; i++) {
    if (only && !only.includes(i + 1)) continue
    const r = await gate(files[i])
    rows.push({ id: label(i), ...r })
    const warnings = Object.entries(r.warnings).map(([k, v]) => `${k} ${v}`).join(', ') || '-'
    console.log(`| ${label(i)} | ${bucket(r.size)} | ${r.pages ?? '-'} | ${r.openMs ?? '-'} | ${r.firstPageMs ?? '-'} | ${yn(r.inked)} | ${yn(r.forward)} | ${yn(r.last)} | ${yn(r.resume)} | ${yn(r.textLayer)}${r.textPage ? ` (${r.textPage})` : ''} | ${yn(r.selection)} | ${r.heapMB ?? '-'} | ${r.longTaskMs ?? '-'} | ${warnings} | ${r.errors.join(', ') || '-'} |`)
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

const n = rows.length
const count = (k, v = true) => rows.filter((r) => r[k] === v).length
const applicable = (k) => rows.filter((r) => r[k] !== 'n/a').length
console.log(`\nfiles ${n}; opened ${rows.filter((r) => r.pages != null).length}/${n}; first page drawn ${rows.filter((r) => r.firstPageMs != null).length}/${n}; ` +
  `forward x3 ${count('forward')}/${applicable('forward')}; last page ${count('last')}/${n}; resume ${count('resume')}/${applicable('resume')}; ` +
  `page 1 inked ${count('inked')}/${n}; text layer ${count('textLayer')}/${n}; selection ${count('selection')}/${applicable('selection')}; with errors ${rows.filter((r) => r.errors.length).length}/${n}`)
const sorted = (k) => rows.map((r) => r[k]).filter((v) => typeof v === 'number').sort((a, b) => a - b)
for (const k of ['openMs', 'firstPageMs', 'heapMB', 'longTaskMs']) {
  const v = sorted(k)
  if (v.length) console.log(`${k}: median ${v[Math.floor(v.length / 2)]}, p90 ${v[Math.floor(v.length * 0.9)]}, max ${v.at(-1)}`)
}
