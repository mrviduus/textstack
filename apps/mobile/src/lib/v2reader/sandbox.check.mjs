// The hostile-book check (ADR-029 Decision 6, plan R3): opens tshostile.epub in the committed reader page
// the way the dev route does — a file:// page with file access — and fails if any vector gets through.
// A check that cannot fail is worth nothing, so it also proves it can: each MUTATIONS row removes or
// widens one CSP directive, and the check must then catch the vectors that directive stops.
//
// What it proves: the CSP, in desktop headless Chromium, with the page opened by page.goto(file://…) and
// --allow-file-access-from-files. Not the Android System WebView (loadDataWithBaseURL, Android's
// file-access flags, content:/intent: URLs): R4 (#1036) runs it on the device.
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
import { hostileVectors, writeHostileEpub } from './fixtures.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

const here = dirname(fileURLToPath(import.meta.url))
// apps/web's Playwright, as build.mjs takes apps/web's esbuild: no new dependency.
const { chromium } = createRequire(resolve(here, '../../../../web/package.json'))('@playwright/test')

const OPEN_TIMEOUT_MS = 15000
// Any single evaluate, click or probe. A hung step is reported as an escape, never as a pass.
const STEP_TIMEOUT_MS = 10000
// The whole check (8 runs take ~40 s); past it, exit 1 with what the current run has seen so far.
const DEADLINE_MS = 180000
// Long enough for the vectors that fire late: the 1 s meta refresh, autoplay, onload, a click's navigation.
const SETTLE_MS = 2500

/**
 * One directive removed or widened → the vectors that directive alone was stopping. The check must then
 * fail on them. object/embed are not here: in Chromium they reach the server only with both
 * default-src (object-src) and frame-src opened, so no single-directive mutation shows them.
 */
const MUTATIONS = {
  'script-src-unsafe-inline': { csp: (c) => c.replace(/script-src 'nonce-[^']+'/, "script-src 'unsafe-inline'"), escapes: ['inline-script', 'body-onload', 'img-onerror', 'svg-inline-script', 'srcdoc-script', 'file-sibling-xhr'] },
  'script-src-blob': { csp: (c) => c.replace(/(script-src 'nonce-[^']+')/, '$1 blob:'), escapes: ['script-src-in-zip'] },
  'no-base-uri': { csp: (c) => c.replace(/; base-uri 'none'/, ''), escapes: ['base-href'] },
  'no-default-src': { csp: (c) => c.replace(/default-src 'none'; /, ''), escapes: ['link-prefetch'] },
  'img-src-http-file': { csp: (c) => c.replace(/img-src blob: data:/, '$& http: file:'), escapes: ['img', 'img-srcset', 'svg-image', 'css-background', 'video-poster', 'file-sibling-img'] },
  'style-src-http-file': { csp: (c) => c.replace(/style-src blob:/, '$& http: file:'), escapes: ['link-stylesheet', 'css-import', 'file-sibling-css'] },
  'frame-src-http-file': { csp: (c) => c.replace(/frame-src blob:/, '$& http: file:'), escapes: ['iframe', 'file-sibling-iframe'] },
  'font-src-http': { csp: (c) => c.replace(/font-src blob: data:/, '$& http:'), escapes: ['css-font'] },
  'media-src-http': { csp: (c) => c.replace(/media-src blob: data:/, '$& http:'), escapes: ['audio'] },
}

/** The `probe:<id>` observers of fixtures.mjs: run in every frame, true = the vector got through. */
const PROBES = {
  'file-sibling-img': () => (document.getElementById('file-sibling-img')?.naturalWidth ?? 0) > 0,
  'file-sibling-css': () => { const el = document.getElementById('file-sibling-css'); return !!el && getComputedStyle(el).color === 'rgb(1, 2, 3)' },
  'file-frame': () => location.protocol === 'file:' && !location.pathname.endsWith('/page.html'),
  // The book's own frame only: an iframe that did load from the logging server has that as its base too.
  'base-href': (evil) => !!document.getElementById('ts-hostile') && document.baseURI.startsWith(evil),
}
// 'mark' and 'request' are read for every vector at once (__pwned, the logging server); 'sandbox' rows only print as such.
const OBSERVERS = new Set(['mark', 'request', 'sandbox'])

// Files beside the retained EPUB, each with content its vector can be recognised by.
const SIBLINGS = {
  'secret.json': '{"secret":"ts-sibling-secret"}',
  'secret.css': '#file-sibling-css { color: rgb(1, 2, 3) }',
  // 1×1 PNG.
  'secret.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
}

/**
 * Every request this server receives is a vector that escaped; the first path segment names it. Any free
 * port: the book is written against `url`, so nothing else on 9876 (the on-device default) is in the way.
 */
function startEvil() {
  const hits = []
  const server = createServer((req, res) => { hits.push(req.url); res.end() })
  return new Promise((ok, fail) => {
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() }))
  })
}

