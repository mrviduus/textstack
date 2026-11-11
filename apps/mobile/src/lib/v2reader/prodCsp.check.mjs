// The production-CSP experiment (wave 13, web hosting): does the V2 reader page work when the web app
// hosts it on its own origin under the app's real Content-Security-Policy? A local server plays nginx:
// it serves a host document with the CSP header copied verbatim from infra/nginx/textstack.conf, which
// embeds the committed page like the dev host does (V2ReaderDevPage.tsx: srcdoc + host shim, sandbox
// "allow-scripts allow-same-origin") or as its own same-origin document (`<iframe src>`), then hands it
// the v2-sync EPUB and waits for ready → opened → text in a section frame. Every CSP violation in any
// frame is recorded (`directive blockedURI`), plus whether an un-nonced script still runs in the page.
//
//   node --experimental-strip-types prodCsp.check.mjs      (pnpm -C apps/web check:v2-reader-prod-csp)
//
// Exit 1 when the control (no CSP) fails, or a variant's outcome differs from the one recorded below
// (EXPECT): the table is the evidence, the exit code keeps it honest.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFontsEpub } from './fixtures.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../../..')
const { chromium } = createRequire(resolve(repo, 'apps/web/package.json'))('@playwright/test')
const EPUB = readFileSync(resolve(repo, 'apps/web/e2e/fixtures/v2-sync.epub'))
const FIRST_SECTION_TEXT = 'The Pond, paragraph 1.'
// v2-sync has no CSS or fonts; tsfonts (fixtures.mjs) links a stylesheet with @font-face, so the book's
// blob: CSS and fonts are exercised too.
const tmp = mkdtempSync(resolve(tmpdir(), 'ts-v2-prodcsp-'))
writeFontsEpub(resolve(tmp, 'tsfonts.epub'))
const FONTS_EPUB = readFileSync(resolve(tmp, 'tsfonts.epub'))
rmSync(tmp, { recursive: true, force: true })
const STEP_MS = 10000

