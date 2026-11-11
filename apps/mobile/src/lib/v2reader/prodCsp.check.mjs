// The production-CSP gate (#1219): the web host's frame document, served by the one handler that serves it
// (frame.mjs `serveV2ReaderFrame`, the Vite dev server's too), works under the app's real Content-Security-
// Policy, read from infra/nginx/textstack.conf, so the two cannot drift. A local server plays nginx; its host
// document loads an external 'self' script, as the app bundle does, embeds the page in `<iframe
// sandbox="allow-scripts allow-same-origin">`, transfers it the v2-sync EPUB (text) and then tsfonts
// (fixtures.mjs: a linked stylesheet and @font-face, so the book's blob: CSS and fonts are exercised), and
// records every CSP violation in any frame. Rows, all at once (one page each):
//   frame           <iframe src>: must open, render text, apply book CSS, load the book font, with no
//                   violation; an un-nonced script must not run. Plus: a fresh hex nonce per response.
//   srcdoc-control  the served document as srcdoc, host without CSP: works (so the next row fails by CSP alone).
//   srcdoc          the same under the app CSP: never sends `ready`, refused by script-src. Why the host does
//                   not use srcdoc.
//   server-hdrs     the handler's document under the app's server-level headers (what an nginx location
//                   without its own add_header set sends, #857): refused by frame-ancestors 'none'.
//   foreign-host    another origin (localhost vs 127.0.0.1) embedding the frame: refused by frame-ancestors 'self'.
//   unfilled        the template served without its nonce filled (a skipped sub_filter): no script runs, not
//                   even one carrying the placeholder as its nonce. The placeholder fails closed.
// A negative row waits the whole READY_MS for `ready` before it says "never".
//
//   node --experimental-strip-types prodCsp.check.mjs      (pnpm -C apps/web check:v2-reader-prod-csp)
//
// Exit 1 when a row's outcome differs from the one stated above.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFontsEpub } from './fixtures.mjs'
import { FRAME_NONCE_PLACEHOLDER, V2_READER_FRAME_HEADERS, V2_READER_FRAME_PATH, serveV2ReaderFrame, v2ReaderFrameTemplate } from './frame.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../../..')
const { chromium } = createRequire(resolve(repo, 'apps/web/package.json'))('@playwright/test')
const READY_MS = 8000
const STEP_MS = 10000
const DEADLINE_MS = 120000
setTimeout(() => { console.error(`FAIL: deadline ${DEADLINE_MS / 1000} s`); process.exit(1) }, DEADLINE_MS).unref()

const BOOK = readFileSync(resolve(repo, 'apps/web/e2e/fixtures/v2-sync.epub'))
const BOOK_TEXT = 'The Pond, paragraph 1.'
const tmp = mkdtempSync(resolve(tmpdir(), 'ts-v2-prodcsp-'))
writeFontsEpub(resolve(tmp, 'tsfonts.epub'))
const FONTS_BOOK = readFileSync(resolve(tmp, 'tsfonts.epub'))
rmSync(tmp, { recursive: true, force: true })

// The server-level headers of the app's server block: its CSP and X-Frame-Options, verbatim.
const conf = readFileSync(resolve(repo, 'infra/nginx/textstack.conf'), 'utf8')
const APP_CSP = conf.match(/^ {4}add_header Content-Security-Policy "(default-src 'self';[^"]+)" always;$/m)?.[1]
const APP_XFO = conf.match(/^ {4}add_header X-Frame-Options "([^"]+)" always;$/m)?.[1]
if (!APP_CSP || !APP_XFO) { console.error('app CSP / X-Frame-Options not found in infra/nginx/textstack.conf'); process.exit(2) }
// The frame needs `frame-src 'self'` in the app CSP. Until the production route lands it in nginx, the
// check adds it (and says so); afterwards it is read as is.
const appFrameSrc = APP_CSP.match(/(?:^|; )frame-src ([^;]*)/)?.[1] ?? ''
const HOST_CSP = appFrameSrc.split(' ').includes("'self'") ? APP_CSP : APP_CSP.replace(/((?:^|; )frame-src [^;]*)/, "$1 'self'")
if (HOST_CSP !== APP_CSP) console.log("note: the app CSP has no frame-src 'self' yet (the production route adds it); added here")

