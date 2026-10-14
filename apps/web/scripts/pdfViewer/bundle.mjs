// The bundling of the Original-layout PDF viewer, in one place.
//
// Both the writer (`build-mobile-pdf.mjs`) and the CI freshness guard
// (`check-mobile-pdf.mjs`) call this. They used to be the kind of pair that
// duplicates its build config and then disagrees about it — which is exactly the
// failure the guard exists to catch, so having it in the guard would be absurd.
//
// Four esbuild passes (ADR-012 S4b, ADR-025 Phase 5 slice 4):
//   1. WORKER  — pdfjs-dist legacy worker → classic IIFE, inlined as a string so
//      the page can spin it up from a Blob URL (a real off-thread worker,
//      NOT the fake main-thread fallback) inside the RN WebView.
//   1b. LIB — pdfjs-dist legacy main API → the global `__TS_PDFJS`. With the worker
//      it is PDF_JS_SCRIPT: one copy of pdf.js, loaded by either document before its
//      page script. Both page bundles take `pdfjs-dist/legacy/build/pdf.min.mjs`
//      from that global (PDFJS_GLOBAL below) instead of each carrying a copy.
//   2. CONTROLLER — entry.ts (pdf.js main API + shared virtualization math): the
//      old viewer, EXPO_PUBLIC_READER_ENGINE_PDF off.
//   3. ENGINE — engineEntry.ts (pdf.js main API + the engine's fixed layout + the
//      RN protocol): EXPO_PUBLIC_READER_ENGINE_PDF on. Phase 6 deletes pass 2.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const require = createRequire(import.meta.url)

export const OUT_FILE = resolve(repoRoot, 'apps/mobile/src/lib/pdfViewerScript.generated.ts')

const controllerEntry = resolve(__dirname, 'entry.ts')
const engineEntry = resolve(__dirname, 'engineEntry.ts')
// Resolve through node (pnpm) rather than a hard path — pdfjs lives under
// apps/web/node_modules/.pnpm, not the repo-root node_modules.
const workerEntry = require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
const PDFJS = 'pdfjs-dist/legacy/build/pdf.min.mjs'
const libEntry = require.resolve(PDFJS)

/** The page bundles' `import … from PDFJS` reads the shared global (PDF_JS_SCRIPT runs first). */
const PDFJS_GLOBAL = {
  name: 'pdfjs-global',
  setup(b) {
    // .cjs: with the real `.mjs` path esbuild treats the shim as ESM, and `module` is undefined at run time.
    b.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf\.min\.mjs$/ }, () => ({ path: 'pdfjs-global.cjs', namespace: 'pdfjs-global' }))
    b.onLoad({ filter: /.*/, namespace: 'pdfjs-global' }, () => ({ contents: 'module.exports = window.__TS_PDFJS', loader: 'js' }))
  },
}

const common = {
  // Fixed, for the same reason as the overlay bundle: esbuild writes source
  // paths relative to CWD. The PDF bundle is minified, so those paths do not
  // survive into the output today and the guard happened to be immune — which
  // is luck, not a property worth relying on.
  absWorkingDir: resolve(__dirname, '..', '..'),
  bundle: true,
  format: 'iife',
  // es2017 keeps async/await + spread but downlevels class private fields so
  // the bundle runs on Android 7-9 stock WebView (same target as the overlay).
  target: ['es2017'],
  platform: 'browser',
  write: false,
  minify: true,
  legalComments: 'none',
}

const BANNER = `// AUTO-GENERATED — do not edit.
// Source: apps/web/scripts/pdfViewer/{entry,engineEntry}.ts + pdfjs-dist legacy worker
// Regenerate: pnpm -C apps/web build:mobile-pdf
//
// IIFE bundles for the Original-layout PDF document, transpiled for Android WebView
// (es2017): pdf.js legacy — its worker inlined as a string, its main API as a global
// (PDF_JS_SCRIPT) — the old viewer
// (PDF_VIEWER_SCRIPT, buildPdfViewerHtml) and the engine page (PDF_ENGINE_SCRIPT,
// buildPdfEngineHtml, EXPO_PUBLIC_READER_ENGINE_PDF). readerHtml.ts injects them.

/* eslint-disable */
/* prettier-ignore */
`

/** @returns {Promise<{ fileContent: string, workerKb: number, controllerKb: number, engineKb: number, totalKb: number }>} */
export async function buildPdfViewerFile() {
  const workerResult = await build({ ...common, entryPoints: [workerEntry] })
  const workerSource = workerResult.outputFiles[0].text

  const libResult = await build({ ...common, entryPoints: [libEntry], globalName: '__TS_PDFJS' })
  const libSource = libResult.outputFiles[0].text

  const controllerResult = await build({ ...common, entryPoints: [controllerEntry], plugins: [PDFJS_GLOBAL] })
  const controllerSource = controllerResult.outputFiles[0].text

  const engineResult = await build({ ...common, entryPoints: [engineEntry], plugins: [PDFJS_GLOBAL] })
  const engineSource = engineResult.outputFiles[0].text

  // The worker source as a global (each page script builds the Blob URL from it), then pdf.js itself.
  const workerScript = `window.__TS_PDF_WORKER_SRC=${JSON.stringify(workerSource)};\n${libSource}`
  const fileContent = `${BANNER}export const PDF_JS_SCRIPT = ${JSON.stringify(workerScript)}
export const PDF_VIEWER_SCRIPT = ${JSON.stringify(controllerSource)}
export const PDF_ENGINE_SCRIPT = ${JSON.stringify(engineSource)}
`

  return {
    fileContent,
    workerKb: Math.round(workerSource.length / 1024),
    libKb: Math.round(libSource.length / 1024),
    controllerKb: Math.round(controllerSource.length / 1024),
    engineKb: Math.round(engineSource.length / 1024),
    totalKb: Math.round((workerScript.length + controllerSource.length + engineSource.length) / 1024),
  }
}
