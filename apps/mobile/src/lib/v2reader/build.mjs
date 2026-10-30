// Builds the V2 reader page (ADR-029): pinned foliate-js + patches/ + page.mjs → one IIFE inlined into an
// HTML string under the book-sandbox CSP → v2ReaderPage.generated.ts (committed).
//
//   node build.mjs           write v2ReaderPage.generated.ts   (pnpm -C apps/web build:v2-reader)
//   node build.mjs --check   exit 1 if the committed file differs or the page outgrew its budget (CI)
//   node build.mjs --repro   also write .vendor/v2ReaderPage.repro.html: the page + repro.mjs (test only)
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Pinned by SHA: upstream has no releases and calls its API unstable. MIT © John Factotum.
// A bump is a PR that re-runs every ADR-029 Decision 6 check.
const FOLIATE_REPO = 'https://github.com/johnfactotum/foliate-js.git'
const FOLIATE_SHA = '78914aef4466eb960965702401634c2cb348e9b1'   // 2026-05-01
// Unminified characters of the bundled script, first committed size. Raised only by a deliberate PR
// (ADR-029 Decision 3); not reader-engine's 64 KB budget.
const BUDGET = 232847

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, 'v2ReaderPage.generated.ts')
const vendor = resolve(here, '.vendor/foliate-js')
const git = (...args) => execFileSync('git', ['-C', vendor, ...args], { stdio: 'inherit' })

if (!existsSync(vendor)) execFileSync('git', ['clone', '-q', FOLIATE_REPO, vendor], { stdio: 'inherit' })
git('fetch', '-q', 'origin', FOLIATE_SHA)
git('checkout', '-q', '--detach', FOLIATE_SHA)
// A clean tree, then every patch in order, on every build: a patch that no longer applies fails here.
git('checkout', '-q', '--', '.')
const patches = readdirSync(resolve(here, 'patches')).filter((f) => f.endsWith('.patch')).sort()
for (const p of patches) git('apply', '--whitespace=nowarn', resolve(here, 'patches', p))

// esbuild is the one the mobile engine bundle already uses (apps/web): no new dependency.
const { build } = createRequire(resolve(here, '../../../../web/package.json'))('esbuild')

// view.js's makeBook lazily imports every format; this page opens EPUB only, so the other formats
// (and pdf.js, ~1 MB), TTS and search are stubbed out instead of shipped.
const stubFormats = {
  name: 'stub-formats',
  setup(b) {
    b.onResolve({ filter: /\/(pdf|mobi|fb2|comic-book|tts|search|vendor\/fflate)\.js$/ }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export {}', loader: 'js' }))
  },
}

const bundle = async (entry) => (await build({
  entryPoints: [resolve(here, entry)],
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
  plugins: [stubFormats],
})).outputFiles[0].text

// The CSP is the book sandbox (ADR-029 Decision 4): sections are blob: documents that inherit this
// policy, so a book's own <script> (no nonce) cannot run, while foliate's iframes still need
// allow-scripts. default-src 'none' + blob:/data: only: nothing a book references outside its zip is
// fetched. connect-src file: is the host's retained EPUB, read by our own (nonce) script.
// ponytail: the nonce is a constant in a public repo, so a book can carry nonce="tsfoliate" and run.
// The host must swap in a per-load random nonce before any book reaches this page outside the dev
// route (R2 host / R3 hostile gate).
const NONCE = 'tsfoliate'
const CSP = [`default-src 'none'`, `script-src 'nonce-${NONCE}'`, `style-src blob: 'unsafe-inline'`, `img-src blob: data:`,
  `font-src blob: data:`, `media-src blob: data:`, `frame-src blob:`, `connect-src blob: data: file:`, `form-action 'none'`, `base-uri 'none'`].join('; ')
const html = (js) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>html,body{margin:0;height:100%;background:#fbf8f3;color:#1f1b16}foliate-view{display:block;height:100%}</style>
</head><body><script nonce="${NONCE}">${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`

const js = await bundle('page.mjs')
const content = `// AUTO-GENERATED — do not edit.
// Source: apps/mobile/src/lib/v2reader/page.mjs (+ store.mjs), built by build.mjs beside it.
// Regenerate: pnpm -C apps/web build:v2-reader
//
// foliate-js ${FOLIATE_SHA} (MIT © John Factotum; bundled zip.js BSD-3-Clause),
// patched with ${patches.join(', ')}.

/* eslint-disable */
/* prettier-ignore */
export const V2_READER_PAGE_HTML = ${JSON.stringify(html(js))}
`

if (process.argv.includes('--check')) {
  let failed = false
  if (js.length > BUDGET) {
    console.error(`[check:v2-reader] the page script is ${js.length} chars, over its ${BUDGET} budget (build.mjs BUDGET, ADR-029).`)
    failed = true
  }
  if ((existsSync(out) ? readFileSync(out, 'utf8') : null) !== content) {
    console.error(`[check:v2-reader] ${out} is out of date. Run: pnpm -C apps/web build:v2-reader`)
    failed = true
  }
  if (failed) process.exit(1)
  console.log(`[check:v2-reader] ${out} is up to date (${js.length} chars).`)
} else {
  writeFileSync(out, content)
  console.log(`wrote ${out} (${js.length} chars script, foliate-js ${FOLIATE_SHA.slice(0, 8)})`)
}

if (process.argv.includes('--repro')) {
  const repro = resolve(here, '.vendor/v2ReaderPage.repro.html')
  writeFileSync(repro, html(await bundle('repro.mjs')))
  console.log(`wrote ${repro} (test only)`)
}
