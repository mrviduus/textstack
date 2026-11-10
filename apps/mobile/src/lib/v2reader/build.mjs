// Builds the V2 reader page (ADR-029): pinned foliate-js fork + page.mjs → one IIFE inlined into an
// HTML string under the book-sandbox CSP → v2ReaderPage.generated.ts (committed). The MOBI, FB2 and
// CBZ readers are IIFEs of their own, carried as strings and run only when a book of that format opens
// (README, Formats).
//
//   node build.mjs           write v2ReaderPage.generated.ts   (pnpm -C apps/web build:v2-reader)
//   node build.mjs --check   exit 1 if the committed file differs or the page outgrew its budget (CI)
//   node build.mjs --repro   also write .vendor/v2ReaderPage.repro.html: the page + repro.mjs (test only)
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NONCE, formatsJs, html } from './carrier.mjs'

// Pinned by SHA on our fork (ADR-032): upstream 78914aef (2026-05-01, no releases, unstable API)
// + our patches as real commits. MIT © John Factotum. A bump is a PR that re-runs every ADR-029
// Decision 6 check.
// V2_FOLIATE_REPO / V2_FOLIATE_SHA: experiments only (a local commit of the .vendor clone); the
// defaults are the pin. A SHA must be the full 40 characters.
const FOLIATE_REPO = process.env.V2_FOLIATE_REPO || 'https://github.com/mrviduus/foliate-js.git'
const FOLIATE_SHA = process.env.V2_FOLIATE_SHA || 'd73682a48a0779ca989f25074386784602437fbf'   // branch textstack-pin: 78914aef + 0001 paginator render-while-loading
if (!/^[0-9a-f]{40}$/.test(FOLIATE_SHA)) {
  console.error(`[v2-reader] V2_FOLIATE_SHA must be a full 40-character SHA, got ${FOLIATE_SHA}`)
  process.exit(1)
}
// Unminified characters of the bundled script: a tripwire at the committed size, not a ceiling. Any
// growth fails --check until the PR that grows the page raises it (ADR-029 Decision 3). Not
// reader-engine's 64 KB budget.
// +319 (M2.7a, #1112): notInSurrogatePair, so a quote or its context never carries a lone surrogate V2 refuses.
// +854 (#1078): v4 UUID ids from getRandomValues, quotes cut by code points, selectedText beside quote,
// highlights refused with no text or over SyncLimits.MaxSelectedText.
// +5602 (#1128): routing by content (formats.mjs), the format-reader runner, CBZ without text features
// and with a `page` position, MOBI6 refresh strip, flow() validation and the reader-flow telemetry.
// Excludes the carried format readers below (their strings sit ahead of this script).
// +3136 (#1128 review): sniff before teardown, KF8 refused / combo read as MOBI6, truncated MOBI, UTF-16
// FB2 re-encoded, FB2 entities refused, CBZ names/types/dedupe, flow() not a switch on a fixed layout.
// −418 (#1128 simplify): no UnsupportedBook class, one FB2 head decode, one image-extension list, slimmer
// telemetry session, CBZ aliasing in one loop.
// +1353 (#1187): a fraction-only position (transitional server locator) restored and gone to by
// fraction, with no save until the reader moves away from where it landed.
// +651 (#1187 QA): the hold kept through a re-layout (the renderer's relocate reason), a fresh navigation
// chain per open (a goTo in flight no longer wedges the next book); `quiet` dropped.
// +643 (#1187 round 2): one save rule (reason + previous CFI) for every relocate, a taken fraction offer
// saved as a CFI, arrival checked for every fraction navigation, fraction 0 = text start, calls bound to
// the view (viewSeq) instead of the open seq; the fraction predicate now comes from packages/shared.
// +773 (#1187 round 3): one host-move guard (restore + non-chosen goTo save and echo nothing), restore
// as one navigation slot, restore only for a view that answered `opened`, one position builder,
// fixed-layout arrival by spread.
// +1756 (#1128 S5, experimental): PDF routed to the pdf reader, `pdf-page` positions (page = section
// index + 1) saved and restored, the scheme-fits-file guard on restore, PDF highlight/translation refused,
// the lazy cMap reader.
const BUDGET = 251426
// The same tripwire per format reader (#1128): unminified characters of each one's own IIFE, carried
// as a string in the page and run only when a book of that format opens. EPUB is the page itself.
// mobi = mobi.js + vendor/fflate.js; fb2 = fb2.js; cbz = comic-book.js (zip.js is the page's own).
// pdf = fork pdf.js + pdf.js v5.5.207 (pdf.mjs + pdf.worker.mjs, run on the page's main thread) + its
// two layer stylesheets (#1128 S5, experimental; 1613594 if minified). pdfcmaps = pdf.js's 168 predefined
// cMaps as base64, run only when a PDF names one.
const FORMAT_BUDGET = { mobi: 51784, fb2: 11417, cbz: 2030, pdf: 3179382, pdfcmaps: 1559883 }

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, 'v2ReaderPage.generated.ts')
const vendor = resolve(here, '.vendor/foliate-js')
const git = (...args) => execFileSync('git', ['-C', vendor, ...args], { stdio: 'inherit' })

