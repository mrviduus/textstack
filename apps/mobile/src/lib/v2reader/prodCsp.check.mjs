// The production-CSP gate (#1219, #1225): the web host's frame, the no-store shell + its cached page script,
// served by the one handler that serves them (frame.mjs `serveV2ReaderFrame`, the Vite dev and preview servers'
// too), works under the app's real Content-Security-Policy, read from infra/nginx/textstack.conf, so the two
// cannot drift; and that file's reader locations send what the handler sends. A local server plays nginx; its host
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
//   unfilled        the shell served without its nonce filled (a skipped sub_filter): no script runs, the page
//                   script neither, not even one carrying the placeholder as its nonce. It fails closed.
//   script-nonce    the shell with the page script's nonce attribute dropped: refused by script-src (the
//                   app's 'self' does not reach into the frame's own policy).
//   tampered        the page script with one byte more than the shell's integrity: refused, never run.
// A negative row waits the whole READY_MS for `ready` before it says "never".
//
//   node --experimental-strip-types prodCsp.check.mjs      (pnpm -C apps/web check:v2-reader-prod-csp)
//
// Exit 1 when a row's outcome differs from the one stated above.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mobi, writeFontsEpub } from './fixtures.mjs'
import {
  FRAME_NONCE_PLACEHOLDER, V2_READER_FRAME_HEADERS, V2_READER_FRAME_PATH, V2_READER_SCRIPT_HEADERS, fillNonce, serveV2ReaderFrame,
  v2ReaderFrameFiles, v2ReaderFrameTemplate,
} from './frame.mjs'

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
const MOBI_TEXT = 'A MOBI paragraph through the shell.'
const MOBI_BOOK = mobi('TS MOBI', `<html><body><p>${MOBI_TEXT}</p></body></html>`)
rmSync(tmp, { recursive: true, force: true })

// The server-level headers of the app's server block: its CSP and X-Frame-Options, verbatim.
const conf = readFileSync(resolve(repo, 'infra/nginx/textstack.conf'), 'utf8')
const APP_CSP = conf.match(/^ {4}add_header Content-Security-Policy "(default-src 'self';[^"]+)" always;$/m)?.[1]
const APP_XFO = conf.match(/^ {4}add_header X-Frame-Options "([^"]+)" always;$/m)?.[1]
if (!APP_CSP || !APP_XFO) { console.error('app CSP / X-Frame-Options not found in infra/nginx/textstack.conf'); process.exit(2) }
// The frame needs `frame-src 'self'` in the app CSP (#1225 put it there).
const appFrameSrc = APP_CSP.match(/(?:^|; )frame-src ([^;]*)/)?.[1] ?? ''
if (!appFrameSrc.split(' ').includes("'self'")) { console.error("the app CSP has no frame-src 'self': the reader frame cannot load"); process.exit(2) }

// The reader's nginx locations (textstack.app server), as text: what they send must be what the handler sends.
const frameLocation = conf.match(/\n {4}location = \/reader-v2\/frame\.html \{\n([\s\S]*?)\n {4}\}/)?.[1] ?? ''
const scriptLocation = conf.match(/\n {4}location ~ "(\^\/reader-v2\/page[^"]*)" \{\n([\s\S]*?)\n {4}\}/)

const { shell: SHELL, script: SCRIPT, scriptPath: SCRIPT_PATH } = v2ReaderFrameFiles()
/** Must change the text it is given: a transform that no longer matches would make its row test nothing. */
const changed = (before, after) => { if (after === before) throw new Error('prodCsp.check: a row transform matched nothing'); return after }