// Before any page script, in every frame: the host bridge (top only) and a log of what the CSP blocked.
function hostShim() {
  if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) }
  window.__csp = []
  addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`), true)
}

// Runs in each frame: the marks every vector shares.
function frameState() {
  return { url: location.href, pwned: window.__pwned ?? [], csp: window.__csp ?? [], isBook: !!document.getElementById('ts-hostile') }
}

const vectorOf = (url) => new URL(url, 'http://evil').pathname.split('/')[1].replace(/\.\w+$/, '')

/** `promise`, or a rejection after STEP_TIMEOUT_MS: no page call can hang the check. */
function bounded(promise, what) {
  let timer
  const timeout = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} timed out after ${STEP_TIMEOUT_MS} ms`)), STEP_TIMEOUT_MS) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** A step whose failure (a timeout, a frame gone mid-call) is itself an escape: recorded, never passed. */
async function step(result, what, call) {
  try {
    return await bounded(call(), what)
  } catch (e) {
    result.escaped.add(`${what}: ${e.message.split('\n')[0]}`)
    return undefined
  }
}

/** What the run in progress has seen, for the deadline to print. */
let current = null

/**
 * Opens the hostile book in the page under its own CSP, or `mutate(csp)`. A context per run, with its own
 * cache: a prefetch the last run allowed must not land in this run's log.
 */
