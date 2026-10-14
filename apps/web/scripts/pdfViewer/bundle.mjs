// The bundling of the Original-layout PDF viewer, in one place.
//
// Both the writer (`build-mobile-pdf.mjs`) and the CI freshness guard
// (`check-mobile-pdf.mjs`) call this. They used to be the kind of pair that
// duplicates its build config and then disagrees about it — which is exactly the
// failure the guard exists to catch, so having it in the guard would be absurd.
//
// Three esbuild passes (ADR-012 S4b, ADR-025 Phase 5 slice 4):
//   1. WORKER  — pdfjs-dist legacy worker → classic IIFE, inlined as a string so
//      the page can spin it up from a Blob URL (a real off-thread worker,
//      NOT the fake main-thread fallback) inside the RN WebView. One copy, loaded
//      by either document before its page script.
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
// (es2017): the inlined pdf.js legacy worker (PDF_WORKER_SCRIPT), the old viewer
// (PDF_VIEWER_SCRIPT, buildPdfViewerHtml) and the engine page (PDF_ENGINE_SCRIPT,
// buildPdfEngineHtml, EXPO_PUBLIC_READER_ENGINE_PDF). readerHtml.ts injects them.

/* eslint-disable */
/* prettier-ignore */
`

/** @returns {Promise<{ fileContent: string, workerKb: number, controllerKb: number, engineKb: number, totalKb: number }>} */
export async function buildPdfViewerFile() {
  const workerResult = await build({ ...common, entryPoints: [workerEntry] })
  const workerSource = workerResult.outputFiles[0].text

  const controllerResult = await build({ ...common, entryPoints: [controllerEntry] })
  const controllerSource = controllerResult.outputFiles[0].text

  const engineResult = await build({ ...common, entryPoints: [engineEntry] })
  const engineSource = engineResult.outputFiles[0].text

  // The worker source as a global, read by either page script to build the Blob URL.
  const workerScript = `window.__TS_PDF_WORKER_SRC=${JSON.stringify(workerSource)};`
  const fileContent = `${BANNER}export const PDF_WORKER_SCRIPT = ${JSON.stringify(workerScript)}
export const PDF_VIEWER_SCRIPT = ${JSON.stringify(controllerSource)}
export const PDF_ENGINE_SCRIPT = ${JSON.stringify(engineSource)}
`

  return {
    fileContent,
    workerKb: Math.round(workerSource.length / 1024),
    controllerKb: Math.round(controllerSource.length / 1024),
    engineKb: Math.round(engineSource.length / 1024),
    totalKb: Math.round((workerScript.length + controllerSource.length + engineSource.length) / 1024),
  }
}