/** `serve`: how the frame path answers for this row. */
const ROWS = [
  { id: 'frame', mode: 'src', host: APP_CSP, serve: 'handler', works: true },
  { id: 'srcdoc-control', mode: 'srcdoc', host: null, serve: 'handler', works: true },
  { id: 'srcdoc', mode: 'srcdoc', host: APP_CSP, serve: 'handler', refusedBy: 'script-src-elem' },
  { id: 'server-hdrs', mode: 'src', host: APP_CSP, serve: 'server-headers', refusedBy: 'frame-ancestors' },
  { id: 'foreign-host', mode: 'src', host: null, foreign: true, serve: 'handler', refusedBy: 'frame-ancestors' },
  { id: 'unfilled', mode: 'src', host: APP_CSP, serve: 'unfilled', refusedBy: 'script-src-elem', placeholderProbe: true },
  { id: 'script-nonce', mode: 'src', host: APP_CSP, serve: 'shell',
    shell: (s) => changed(s, s.replace(/<script nonce="[0-9a-f]{32}" src=/, '<script src=')), refusedBy: 'script-src-elem' },
  { id: 'tampered', mode: 'src', host: APP_CSP, serve: 'shell',
    shell: (s) => changed(s, s.replace(`src="${SCRIPT_PATH}"`, `src="${SCRIPT_PATH}?row=tampered"`)), refusedBy: 'integrity' },
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
  if (url.pathname === '/book.mobi') return res.writeHead(200).end(MOBI_BOOK)
  if (row?.serve === 'unfilled' && url.pathname === V2_READER_FRAME_PATH)
    return res.writeHead(200, V2_READER_FRAME_HEADERS).end(v2ReaderFrameTemplate())
  if (row?.serve === 'shell' && url.pathname === V2_READER_FRAME_PATH)
    return res.writeHead(200, V2_READER_FRAME_HEADERS).end(row.shell(fillNonce(SHELL, randomBytes(16).toString('hex'))))
  if (row?.id === 'tampered' && url.pathname === SCRIPT_PATH)
    return res.writeHead(200, V2_READER_SCRIPT_HEADERS).end(`${SCRIPT};`)
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
  // A frame-ancestors refusal fires no event in the embedding document, nor does an integrity mismatch: the
  // console is their only trace.
  page.on('console', (m) => {
    if (/Content Security Policy|X-Frame-Options/i.test(m.text())) violations.push(`console: ${m.text().slice(0, 220)}`)
    if (/'integrity' attribute/.test(m.text())) violations.push(`integrity: ${m.text().slice(0, 220)}`)
  })
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
    // A format reader runs as an inline script under the nonce page.mjs reads from document.currentScript:
    // here that is the external page script's (#1225), so a MOBI proves the nonce reaches it.
    const mobi = renders && await page.evaluate(() => window.__open('/book.mobi', 'tsformat.mobi')).then(() =>
      until(async () => (await msgs()).filter((x) => x === 'opened').length === 3 && (await text()).includes(MOBI_TEXT)))
    for (const v of violations) log.push(`    violation: ${v}`)
    check(log, ready && renders, `${row.id}: ready, opens, renders the book text`)
    check(log, css && font, `${row.id}: book CSS applied (${css}) and book font loaded (${font}) from blob:`)
    check(log, mobi, `${row.id}: a MOBI opens (its format reader runs under the page's nonce)`)
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
  const js = await fetch(`${base}${SCRIPT_PATH}`)
  check(report, Object.entries(V2_READER_SCRIPT_HEADERS).every(([k, v]) => js.headers.get(k) === v) && (await js.text()) === SCRIPT,
    `handler: ${SCRIPT_PATH} is the page script, immutable, JS under nosniff`)
  check(report, (await fetch(`${base}/reader-v2/page.0000000000000000.js`)).status === 404, 'handler: a stale script name is a 404')

  // nginx, as text (no nginx here): the shell location sends the frame headers and fills the placeholder with
  // $request_id; the script location takes this script's name and caches it as the handler does.
  const addHeader = (k, v) => frameLocation.includes(`add_header ${k} "${v}" always;`)
  check(report, Object.entries(V2_READER_FRAME_HEADERS).every(([k, v]) => k === 'Content-Type' || addHeader(k, v))
    && /default_type text\/html;\s+charset utf-8;/.test(frameLocation), 'nginx: the frame location sends every V2_READER_FRAME_HEADERS header')
  check(report, frameLocation.includes(`sub_filter '${FRAME_NONCE_PLACEHOLDER}' $request_id;`) && frameLocation.includes('sub_filter_once off;'),
    'nginx: the frame location fills every placeholder with $request_id')
  check(report, !!scriptLocation && new RegExp(scriptLocation[1]).test(SCRIPT_PATH) && !/add_header/.test(scriptLocation[2])
    && scriptLocation[2].includes(`set $cache_immutable "${V2_READER_SCRIPT_HEADERS['Cache-Control']}";`)
    && /default_type text\/javascript;\s+charset utf-8;\s+charset_types text\/javascript;/.test(scriptLocation[2]),
    'nginx: the script location matches this script, immutable, JS utf-8, server-level headers (nosniff) kept')
  await Promise.all(ROWS.map((row) => runRow(browser, row)))
} finally {
  await browser.close()
  server.close()
}
console.log(report.join('\n'))
console.log(failures.length ? `\nFAIL: ${failures.length}\n  ${failures.join('\n  ')}` : '\nok: the shell + script work under the app CSP; srcdoc, header-less, foreign, unfilled, un-nonced and tampered do not')
process.exit(failures.length ? 1 : 0)
