// The hostile-book check (ADR-029 Decision 6, plan R3): opens tshostile.epub in the committed reader page
// the way the dev route does — a file:// page with file access — and fails if any vector gets through.
// A check that cannot fail is worth nothing, so it also proves it can: each MUTATIONS row removes or
// widens one CSP directive, and the check must then catch the vector that directive stops.
//
//   node sandbox.check.mjs                     real CSP must hold, then every mutation must be caught
//   node sandbox.check.mjs --mutate=<name>     one mutated run; exits 1 because something escapes
//   (pnpm -C apps/web check:v2-reader-sandbox; needs Playwright Chromium: pnpm -C apps/web exec playwright install chromium)
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EVIL, hostileVectors, writeHostileEpub } from './fixtures.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

const here = dirname(fileURLToPath(import.meta.url))
// apps/web's Playwright, as build.mjs takes apps/web's esbuild: no new dependency.
const { chromium } = createRequire(resolve(here, '../../../../web/package.json'))('@playwright/test')

const OPEN_TIMEOUT_MS = 15000
// Long enough for the vectors that fire late: the 1 s meta refresh, autoplay, onload, a click's navigation.
const SETTLE_MS = 2500

/**
 * One directive removed or widened → a vector that directive alone was stopping. The check must then
 * fail on it. (object/embed stay blocked even without default-src: the sandboxed section frame loads no
 * plugin content, so no CSP mutation can show them escaping.)
 */
