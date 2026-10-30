// The hostile-book check (ADR-029 Decision 6): the real CSP must block every vector of fixtures.mjs
// `hostileVectors`, and each MUTATIONS directive, removed or widened, must be caught. What it proves and
// its blind spots: README.md, Sandbox.
//
//   node --experimental-strip-types sandbox.check.mjs                    real CSP, then every mutation
//   node --experimental-strip-types sandbox.check.mjs --mutate=<name>    one mutated run; exits 1
//   (pnpm -C apps/web check:v2-reader-sandbox; once: pnpm -C apps/web exec playwright install chromium)
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
// Any single page call. A hung step is reported as an escape, never as a pass.
const STEP_TIMEOUT_MS = 10000
// The whole check; past it, exit 1 with what the current run has seen so far.
const DEADLINE_MS = 180000
// Settle after the clicks: until nothing changes for QUIET_MS, but never less than the 1 s meta refresh
// timer needs, and never more than SETTLE_MAX_MS.
const SETTLE_MIN_MS = 1200
const SETTLE_MAX_MS = 5000
const QUIET_MS = 300

/** A vector's `stops` names one of these; its CSP with that directive removed or widened must be caught. */
const MUTATIONS = {
  'script-src': (c) => c.replace(/script-src 'nonce-[^']+'/, "script-src 'unsafe-inline'"),
  'script-src blob:': (c) => c.replace(/(script-src 'nonce-[^']+')/, '$1 blob:'),
  'base-uri': (c) => c.replace(/; base-uri 'none'/, ''),
  'default-src': (c) => c.replace(/default-src 'none'; /, ''),
  'img-src': (c) => c.replace(/img-src blob: data:/, '$& http: file:'),
  'style-src': (c) => c.replace(/style-src blob:/, '$& http: file:'),
  'frame-src': (c) => c.replace(/frame-src blob:/, '$& http: file:'),
  'font-src': (c) => c.replace(/font-src blob: data:/, '$& http:'),
  'media-src': (c) => c.replace(/media-src blob: data:/, '$& http:'),
}

/** One per `probe` vector, by its name: true in a frame = it got through. Run inside each frame. */
const PROBES = {
  'file-sibling-img': () => (document.getElementById('file-sibling-img')?.naturalWidth ?? 0) > 0,
  'file-sibling-css': () => { const el = document.getElementById('file-sibling-css'); return !!el && getComputedStyle(el).color === 'rgb(1, 2, 3)' },
  'file-sibling-iframe': () => location.protocol === 'file:' && !location.pathname.endsWith('/page.html'),
  // The book's own frame only: an iframe loaded from the server has it as its base too.
  'base-href': (evil) => !!document.getElementById('ts-hostile') && document.baseURI.startsWith(evil),
  // The attribute value, decoded and case-folded, whatever the source spelled.
  'meta-refresh': (evil, name) => [...document.querySelectorAll('meta[http-equiv]')]
    .some((m) => /refresh/i.test(m.getAttribute('http-equiv')) && m.getAttribute('content')?.endsWith(`/${name}`)),
}
PROBES['meta-refresh-entity'] = PROBES['meta-refresh']

// Files beside the retained EPUB, each with content its vector can be recognised by.
const SIBLINGS = {
  'secret.json': '{"secret":"ts-sibling-secret"}',
  'secret.css': '#file-sibling-css { color: rgb(1, 2, 3) }',
  // 1×1 PNG.
  'secret.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
}

// The run in progress: what the deadline prints, and where the server writes.
let vectors = []
let title = ''
let result = null

const vectorOf = (url) => new URL(url, 'http://evil').pathname.split('/')[1].replace(/\.\w+$/, '')

/** Every request it receives is a vector that escaped, named by its first path segment. Any free port. */
function startEvil() {
  const server = createServer((req, res) => { result?.escaped.add(vectorOf(req.url)); res.end() })
  return new Promise((ok, fail) => {
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }))
  })
}

