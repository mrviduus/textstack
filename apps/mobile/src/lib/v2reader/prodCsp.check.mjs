// The production-CSP gate (#1219): the web host's real frame document (frame.mjs, the file the dev server
// serves and the production route will) works under the app's real Content-Security-Policy, read from
// infra/nginx/textstack.conf, so the two cannot drift. A local server plays nginx; its host document loads
// an external 'self' script, as the app bundle does, embeds the page in `<iframe sandbox="allow-scripts
// allow-same-origin">`, transfers it the v2-sync EPUB (text) and then tsfonts (fixtures.mjs: a linked
// stylesheet and @font-face, so the book's blob: CSS and fonts are exercised), and records every CSP
// violation in any frame. Rows:
//   frame         <iframe src>, the frame's own headers (V2_READER_FRAME_HEADERS): must open, render text,
//                 apply book CSS, load the book font; an un-nonced script must not run; a nonce per response.
//   srcdoc        pinned negative: the same document as srcdoc inherits the app CSP and never sends `ready`
//                 (script-src). Why the host does not use srcdoc.
//   server-hdrs   pinned negative: the frame file under the app's server-level headers (what an nginx
//                 location without its own add_header set sends, #857): refused by frame-ancestors 'none'.
//   foreign-host  another origin (localhost vs 127.0.0.1) embedding the frame: refused by its own
//                 frame-ancestors 'self'.
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
import { writeFontsEpub } from './fixtures.mjs'
import { V2_READER_FRAME_HEADERS, V2_READER_FRAME_PATH, fillNonce, v2ReaderFrameTemplate } from './frame.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../../..')
const { chromium } = createRequire(resolve(repo, 'apps/web/package.json'))('@playwright/test')
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

const TEMPLATE = v2ReaderFrameTemplate()
const ROWS = [
  { id: 'frame', mode: 'src', host: HOST_CSP, frame: V2_READER_FRAME_HEADERS, works: true },
  { id: 'srcdoc', mode: 'srcdoc', host: APP_CSP, works: false, refusedBy: 'script-src-elem' },
  { id: 'server-hdrs', mode: 'src', host: HOST_CSP, frame: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': APP_CSP, 'X-Frame-Options': APP_XFO },
    works: false, refusedBy: 'frame-ancestors' },
  { id: 'foreign-host', mode: 'src', host: null, foreign: true, frame: V2_READER_FRAME_HEADERS, works: false, refusedBy: 'frame-ancestors' },
]