const MUTATIONS = {
  'script-src-unsafe-inline': { csp: (c) => c.replace(/script-src 'nonce-[^']+'/, "script-src 'unsafe-inline'"), escapes: ['inline-script', 'body-onload', 'img-onerror', 'svg-inline-script', 'srcdoc-script', 'file-sibling-xhr'] },
  'script-src-blob': { csp: (c) => c.replace(/(script-src 'nonce-[^']+')/, '$1 blob:'), escapes: ['script-src-in-zip'] },
  'no-base-uri': { csp: (c) => c.replace(/; base-uri 'none'/, ''), escapes: ['base-href'] },
  'no-default-src': { csp: (c) => c.replace(/default-src 'none'; /, ''), escapes: ['link-prefetch'] },
  'img-src-http-file': { csp: (c) => c.replace(/img-src blob: data:/, '$& http: file:'), escapes: ['img', 'img-srcset', 'svg-image', 'css-background', 'video-poster', 'file-sibling-img'] },
  'style-src-http-file': { csp: (c) => c.replace(/style-src blob:/, '$& http: file:'), escapes: ['link-stylesheet', 'css-import', 'file-sibling-css'] },
  'frame-src-http-file': { csp: (c) => c.replace(/frame-src blob:/, '$& http: file:'), escapes: ['iframe', 'file-sibling-iframe'] },
}

// Files beside the retained EPUB, each with content its vector can be recognised by.
const SIBLINGS = {
  'secret.json': '{"secret":"ts-sibling-secret"}',
  'secret.css': '#file-sibling-css { color: rgb(1, 2, 3) }',
  // 1×1 PNG.
  'secret.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
}

/** Every request EVIL receives is a vector that escaped; the first path segment names it. */
function startEvil() {
  const hits = []
  const server = createServer((req, res) => { hits.push(req.url); res.end() })
  return new Promise((ok, fail) => {
    server.on('error', fail)
    server.listen(new URL(EVIL).port, '127.0.0.1', () => ok({ hits, close: () => server.close() }))
  })
}

// Before any page script, in every frame: the host bridge (top only) and a log of what the CSP blocked.
function hostShim() {
  if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) }
  window.__csp = []
  addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`), true)
}

// Runs in each frame: what a vector that got through would have left there.
function probe() {
  const img = document.getElementById('file-sibling-img')
  const css = document.getElementById('file-sibling-css')
  return {
    url: location.href,
    baseURI: document.baseURI,
    pwned: window.__pwned ?? [],
    csp: window.__csp ?? [],
    isBook: !!document.getElementById('ts-hostile'),
    siblingImg: !!img && img.naturalWidth > 0,
    siblingCss: !!css && getComputedStyle(css).color === 'rgb(1, 2, 3)',
  }
}

const vectorOf = (url) => new URL(url, EVIL).pathname.split('/')[1].replace(/\.\w+$/, '')

/**
 * Opens the hostile book in the page under its own CSP, or `mutate(csp)`. A browser per run: a prefetch
 * the last run allowed must not land in this run's log.
 */
async function run(evil, dir, mutate) {
  let html = v2ReaderPageHtml(randomBytes(18).toString('base64'))
  if (mutate) html = html.replace(/(Content-Security-Policy" content=")([^"]*)/, (_, a, csp) => a + mutate(csp))
  writeFileSync(resolve(dir, 'page.html'), html)
  evil.hits.length = 0
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] })
  try {
    return await openHostile(await browser.newPage(), evil, dir)
  } finally {
    await browser.close()
  }
}

/** Returns the escaped vector names, what the CSP reported blocking, and the page's errors. */
async function openHostile(page, evil, dir) {
  const messages = []
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.exposeFunction('__toHost', (json) => {
    const m = JSON.parse(json)
    messages.push(m)
    if (m.type === 'log' && m.level === 'error') errors.push(`page log: ${m.msg}`)
  })
  await page.addInitScript(hostShim)
  await page.goto(pathToFileURL(resolve(dir, 'page.html')).href)

  const waitFor = async (match, what) => {
    for (const t0 = Date.now(); Date.now() - t0 < OPEN_TIMEOUT_MS; await page.waitForTimeout(50)) {
      const m = messages.find(match)
      if (m) return m
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  await waitFor((m) => m.type === 'ready', 'ready')
  await page.evaluate((url) => window.__fol.openUrl(url, 'tshostile.epub'), pathToFileURL(resolve(dir, 'tshostile.epub')).href)
  const opened = await waitFor((m) => m.type === 'opened' || m.type === 'open-failed', 'opened')
  if (opened.type === 'open-failed') throw new Error(`open-failed: ${opened.error}`)

  // A section's frame is replaced on navigation, so each one is probed while it is shown.
  const escaped = new Set()
  const blocked = new Set()
  for (let i = 0; i < opened.sections; i++) {
    await page.evaluate((n) => window.__fol.goTo(n), i)
    await waitFor((m) => m.type === 'relocate' && m.index === i, `section ${i}`)
    for (const f of page.frames()) for (const a of await f.$$('[data-ts-click]')) await a.evaluate((el) => el.click())
    await page.waitForTimeout(SETTLE_MS)
    const probes = await Promise.all(page.frames().map((f) => f.evaluate(probe)))
    if (!probes.some((p) => p.isBook)) escaped.add(`section ${i} no longer shows the book`)
    for (const p of probes) {
      p.pwned.forEach((v) => escaped.add(v))
      p.csp.forEach((v) => blocked.add(v))
      if (p.url.startsWith(EVIL) || p.baseURI.startsWith(EVIL)) escaped.add(vectorOf(p.url.startsWith(EVIL) ? p.url : p.baseURI))
      if (p.url.startsWith(pathToFileURL(dir).href) && !p.url.endsWith('/page.html')) escaped.add('file-sibling-iframe')
      if (p.siblingImg) escaped.add('file-sibling-img')
      if (p.siblingCss) escaped.add('file-sibling-css')
    }
  }
  evil.hits.forEach((u) => escaped.add(vectorOf(u)))
  // openLink goes to the OS opener: a scheme the book chose is a vector that got through (#1066).
  for (const m of messages) if (m.type === 'openLink' && !/^https?:/.test(m.href)) escaped.add(m.href.startsWith('javascript:') ? 'javascript-url' : `openLink ${m.href.slice(0, 40)}`)
  // The clicks must have reached the book, or the click vectors were never tried.
  if (!messages.some((m) => m.type === 'openLink' && m.href === `${EVIL}/link-tap`)) errors.push('no openLink for link-tap: the clicks did not reach the book')
  return { escaped, blocked, errors }
}

const passes = ({ escaped, errors }) => escaped.size === 0 && errors.length === 0

/** One row per vector (or only the escaped ones); anything escaped that is not a known vector gets its own row. */
function report(title, names, { escaped, blocked, errors }, all = true) {
  console.log(`\n[check:v2-reader-sandbox] ${title}`)
  for (const v of new Set([...names, ...escaped])) if (all || escaped.has(v)) console.log(`  ${escaped.has(v) ? 'ESCAPED' : 'blocked'}  ${v}`)
  for (const e of errors) console.log(`  ERROR    ${e}`)
  if (all && !passes({ escaped, errors })) console.log(`  CSP blocked (evidence): ${[...blocked].join(' | ') || 'nothing reported'}`)
}

const only = process.argv.find((a) => a.startsWith('--mutate='))?.slice('--mutate='.length)
if (only !== undefined && !MUTATIONS[only]) {
  console.error(`unknown mutation "${only}"; one of: ${Object.keys(MUTATIONS).join(', ')}`)
  process.exit(2)
}

const dir = mkdtempSync(resolve(tmpdir(), 'ts-v2-sandbox-'))
const evil = await startEvil()
let failed = false
try {
  for (const [name, data] of Object.entries(SIBLINGS)) writeFileSync(resolve(dir, name), data)
  const siblings = pathToFileURL(dir).href
  writeHostileEpub(resolve(dir, 'tshostile.epub'), siblings)
  const names = hostileVectors(EVIL, siblings).map(([n]) => n)

  if (only) {
    const result = await run(evil, dir, MUTATIONS[only].csp)
    report(`mutation ${only}`, names, result)
    failed = !passes(result)
  } else {
    const real = await run(evil, dir)
    report('real CSP: every vector must be blocked', names, real)
    failed = !passes(real)
    for (const [name, m] of Object.entries(MUTATIONS)) {
      const result = await run(evil, dir, m.csp)
      const missed = m.escapes.filter((v) => !result.escaped.has(v))
      report(`mutation ${name}: must catch ${m.escapes.join(', ')}`, names, result, false)
      console.log(`  → ${missed.length ? `NOT CAUGHT: ${missed.join(', ')} — the check cannot see this directive go` : 'caught: the check fails, as it must'}`)
      if (missed.length) failed = true
    }
  }
} finally {
  evil.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n[check:v2-reader-sandbox] ${failed ? 'FAILED' : 'ok'}`)
process.exit(failed ? 1 : 0)