// Before any page script, in every frame: the host bridge (top only) and a log of what the CSP blocked.
function hostShim() {
  if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) }
  window.__csp = []
  addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`), true)
}

/** One read-only evaluate per frame: the marks every vector shares, and every probe. */
const readFrame = (evil, probed) => `({
  url: location.href, pwned: window.__pwned ?? [], csp: window.__csp ?? [], isBook: !!document.getElementById('ts-hostile'),
  probes: [${probed.map((name) => `(${PROBES[name]})(${JSON.stringify(evil)}, ${JSON.stringify(name)}) && ${JSON.stringify(name)}`).join(', ')}].filter(Boolean),
})`

/** `promise`, or a rejection after STEP_TIMEOUT_MS: no page call can hang the check. */
function bounded(promise, what) {
  let timer
  const timeout = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} timed out after ${STEP_TIMEOUT_MS} ms`)), STEP_TIMEOUT_MS) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** A step whose failure (a timeout, a frame gone mid-call) is itself an escape: recorded, never passed. */
async function step(what, call) {
  try {
    return await bounded(call(), what)
  } catch (e) {
    result.escaped.add(`${what}: ${e.message.split('\n')[0]}`)
    return undefined
  }
}

/** Opens the hostile book under its own CSP or `mutate(csp)`, in a fresh context (its own cache: no prefetch carries over). */
async function run(browser, evil, dir, mutate) {
  let html = v2ReaderPageHtml(randomBytes(18).toString('base64'))
  if (mutate) html = html.replace(/(Content-Security-Policy" content=")([^"]*)/, (_, a, csp) => a + mutate(csp))
  writeFileSync(resolve(dir, 'page.html'), html)
  result = { escaped: new Set(), blocked: new Set(), errors: new Set() }
  const context = await browser.newContext()
  try {
    await openHostile(await context.newPage(), evil.url, dir)
  } catch (e) {
    result.errors.add(`run: ${e.message.split('\n')[0]}`)
  } finally {
    await context.close()
  }
}

async function openHostile(page, evil, dir) {
  const { escaped, blocked, errors } = result
  const messages = []
  page.on('pageerror', (e) => errors.add(`pageerror: ${e.message}`))
  await page.exposeFunction('__toHost', (json) => {
    const m = JSON.parse(json)
    messages.push(m)
    if (m.type === 'log' && m.level === 'error') errors.add(`page log: ${m.msg}`)
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

  const probed = vectors.filter(([, observe]) => observe === 'probe').map(([name]) => name)
  /** Reads every frame into the run; true if one still shows the book. */
  const readFrames = async (i) => {
    let showsBook = false
    for (const f of page.frames()) {
      const state = await step(`section ${i} probe`, () => f.evaluate(readFrame(evil, probed)))
      if (!state) continue
      showsBook ||= state.isBook
      state.pwned.forEach((v) => escaped.add(v))
      state.probes.forEach((v) => escaped.add(v))
      state.csp.forEach((v) => blocked.add(v))
      // A frame that navigated to the server (meta refresh, an iframe) is named by its path, like a request.
      if (state.url.startsWith(evil)) escaped.add(vectorOf(state.url))
    }
    return showsBook
  }
  // A section's frame is replaced on navigation, so each one is probed while it is shown: once as it
  // lands (a refresh meta is still there before its timer fires) and once after the clicks settle.
  for (let i = 0; i < opened.sections; i++) {
    await bounded(page.evaluate((n) => window.__fol.goTo(n), i), `going to section ${i}`)
    await waitFor((m) => m.type === 'relocate' && m.index === i, `section ${i}`)
    await readFrames(i)
    for (const f of page.frames()) await step(`section ${i} clicks`, () => f.$$eval('[data-ts-click]', (els) => els.forEach((el) => el.click())))
    await settle(page, i)
    if (!(await readFrames(i))) escaped.add(`section ${i} no longer shows the book`)
  }
  // openLink goes to the OS opener: a scheme the book chose is a vector that got through (#1066).
  for (const m of messages) if (m.type === 'openLink' && !/^https?:/.test(m.href)) escaped.add(m.href.startsWith('javascript:') ? 'javascript-url' : `openLink ${m.href.slice(0, 40)}`)
  // The clicks must have reached the book, or the click vectors were never tried.
  if (!messages.some((m) => m.type === 'openLink' && m.href === `${evil}/link-tap`)) errors.add('no openLink for link-tap: the clicks did not reach the book')
}

/** Waits until requests, frames, marks and CSP reports stop changing (see SETTLE_*). */
async function settle(page, i) {
  const snapshot = async () => {
    const frames = await Promise.all(page.frames().map((f) => step(`section ${i} settle`, () =>
      f.evaluate(() => [location.href, (window.__pwned ?? []).length, (window.__csp ?? []).length]))))
    return JSON.stringify([result.escaped.size, frames])
  }
  const t0 = Date.now()
  let last = await snapshot()
  let since = Date.now()
  while (Date.now() - t0 < SETTLE_MAX_MS) {
    await page.waitForTimeout(100)
    const now = await snapshot()
    if (now !== last) [last, since] = [now, Date.now()]
    else if (Date.now() - since >= QUIET_MS && Date.now() - t0 >= SETTLE_MIN_MS) return
  }
}

const passes = ({ escaped, errors }) => escaped.size === 0 && errors.size === 0

/** One row per vector (or only the escaped ones); anything escaped that is not a vector gets its own row. */
function report(all) {
  const { escaped, blocked, errors } = result
  console.log(`\n[check:v2-reader-sandbox] ${title}`)
  const rows = new Map(vectors.map(([name, observe, stops]) => [name, `${observe}${stops ? `, stops ${stops}` : ', blind spot'}`]))
  for (const v of new Set([...rows.keys(), ...escaped])) {
    if (!all && !escaped.has(v)) continue
    const how = rows.get(v) ?? '-'
    console.log(`  ${escaped.has(v) ? 'ESCAPED' : 'blocked'}  ${v.padEnd(20)} ${how.startsWith('sandbox') && !escaped.has(v) ? 'by the iframe sandbox, not by the CSP' : how}`)
  }
  for (const e of errors) console.log(`  ERROR    ${e}`)
  if (all && !passes(result)) console.log(`  CSP blocked (evidence): ${[...blocked].join(' | ') || 'nothing reported'}`)
}

/** Every row observable by this file and pointing at a real mutation; every mutation stopping something. */
function misdeclared(rows) {
  const bad = rows.filter(([name, observe, stops]) =>
    !['mark', 'request', 'sandbox', 'probe'].includes(observe) || (observe === 'probe' && !PROBES[name]) || (stops && !MUTATIONS[stops]))
    .map(([name, observe, stops]) => `${name} (${observe}, ${stops})`)
  const idle = Object.keys(MUTATIONS).filter((d) => !rows.some(([, , stops]) => stops === d)).map((d) => `mutation ${d} stops nothing`)
  return [...bad, ...idle]
}

const only = process.argv.find((a) => a.startsWith('--mutate='))?.slice('--mutate='.length)
if (only !== undefined && !MUTATIONS[only]) {
  console.error(`unknown mutation "${only}"; one of: ${Object.keys(MUTATIONS).join(', ')}`)
  process.exit(2)
}
const problems = misdeclared(hostileVectors('http://evil', 'file:///'))
if (problems.length) {
  console.error(`[check:v2-reader-sandbox] fixtures.mjs and this file disagree: ${problems.join('; ')}`)
  process.exit(2)
}

let dir = null
const deadline = setTimeout(() => {
  if (result) {
    result.errors.add(`deadline: the whole check ran over ${DEADLINE_MS} ms`)
    title += ' (partial)'
    report(true)
  }
  console.log('\n[check:v2-reader-sandbox] FAILED (deadline)')
  if (dir) rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}, DEADLINE_MS)

let failed = false
let evil = null
let browser = null
try {
  dir = mkdtempSync(resolve(tmpdir(), 'ts-v2-sandbox-'))
  evil = await startEvil()
  browser = await chromium.launch({ args: ['--allow-file-access-from-files'] })
  for (const [name, data] of Object.entries(SIBLINGS)) writeFileSync(resolve(dir, name), data)
  const siblings = pathToFileURL(dir).href
  writeHostileEpub(resolve(dir, 'tshostile.epub'), siblings, evil.url)
  vectors = hostileVectors(evil.url, siblings)

  for (const directive of only ? [only] : [null, ...Object.keys(MUTATIONS)]) {
    const escapes = vectors.filter(([, , stops]) => stops === directive).map(([name]) => name)
    title = directive ? `mutation ${directive}: must catch ${escapes.join(', ')}` : 'real CSP: every vector must be blocked'
    await run(browser, evil, dir, directive && MUTATIONS[directive])
    if (!directive || only) {
      report(true)
      failed ||= !passes(result)
    } else {
      report(false)
      const missed = escapes.filter((v) => !result.escaped.has(v))
      console.log(`  → ${missed.length ? `NOT CAUGHT: ${missed.join(', ')} — the check cannot see this directive go` : 'caught: the check fails, as it must'}`)
      failed ||= missed.length > 0
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