if (!existsSync(vendor)) execFileSync('git', ['clone', '-q', FOLIATE_REPO, vendor], { stdio: 'inherit' })
// Fetch by URL, not remote name: a .vendor/ cloned before the fork switch still has upstream as origin.
git('fetch', '-q', FOLIATE_REPO, FOLIATE_SHA)
// Local modifications (e.g. from the old build-time patching) are dropped BEFORE the checkout:
// a checkout onto a different SHA refuses to overwrite them.
git('checkout', '-q', '--', '.')
git('checkout', '-q', '--detach', FOLIATE_SHA)
// An untracked file could be bundled into the page. Deleting it would silently eat someone's experiment,
// so the build stops and names it instead (CI clones fresh and never meets one).
const untracked = execFileSync('git', ['-C', vendor, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean)
if (untracked.length) {
  console.error(`[v2-reader] untracked files in ${vendor}:\n  ${untracked.join('\n  ')}\nThey could end up in the page. Delete .vendor/ to rebuild from the pin.`)
  process.exit(1)
}
// esbuild is the one the mobile engine bundle already uses (apps/web): no new dependency. Resolved from
// apps/web and version-checked, because the root has another copy — building with it produces a
// different bundle from the committed one, which reads as drift and is not.
const webPackage = resolve(here, '../../../../web/package.json')
const { build, version } = createRequire(webPackage)('esbuild')
const wanted = JSON.parse(readFileSync(webPackage, 'utf8')).devDependencies.esbuild.replace(/^[^\d]*/, '')
const minor = (v) => v.split('.').slice(0, 2).join('.')
if (minor(version) !== minor(wanted)) {
  console.error(`[v2-reader] esbuild ${version} is loaded, but apps/web asks for ${wanted}. Run pnpm install.`)
  process.exit(1)
}

// view.js's makeBook lazily imports every format. The page never calls it (page.mjs routes a file
// itself), so its imports are stubbed out of the page: MOBI/FB2/CBZ come in as FORMATS below, and
// pdf.js (~1 MB), TTS and search not at all.
const stubFormats = {
  name: 'stub-formats',
  setup(b) {
    b.onResolve({ filter: /\/(pdf|mobi|fb2|comic-book|tts|search|vendor\/fflate)\.js$/ }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export {}', loader: 'js' }))
  },
}

// Each format reader: what page.mjs needs from the fork, registered on window.__tsFormats when run.
// Imports resolve against this directory (the stdin entry has no file of its own).
const FORMATS = {
  mobi: `import { MOBI } from './.vendor/foliate-js/mobi.js'
import { unzlibSync } from './.vendor/foliate-js/vendor/fflate.js'
window.__tsFormats.mobi = { MOBI, unzlibSync }`,
  fb2: `import { makeFB2 } from './.vendor/foliate-js/fb2.js'
window.__tsFormats.fb2 = { makeFB2 }`,
  cbz: `import { makeComicBook } from './.vendor/foliate-js/comic-book.js'
window.__tsFormats.cbz = { makeComicBook }`,
  // The worker first: it sets globalThis.pdfjsWorker, so pdf.js runs it on the main thread ("fake
  // worker") and never asks for a Worker (no worker-src, no blob: script in the CSP).
  pdf: `import './.vendor/foliate-js/vendor/pdfjs/pdf.worker.mjs'
import { makePDF } from './.vendor/foliate-js/pdf.js'
import text from './.vendor/foliate-js/vendor/pdfjs/text_layer_builder.css'
import annotation from './.vendor/foliate-js/vendor/pdfjs/annotation_layer_builder.css'
window.__tsFormats.pdf = { makePDF, css: text + '\\n' + annotation }`,
  // pdf.js's predefined cMaps (Adobe, BSD-3-Clause), base64 by name: run only when a PDF's font names one
  // (CJK text) — nothing outside the file is fetched, so they ride in the page like a format reader.
  pdfcmaps: `/*! ${readFileSync(resolve(vendor, 'vendor/pdfjs/cmaps/LICENSE'), 'utf8').replace(/\*\//g, '* /')} */
window.__tsFormats.pdfcmaps = ${JSON.stringify(Object.fromEntries(readdirSync(resolve(vendor, 'vendor/pdfjs/cmaps')).filter((f) => f.endsWith('.bcmap')).sort()
    .map((f) => [f.slice(0, -'.bcmap'.length), readFileSync(resolve(vendor, 'vendor/pdfjs/cmaps', f)).toString('base64')])))}`,
}

const bundle = async (entry) => (await build({
  ...(entry.endsWith('.mjs') ? { entryPoints: [resolve(here, entry)] } : { stdin: { contents: entry, resolveDir: here, sourcefile: 'format.mjs' } }),
  // Fixed, because esbuild writes source paths into the bundle relative to it: the output must not
  // depend on where the script was run from.
  absWorkingDir: here,
  bundle: true,
  format: 'iife',
  // Not the engine's es2017: foliate uses static class blocks / private methods / \p{} regexes.
  // What this costs on old Android WebViews is an open ADR-029 gate.
  target: ['chrome90'],
  write: false,
  minify: false,
  legalComments: 'inline',
  // The page stubs the format modules out; a format reader is exactly one of them.
  plugins: entry.endsWith('.mjs') ? [stubFormats] : [],
  // The PDF reader carries pdf.js's layer stylesheets as strings.
  loader: { '.css': 'text' },
  // pdf.js references import.meta.url only on paths the page never takes (Node, wasm decoders).
  logLevel: 'error',
})).outputFiles[0].text

// The HTML shell, its CSP and nonce placeholder, and the format-reader carrier: carrier.mjs.

const js = await bundle('page.mjs')
const chunks = Object.fromEntries(await Promise.all(Object.entries(FORMATS).map(async ([k, src]) => [k, await bundle(src)])))
const page = formatsJs(chunks) + js
const sizes = Object.entries(chunks).map(([k, v]) => `${k} ${v.length}`).join(', ')
const content = `// AUTO-GENERATED — do not edit.
// Source: apps/mobile/src/lib/v2reader/page.mjs (+ store.mjs), built by build.mjs beside it.
// Regenerate: pnpm -C apps/web build:v2-reader
//
// foliate-js fork ${FOLIATE_SHA}${process.env.V2_FOLIATE_SHA ? ' (EXPERIMENTAL override, not the pin)' : ''} (mrviduus/foliate-js, branch textstack-pin:
// upstream 78914aef + our commits; MIT © John Factotum; bundled zip.js BSD-3-Clause).

/* eslint-disable */
/* prettier-ignore */
const PAGE_HTML = ${JSON.stringify(html(page))}

/** The page with \`nonce\` in its CSP and script tag. A fresh random nonce per load, base64 or hex, >= 16 chars. */
export function v2ReaderPageHtml(nonce: string): string {
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(nonce)) throw new Error('v2ReaderPageHtml: nonce must be base64 or hex, at least 16 chars')
  return PAGE_HTML.split(${JSON.stringify(NONCE)}).join(nonce)
}
`

if (process.argv.includes('--check')) {
  let failed = false
  if (js.length > BUDGET) {
    console.error(`[check:v2-reader] the page script is ${js.length} chars, over its ${BUDGET} budget (build.mjs BUDGET, ADR-029).`)
    failed = true
  }
  // A reader with no budget fails too: `undefined` would let any size through.
  for (const [k, v] of Object.entries(chunks)) if (!(v.length <= FORMAT_BUDGET[k])) {
    console.error(`[check:v2-reader] the ${k} reader is ${v.length} chars, over its ${FORMAT_BUDGET[k] ?? 'missing'} budget (build.mjs FORMAT_BUDGET).`)
    failed = true
  }
  if ((existsSync(out) ? readFileSync(out, 'utf8') : null) !== content) {
    console.error(`[check:v2-reader] ${out} is out of date. Run: pnpm -C apps/web build:v2-reader`)
    failed = true
  }
  if (failed) process.exit(1)
  console.log(`[check:v2-reader] ${out} is up to date (${js.length} chars; formats: ${sizes}).`)
} else {
  writeFileSync(out, content)
  console.log(`wrote ${out} (${js.length} chars script; formats: ${sizes}; foliate-js ${FOLIATE_SHA.slice(0, 8)})`)
}

if (process.argv.includes('--repro')) {
  const repro = resolve(here, '.vendor/v2ReaderPage.repro.html')
  writeFileSync(repro, html(formatsJs(chunks) + await bundle('repro.mjs')).split(NONCE).join(randomBytes(18).toString('base64')))
  console.log(`wrote ${repro} (test only)`)
}