// srcdoc: the host fills a fresh nonce itself, as the old srcdoc host did; src: the server did.
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
if (p.get('mode') === 'src') f.src = (p.get('frameOrigin') ?? '') + ${JSON.stringify(V2_READER_FRAME_PATH)} + '?row=' + p.get('row');
else {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  f.srcdoc = (await (await fetch('/frame-template.html')).text()).split('__V2_READER_NONCE__').join(nonce);
}
document.body.append(f);`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const row = ROWS.find((r) => r.id === url.searchParams.get('row'))
  if (url.pathname === '/host' && row) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(row.host && { 'Content-Security-Policy': row.host }) })
    return res.end(`<!doctype html><html><head></head><body><script type="module" src="/host.js?row=${row.id}"></script></body></html>`)
  }
  if (url.pathname === '/host.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(HOST_JS)
  if (url.pathname === '/frame-template.html') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(TEMPLATE)
  // What nginx `sub_filter '__V2_READER_NONCE__' $request_id` does: 16 random bytes, hex, per response.
  if (url.pathname === V2_READER_FRAME_PATH) return res.writeHead(200, row?.frame ?? V2_READER_FRAME_HEADERS).end(fillNonce(TEMPLATE, randomBytes(16).toString('hex')))
  if (url.pathname === '/book.epub') return res.writeHead(200).end(BOOK)
  if (url.pathname === '/fonts.epub') return res.writeHead(200).end(FONTS_BOOK)
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const failures = []
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }

const browser = await chromium.launch()
try {
  // The nonce is the server's, per response: two fetches, two nonces, neither the placeholder.
  const nonceOf = async () => (await (await fetch(`${base}${V2_READER_FRAME_PATH}`)).text()).match(/script-src 'nonce-([^']+)'/)?.[1]
  const [n1, n2] = [await nonceOf(), await nonceOf()]
  check(/^[0-9a-f]{32}$/.test(n1 ?? '') && n1 !== n2, `frame document: a fresh nonce per response (${n1}, ${n2})`)

  for (const row of ROWS) {
    console.log(`\n(${row.id}) ${row.mode === 'src' ? '<iframe src>' : 'srcdoc'}, host ${row.foreign ? 'on another origin, no CSP' : `CSP ${row.host === APP_CSP ? 'app (verbatim)' : "app + frame-src 'self'"}`}`
      + (row.frame ? `; frame headers ${row.frame === V2_READER_FRAME_HEADERS ? 'V2_READER_FRAME_HEADERS' : 'server-level'}` : ''))
    const page = await browser.newPage()
    const violations = []
    // A frame-ancestors refusal fires no event in the embedding document: the console is its only trace.
    page.on('console', (m) => { if (/Content Security Policy|X-Frame-Options/i.test(m.text())) violations.push(`console: ${m.text().slice(0, 220)}`) })
    await page.exposeBinding('__violation', ({ frame }, s) => violations.push(`${s} (in ${frame.url().split(/[?#]/)[0].replace(base, '') || frame.url()})`))
    // In every frame, by CDP, past any CSP.
    await page.addInitScript(() => addEventListener('securitypolicyviolation', (e) =>
      window.__violation(`${e.effectiveDirective} ${e.blockedURI || '(inline)'}`)))
    await page.goto(row.foreign ? `${base.replace('127.0.0.1', 'localhost')}/host?row=${row.id}&mode=src&frameOrigin=${base}` : `${base}/host?row=${row.id}&mode=${row.mode}`)
    const msgs = () => page.evaluate(() => window.__msgs ?? [])
    // Waits for `fn`; stops at the first violation (a working row has none; a refused one shows it at once).
    const until = async (fn) => {
      for (const t0 = Date.now(); Date.now() - t0 < STEP_MS && !violations.length; await new Promise((r) => setTimeout(r, 100)))
        if (await fn().catch(() => false)) return true
      return false
    }
    const blobFrames = () => page.frames().filter((f) => f.url().startsWith('blob:'))
    const text = () => Promise.all(blobFrames().map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => ''))).then((t) => t.join('\n'))
    const fontState = () => Promise.all(blobFrames().map((f) => f.evaluate(async () => {
      const el = document.getElementById('plain')
      if (!el) return null
      await document.fonts.ready
      return { css: getComputedStyle(el).fontFamily.includes('TSPlain'),
        font: [...document.fonts].some((x) => x.family.replaceAll('"', '') === 'TSPlain' && x.status === 'loaded') }
    }).catch(() => null))).then((r) => r.find(Boolean))

    const ready = await until(async () => (await msgs()).includes('ready'))
    const renders = ready && await until(async () => (await msgs()).includes('opened') && (await text()).includes(BOOK_TEXT))
    let css = false, font = false
    if (renders) {
      await page.evaluate(() => window.__open('/fonts.epub', 'tsfonts.epub'))
      await until(async () => (await msgs()).filter((x) => x === 'opened').length === 2 && (await fontState())?.font === true)
      ;({ css = false, font = false } = (await fontState()) ?? {})
    }
    const seen = [...violations]
    for (const v of seen) console.log(`    violation: ${v}`)

    if (row.works) {
      check(ready && renders, 'ready, opens, renders the book text')
      check(css && font, `book CSS applied (${css}) and book font loaded (${font}) from blob:`)
      check(!seen.length, 'no CSP violation')
      const reader = page.frames().find((f) => f.parentFrame() === page.mainFrame())
      const unNonced = await reader.evaluate(async () => {
        const s = document.createElement('script')
        s.textContent = 'window.__unnonced = 1'
        document.body.append(s)
        await new Promise((r) => setTimeout(r, 200))
        return window.__unnonced === 1
      })
      check(!unNonced && violations.some((v) => v.startsWith('script-src-elem')), "the page's own CSP holds: an un-nonced script does not run")
    } else {
      check(!ready, 'refused: never sends ready')
      check(seen.some((v) => v.startsWith(row.refusedBy) || v.includes(`directive: "${row.refusedBy} `)), `refused by ${row.refusedBy}`)
    }
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
}
console.log(failures.length ? `\nFAIL: ${failures.length}\n  ${failures.join('\n  ')}` : '\nok: the frame document works under the app CSP; srcdoc and a header-less location do not')
process.exit(failures.length ? 1 : 0)