// The server-level CSP of the app (the `add_header Content-Security-Policy` in the main server block),
// read from the config so the check follows the real header, never a copy of it.
const conf = readFileSync(resolve(repo, 'infra/nginx/textstack.conf'), 'utf8')
const PROD_CSP = conf.match(/^ {4}add_header Content-Security-Policy "(default-src 'self';[^"]+)" always;$/m)?.[1]
if (!PROD_CSP) { console.error('prod CSP not found in infra/nginx/textstack.conf'); process.exit(2) }
/** The other server-level headers a location inherits unless it sets its own add_header. */
const PROD_FRAME_HEADERS = { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' }

/** `csp` with `sources` appended to `directive` (or the directive added). */
const widen = (csp, adds) => Object.entries(adds).reduce((p, [d, s]) => {
  const re = new RegExp(`(^|; )${d} ([^;]*)`)
  return re.test(p) ? p.replace(re, `$1${d} $2 ${s}`) : `${p}; ${d} ${s}`
}, csp)

// The minimal additions that make the srcdoc host work, found by running (b) and adding exactly what its
// violations named (see the report). `NONCE` becomes this response's nonce, which the host reads back.
const SRCDOC_ADDS = { 'script-src': "'nonce-NONCE'", 'style-src': 'blob:', 'font-src': 'blob:', 'connect-src': 'blob:', 'frame-src': 'blob:' }

/**
 * Variants: `mode` srcdoc (the dev host's shape) or src (the page as its own document at /reader-frame.html);
 * `host` the host document's CSP (null: none); `frame` the reader document's headers (src mode only).
 */
const VARIANTS = [
  { id: 'a', what: 'control: srcdoc, no CSP', mode: 'srcdoc', host: null },
  { id: 'b', what: 'srcdoc, exact prod CSP', mode: 'srcdoc', host: PROD_CSP },
  { id: 'c', what: 'srcdoc, prod CSP + minimal additions (per-response nonce)', mode: 'srcdoc', host: widen(PROD_CSP, SRCDOC_ADDS) },
  // Minimality: (c) less one addition each.
  ...Object.keys(SRCDOC_ADDS).map((d) => ({ id: `c-${d}`, what: `(c) without its ${d} addition`, mode: 'srcdoc',
    host: widen(PROD_CSP, Object.fromEntries(Object.entries(SRCDOC_ADDS).filter(([k]) => k !== d))) })),
  { id: 'd0', what: 'src=, exact prod CSP on host; frame doc with server-level headers', mode: 'src', host: PROD_CSP,
    frame: { 'Content-Security-Policy': PROD_CSP, ...PROD_FRAME_HEADERS } },
  { id: 'd1', what: "src=, host frame-src +'self'; frame doc with server-level headers", mode: 'src', host: widen(PROD_CSP, { 'frame-src': "'self'" }),
    frame: { 'Content-Security-Policy': PROD_CSP, ...PROD_FRAME_HEADERS } },
  { id: 'd', what: "src=, host frame-src +'self'; frame doc own header (frame-ancestors 'self')", mode: 'src', host: widen(PROD_CSP, { 'frame-src': "'self'" }),
    frame: { 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } },
]
/** What each variant measured (text rendered, book CSS applied, book font loaded = true); a change in Chromium or the config shows as a FAIL. */
const EXPECT = { a: true, b: false, c: true, d0: false, d1: false, d: true,
  ...Object.fromEntries(Object.keys(SRCDOC_ADDS).map((d) => [`c-${d}`, false])) }

/** The dev host's shim (V2ReaderDevPage.tsx hostShim), parent origin pinned. */
const hostShim = (origin) => `
window.ReactNativeWebView = { postMessage: (json) => parent.postMessage(json, ${JSON.stringify(origin)}) };
let bookUrl = null;
addEventListener('message', (e) => {
  if (e.source !== parent || !Array.isArray(e.data?.args)) return;
  const { call, args } = e.data;
  if (call !== 'openBytes') return Object.hasOwn(window.__fol, call) && window.__fol[call](...args);
  if (bookUrl) URL.revokeObjectURL(bookUrl);
  bookUrl = URL.createObjectURL(new Blob([args[0]]));
  window.__fol.openUrl(bookUrl, args[1]);
});`
const withShim = (html, nonce, origin) => html.replace('<body>', `<body><script nonce="${nonce}">${hostShim(origin)}</script>`)

// The host's script, an external 'self' file as the app bundle is. srcdoc: the page template with a
// nonce (the response's, when the header carries one; else a fresh one, as the dev host makes) and
// the shim; src: the server made the document. Then: on `ready`, transfer the EPUB's bytes.
const HOST_JS = `
const v = new URLSearchParams(location.search).get('v');
const mode = new URLSearchParams(location.search).get('mode');
window.__msgs = [];
const f = document.createElement('iframe');
f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
f.style.cssText = 'width:800px;height:600px';
addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow || typeof e.data !== 'string') return;
  const m = JSON.parse(e.data);
  window.__msgs.push(m.type);
  if (m.type === 'ready') window.__open('/book.epub', 'v2-sync.epub');
});
window.__open = async (path, name) => {
  const bytes = await (await fetch(path)).arrayBuffer();
  f.contentWindow.postMessage({ call: 'openBytes', args: [bytes, name] }, location.origin, [bytes]);
};
if (mode === 'src') f.src = '/reader-frame.html?v=' + v;
else {
  const nonce = document.querySelector('meta[name=v2-nonce]')?.content || crypto.randomUUID().replaceAll('-', '');
  const html = await (await fetch('/page-template.html')).text();
  f.srcdoc = html.split('__V2_READER_NONCE__').join(nonce)
    .replace('<body>', '<body><script nonce="' + nonce + '">' + ${JSON.stringify('__SHIM__')} + '</script>');
}
document.body.append(f);`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const v = VARIANTS.find((x) => x.id === url.searchParams.get('v'))
  const origin = `http://127.0.0.1:${server.address().port}`
  if (url.pathname === '/host' && v) {
    const nonce = randomBytes(16).toString('hex') // nginx's $request_id: 16 random bytes, hex
    const headers = { 'Content-Type': 'text/html; charset=utf-8' }
    if (v.host) headers['Content-Security-Policy'] = v.host.replace('NONCE', nonce)
    res.writeHead(200, headers)
    const meta = v.host?.includes("'nonce-NONCE'") ? `<meta name="v2-nonce" content="${nonce}">` : ''
    return res.end(`<!doctype html><html><head>${meta}</head><body><script type="module" src="/host.js?v=${v.id}&mode=${v.mode}"></script></body></html>`)
  }
  if (url.pathname === '/host.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' })
    return res.end(HOST_JS.replace(JSON.stringify('__SHIM__'), JSON.stringify(hostShim(origin))))
  }
  if (url.pathname === '/page-template.html') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(v2ReaderPageHtml('A'.repeat(16)).split('A'.repeat(16)).join('__V2_READER_NONCE__'))
  }
  if (url.pathname === '/reader-frame.html' && v?.frame) {
    // A static file would get its nonce from nginx `sub_filter '__V2_READER_NONCE__' $request_id`: same thing.
    const nonce = randomBytes(16).toString('hex')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...v.frame })
    return res.end(withShim(v2ReaderPageHtml(nonce), nonce, origin))
  }
  if (url.pathname === '/book.epub' || url.pathname === '/fonts.epub') {
    res.writeHead(200, { 'Content-Type': 'application/epub+zip' })
    return res.end(url.pathname === '/book.epub' ? EPUB : FONTS_EPUB)
  }
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const until = async (fn) => {
  for (const t0 = Date.now(); Date.now() - t0 < STEP_MS; await new Promise((r) => setTimeout(r, 100))) if (await fn().catch(() => false)) return true
  return false
}