/** `serve`: how the frame path answers for this row. */
const ROWS = [
  { id: 'frame', mode: 'src', host: HOST_CSP, serve: 'handler', works: true },
  { id: 'srcdoc-control', mode: 'srcdoc', host: null, serve: 'handler', works: true },
  { id: 'srcdoc', mode: 'srcdoc', host: APP_CSP, serve: 'handler', refusedBy: 'script-src-elem' },
  { id: 'server-hdrs', mode: 'src', host: HOST_CSP, serve: 'server-headers', refusedBy: 'frame-ancestors' },
  { id: 'foreign-host', mode: 'src', host: null, foreign: true, serve: 'handler', refusedBy: 'frame-ancestors' },
  { id: 'unfilled', mode: 'src', host: HOST_CSP, serve: 'unfilled', refusedBy: 'script-src-elem', placeholderProbe: true },
]

// srcdoc: the host puts the served document (the handler's, nonce filled) into srcdoc; src: the frame loads it.
const HOST_JS = `
const p = new URLSearchParams(location.search);
window.__msgs = [];
const f = document.createElement('iframe');
f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
f.style.cssText = 'width:800px;height:600px';
addEventListener('message', (e) => {
  if (e.source !== f.contentWindow || typeof e.data !== 'string') return;
  const m = JSON.parse(e.data);
  window.__msgs.push(m.type);
  if (m.type === 'ready') window.__open('/book.epub', 'v2-sync.epub');
});
window.__open = async (path, name) => {
  const bytes = await (await fetch(path)).arrayBuffer();
  f.contentWindow.postMessage({ call: 'openBytes', args: [bytes, name] }, location.origin, [bytes]);
};
const frameUrl = (p.get('frameOrigin') ?? '') + ${JSON.stringify(V2_READER_FRAME_PATH)} + '?row=' + p.get('row');
if (p.get('mode') === 'src') f.src = frameUrl;
else f.srcdoc = await (await fetch(frameUrl)).text();
document.body.append(f);`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const row = ROWS.find((r) => r.id === url.searchParams.get('row'))
  if (url.pathname === '/host' && row) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(row.host && { 'Content-Security-Policy': row.host }) })
    return res.end(`<!doctype html><html><head></head><body><script type="module" src="/host.js?row=${row.id}"></script></body></html>`)
  }
  if (url.pathname === '/host.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(HOST_JS)
  if (url.pathname === '/book.epub') return res.writeHead(200).end(BOOK)
  if (url.pathname === '/fonts.epub') return res.writeHead(200).end(FONTS_BOOK)
  if (row?.serve === 'unfilled' && url.pathname === V2_READER_FRAME_PATH)
    return res.writeHead(200, V2_READER_FRAME_HEADERS).end(v2ReaderFrameTemplate())
  if (row?.serve === 'server-headers') {
    // The handler's own document, with the headers a location that sets none of its own would send.
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status) => writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': APP_CSP, 'X-Frame-Options': APP_XFO })
  }
  if (serveV2ReaderFrame(req, res)) return
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const failures = []
const report = []
const check = (log, ok, what) => { log.push(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runRow(browser, row) {
  const log = [`\n(${row.id}) ${row.mode === 'src' ? '<iframe src>' : 'srcdoc'}, host ${row.foreign ? 'on another origin, ' : ''}`
    + `${!row.host ? 'no CSP' : row.host === APP_CSP ? 'app CSP (verbatim)' : "app CSP + frame-src 'self'"}; frame served by ${row.serve}`]
  const page = await browser.newPage()
  const violations = []
  // A frame-ancestors refusal fires no event in the embedding document: the console is its only trace.
  page.on('console', (m) => { if (/Content Security Policy|X-Frame-Options/i.test(m.text())) violations.push(`console: ${m.text().slice(0, 220)}`) })
  await page.exposeBinding('__violation', ({ frame }, s) => violations.push(`${s} (in ${frame.url().split(/[?#]/)[0].replace(base, '') || frame.url()})`))
  // In every frame, by CDP, past any CSP.
  await page.addInitScript(() => addEventListener('securitypolicyviolation', (e) =>
    window.__violation(`${e.effectiveDirective} ${e.blockedURI || '(inline)'}`)))
  await page.goto(row.foreign
    ? `${base.replace('127.0.0.1', 'localhost')}/host?row=${row.id}&mode=src&frameOrigin=${base}`
    : `${base}/host?row=${row.id}&mode=${row.mode}`)
  const msgs = () => page.evaluate(() => window.__msgs ?? [])
  /** Waits up to `ms` for `fn`; a working row stops at its first violation (it must have none). */
  const until = async (fn, ms = STEP_MS) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms && !(row.works && violations.length); await sleep(100))
      if (await fn().catch(() => false)) return true
    return false
  }
  const reader = () => page.frames().find((f) => f.parentFrame() === page.mainFrame())
  const blobFrames = () => page.frames().filter((f) => f.url().startsWith('blob:'))
  const text = () => Promise.all(blobFrames().map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => ''))).then((t) => t.join('\n'))
  const fontState = () => Promise.all(blobFrames().map((f) => f.evaluate(async () => {
    const el = document.getElementById('plain')
    if (!el) return null
    await document.fonts.ready
    return { css: getComputedStyle(el).fontFamily.includes('TSPlain'),
      font: [...document.fonts].some((x) => x.family.replaceAll('"', '') === 'TSPlain' && x.status === 'loaded') }
  }).catch(() => null))).then((r) => r.find(Boolean))
  /** Runs a script carrying `nonce` (null: none) in the reader document; true if it ran. */
  const probe = (nonce) => reader().evaluate(async (n) => {
    const s = document.createElement('script')
    if (n) s.setAttribute('nonce', n)
    s.textContent = 'window.__probe = 1'
    document.body.append(s)
    await new Promise((r) => setTimeout(r, 200))
    return window.__probe === 1
  }, nonce)

  const ready = await until(async () => (await msgs()).includes('ready'), READY_MS)
  if (row.works) {
    const renders = ready && await until(async () => (await msgs()).includes('opened') && (await text()).includes(BOOK_TEXT))
    let css = false, font = false
    if (renders) {
      await page.evaluate(() => window.__open('/fonts.epub', 'tsfonts.epub'))
      await until(async () => (await msgs()).filter((x) => x === 'opened').length === 2 && (await fontState())?.font === true)
      ;({ css = false, font = false } = (await fontState()) ?? {})
    }
    for (const v of violations) log.push(`    violation: ${v}`)
    check(log, ready && renders, `${row.id}: ready, opens, renders the book text`)
    check(log, css && font, `${row.id}: book CSS applied (${css}) and book font loaded (${font}) from blob:`)
    check(log, !violations.length, `${row.id}: no CSP violation`)
    check(log, !(await probe(null)), `${row.id}: the page's own CSP holds: an un-nonced script does not run`)
  } else {
    for (const v of violations) log.push(`    violation: ${v}`)
    check(log, !ready, `${row.id}: never sends ready (waited ${READY_MS / 1000} s)`)
    check(log, violations.some((v) => v.startsWith(row.refusedBy) || v.includes(`directive: "${row.refusedBy} `)), `${row.id}: refused by ${row.refusedBy}`)
    if (row.placeholderProbe) {
      const html = await reader().evaluate(() => document.documentElement.outerHTML)
      check(log, html.includes(`nonce-${FRAME_NONCE_PLACEHOLDER}`), `${row.id}: the document is the unfilled template`)
      check(log, !(await probe(FRAME_NONCE_PLACEHOLDER)), `${row.id}: a script carrying the placeholder as its nonce does not run`)
    }
  }
  await page.close()
  report.push(...log)
}

const browser = await chromium.launch()
try {
  // The nonce is the handler's, per response: two fetches, two 32-hex nonces.
  const nonceOf = async () => (await (await fetch(`${base}${V2_READER_FRAME_PATH}`)).text()).match(/script-src 'nonce-([^']+)'/)?.[1]
  const [n1, n2] = [await nonceOf(), await nonceOf()]
  check(report, /^[0-9a-f]{32}$/.test(n1 ?? '') && n1 !== n2, `handler: a fresh nonce per response (${n1}, ${n2})`)
  const head = await fetch(`${base}${V2_READER_FRAME_PATH}`, { method: 'HEAD' })
  check(report, Object.entries(V2_READER_FRAME_HEADERS).every(([k, v]) => head.headers.get(k) === v), 'handler: sends every V2_READER_FRAME_HEADERS header')
  await Promise.all(ROWS.map((row) => runRow(browser, row)))
} finally {
  await browser.close()
  server.close()
}
console.log(report.join('\n'))
console.log(failures.length ? `\nFAIL: ${failures.length}\n  ${failures.join('\n  ')}` : '\nok: the frame document works under the app CSP; srcdoc, header-less, foreign and unfilled do not')
process.exit(failures.length ? 1 : 0)