async function run(browser, title, evil, dir, vectors, mutate) {
  let html = v2ReaderPageHtml(randomBytes(18).toString('base64'))
  if (mutate) html = html.replace(/(Content-Security-Policy" content=")([^"]*)/, (_, a, csp) => a + mutate(csp))
  writeFileSync(resolve(dir, 'page.html'), html)
  evil.hits.length = 0
  const result = { escaped: new Set(), blocked: new Set(), errors: [] }
  current = { title, result, evil }
  const context = await browser.newContext()
  try {
    await openHostile(await context.newPage(), result, evil.url, dir, vectors)
  } catch (e) {
    result.errors.push(`run: ${e.message.split('\n')[0]}`)
  } finally {
    // Read once more, last: a late request still counts.
    evil.hits.forEach((u) => result.escaped.add(vectorOf(u)))
    await context.close()
  }
  return result
}

async function openHostile(page, result, evil, dir, vectors) {
  const { escaped, blocked, errors } = result
  const messages = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.exposeFunction('__toHost', (json) => {
    const m = JSON.parse(json)
    messages.push(m)
    if (m.type === 'log' && m.level === 'error') errors.push(`page log: ${m.msg}`)
  })
  await page.addInitScript(hostShim)
  await bounded(page.goto(pathToFileURL(resolve(dir, 'page.html')).href), 'loading the page')

  const waitFor = async (match, what) => {
    for (const t0 = Date.now(); Date.now() - t0 < OPEN_TIMEOUT_MS; await page.waitForTimeout(50)) {
      const m = messages.find(match)
      if (m) return m
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  await waitFor((m) => m.type === 'ready', 'ready')
  await bounded(page.evaluate((url) => window.__fol.openUrl(url, 'tshostile.epub'), pathToFileURL(resolve(dir, 'tshostile.epub')).href), 'openUrl')
  const opened = await waitFor((m) => m.type === 'opened' || m.type === 'open-failed', 'opened')
  if (opened.type === 'open-failed') throw new Error(`open-failed: ${opened.error}`)

  const probes = vectors.filter(([, observe]) => observe.startsWith('probe:'))
  // A section's frame is replaced on navigation, so each one is probed while it is shown.
  for (let i = 0; i < opened.sections; i++) {
    await bounded(page.evaluate((n) => window.__fol.goTo(n), i), `going to section ${i}`)
    await waitFor((m) => m.type === 'relocate' && m.index === i, `section ${i}`)
    for (const f of page.frames()) {
      const clickable = (await step(result, `section ${i} click targets`, () => f.$$('[data-ts-click]'))) ?? []
      for (const el of clickable) {
        const name = await step(result, `section ${i} click target name`, () => el.getAttribute('data-ts-click'))
        await step(result, `${name} click`, () => el.evaluate((e) => e.click()))
      }
    }
    await page.waitForTimeout(SETTLE_MS)
    let showsBook = false
    for (const f of page.frames()) {
      const state = await step(result, `section ${i} probe`, () => f.evaluate(frameState))
      if (!state) continue
      showsBook ||= state.isBook
      state.pwned.forEach((v) => escaped.add(v))
      state.csp.forEach((v) => blocked.add(v))
      // A frame that navigated to the logging server (meta refresh, an iframe) is named by its path, like a request.
      if (state.url.startsWith(evil)) escaped.add(vectorOf(state.url))
      for (const [name, observe] of probes) {
        if (await step(result, `${name} probe`, () => f.evaluate(PROBES[observe.slice('probe:'.length)], evil))) escaped.add(name)
      }
    }
    if (!showsBook) escaped.add(`section ${i} no longer shows the book`)
  }
  // openLink goes to the OS opener: a scheme the book chose is a vector that got through (#1066).
  for (const m of messages) if (m.type === 'openLink' && !/^https?:/.test(m.href)) escaped.add(m.href.startsWith('javascript:') ? 'javascript-url' : `openLink ${m.href.slice(0, 40)}`)
  // The clicks must have reached the book, or the click vectors were never tried.
  if (!messages.some((m) => m.type === 'openLink' && m.href === `${evil}/link-tap`)) errors.push('no openLink for link-tap: the clicks did not reach the book')
}

const passes = ({ escaped, errors }) => escaped.size === 0 && errors.length === 0

/** One row per vector (or only the escaped ones); anything escaped that is not a known vector gets its own row. */
function report(title, vectors, { escaped, blocked, errors }, all = true) {
  console.log(`\n[check:v2-reader-sandbox] ${title}`)
  const observeOf = new Map(vectors)
  for (const v of new Set([...observeOf.keys(), ...escaped])) {
    if (!all && !escaped.has(v)) continue
    const observe = observeOf.get(v) ?? '-'
    const status = escaped.has(v) ? 'ESCAPED' : 'blocked'
    console.log(`  ${status}  ${v.padEnd(20)} ${observe === 'sandbox' && !escaped.has(v) ? 'by the iframe sandbox, not by the CSP' : observe}`)
  }
  for (const e of errors) console.log(`  ERROR    ${e}`)
  if (all && !passes({ escaped, errors })) console.log(`  CSP blocked (evidence): ${[...blocked].join(' | ') || 'nothing reported'}`)
}

/** Every row must say how it is observed, by a kind or probe this file implements: else it would read "blocked" forever. */
function unobservable(vectors) {
  return vectors.filter(([, observe]) => !(OBSERVERS.has(observe) || (observe?.startsWith('probe:') && PROBES[observe.slice('probe:'.length)])))
}

const only = process.argv.find((a) => a.startsWith('--mutate='))?.slice('--mutate='.length)
if (only !== undefined && !MUTATIONS[only]) {
  console.error(`unknown mutation "${only}"; one of: ${Object.keys(MUTATIONS).join(', ')}`)
  process.exit(2)
}
const blind = unobservable(hostileVectors('http://evil', 'file:///'))
if (blind.length) {
  console.error(`[check:v2-reader-sandbox] no observer for: ${blind.map(([n, o]) => `${n} (${o})`).join(', ')}. Add it to PROBES or fix the row in fixtures.mjs.`)
  process.exit(2)
}

let dir = null
let evil = null
let browser = null
const deadline = setTimeout(() => {
  if (current) {
    current.evil.hits.forEach((u) => current.result.escaped.add(vectorOf(u)))
    current.result.errors.push(`deadline: the whole check ran over ${DEADLINE_MS} ms`)
    report(`${current.title} (partial)`, hostileVectors('http://evil', 'file:///'), current.result)
  }
  console.log('\n[check:v2-reader-sandbox] FAILED (deadline)')
  if (dir) rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}, DEADLINE_MS)

let failed = false
try {
  dir = mkdtempSync(resolve(tmpdir(), 'ts-v2-sandbox-'))
  evil = await startEvil()
  browser = await chromium.launch({ args: ['--allow-file-access-from-files'] })
  for (const [name, data] of Object.entries(SIBLINGS)) writeFileSync(resolve(dir, name), data)
  const siblings = pathToFileURL(dir).href
  writeHostileEpub(resolve(dir, 'tshostile.epub'), siblings, evil.url)
  const vectors = hostileVectors(evil.url, siblings)

  if (only) {
    const result = await run(browser, `mutation ${only}`, evil, dir, vectors, MUTATIONS[only].csp)
    report(`mutation ${only}`, vectors, result)
    failed = !passes(result)
  } else {
    const real = await run(browser, 'real CSP', evil, dir, vectors)
    report('real CSP: every vector must be blocked', vectors, real)
    failed = !passes(real)
    for (const [name, m] of Object.entries(MUTATIONS)) {
      const result = await run(browser, `mutation ${name}`, evil, dir, vectors, m.csp)
      const missed = m.escapes.filter((v) => !result.escaped.has(v))
      report(`mutation ${name}: must catch ${m.escapes.join(', ')}`, vectors, result, false)
      console.log(`  → ${missed.length ? `NOT CAUGHT: ${missed.join(', ')} — the check cannot see this directive go` : 'caught: the check fails, as it must'}`)
      if (missed.length) failed = true
    }
  }
} finally {
  clearTimeout(deadline)
  await browser?.close()
  evil?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
}
console.log(`\n[check:v2-reader-sandbox] ${failed ? 'FAILED' : 'ok'}`)
process.exit(failed ? 1 : 0)