const browser = await chromium.launch()
const rows = []
try {
  for (const v of VARIANTS) {
    const page = await browser.newPage()
    const violations = new Set()
    const consoleCsp = new Set()
    page.on('console', (m) => { if (/Content Security Policy|Refused to|X-Frame-Options/i.test(m.text())) consoleCsp.add(m.text().slice(0, 240)) })
    await page.exposeBinding('__violation', ({ frame }, s) => violations.add(`${s} (in ${frame.url().split(/[?#]/)[0].replace(base, '') || frame.url().slice(0, 12)})`))
    // Runs in every frame, by CDP, past any CSP: records the violations of whichever frame sees them.
    await page.addInitScript(() => addEventListener('securitypolicyviolation', (e) =>
      window.__violation(`${e.effectiveDirective} ${e.blockedURI || '(inline)'}`)))
    await page.goto(`${base}/host?v=${v.id}&mode=${v.mode}`)
    const msgs = () => page.evaluate(() => window.__msgs ?? [])
    const reader = () => page.frames().find((f) => f.parentFrame() === page.mainFrame())
    const loads = await until(async () => (await reader()?.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'))) === true)
    const ready = await until(async () => (await msgs()).includes('ready'))
    const opened = ready && await until(async () => (await msgs()).includes('opened'))
    const sectionText = () => Promise.all(page.frames().filter((f) => f.url().startsWith('blob:'))
      .map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => ''))).then((t) => t.join('\n'))
    const renders = opened && await until(async () => (await sectionText()).includes(FIRST_SECTION_TEXT))
    // The second book: its linked stylesheet applies (span#plain in TSPlain) and its font loads.
    let styled = false, fonts = false
    if (renders) {
      await page.evaluate(() => window.__open('/fonts.epub', 'tsfonts.epub'))
      const fontState = () => Promise.all(page.frames().filter((f) => f.url().startsWith('blob:')).map((f) => f.evaluate(async () => {
        const el = document.getElementById('plain')
        if (!el) return null
        await document.fonts.ready
        return { styled: getComputedStyle(el).fontFamily.includes('TSPlain'),
          fonts: [...document.fonts].some((x) => x.family.replaceAll('"', '') === 'TSPlain' && x.status === 'loaded') }
      }).catch(() => null))).then((r) => r.find(Boolean))
      await until(async () => (await msgs()).filter((x) => x === 'opened').length === 2 && !!(await fontState()))
      await until(async () => (await fontState())?.fonts === true)
      ;({ styled = false, fonts = false } = (await fontState()) ?? {})
    }
    // Does the page's own nonce CSP still hold? An un-nonced script inserted into the reader document.
    const seen = [...violations]
    const seenConsole = [...consoleCsp]
    let unNoncedRuns = 'n/a'
    if (loads) {
      unNoncedRuns = await reader().evaluate(async () => {
        const s = document.createElement('script')
        s.textContent = 'window.__unnonced = 1'
        document.body.append(s)
        await new Promise((r) => setTimeout(r, 200))
        return window.__unnonced === 1
      }).catch((e) => `error: ${e.message}`)
    }
    const frameUrl = reader()?.url() ?? '(none)'
    rows.push({ ...v, loads, ready, opened, renders, styled, fonts, unNoncedRuns, frameUrl, violations: seen, probeViolations: [...violations].filter((x) => !seen.includes(x)), consoleCsp: seenConsole, msgs: await msgs().catch(() => []) })
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
}

let failed = false
for (const r of rows) {
  const works = r.renders && r.styled && r.fonts
  const ok = works === EXPECT[r.id]
  if (!ok) failed = true
  console.log(`\n[${ok ? 'ok' : 'FAIL'}] (${r.id}) ${r.what}`)
  console.log(`  loads=${r.loads} ready=${r.ready} opened=${r.opened} renders=${r.renders} bookCss=${r.styled} bookFont=${r.fonts} unNoncedScriptRuns=${r.unNoncedRuns} frame=${r.frameUrl.slice(0, 60)}`)
  console.log(`  page messages: ${r.msgs.join(',') || '(none)'}`)
  if (r.host) console.log(`  host CSP: ${r.host === PROD_CSP ? '(prod, verbatim)' : r.host}`)
  for (const x of r.violations) console.log(`  violation: ${x}`)
  for (const x of r.probeViolations) console.log(`  violation (un-nonced probe script): ${x}`)
  for (const x of r.consoleCsp) console.log(`  console: ${x}`)
}
if (rows.find((r) => r.id === 'a')?.renders !== true) console.log('\nCONTROL FAILED: the experiment says nothing')
process.exit(failed ? 1 : 0)
