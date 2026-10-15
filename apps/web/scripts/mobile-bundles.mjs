// The mobile WebView bundles, and how their generated files are rendered.
//
// Shared by build-mobile-engine.mjs (writes them) and check-mobile-engine.mjs
// (fails CI if the committed files no longer match). The two used to carry their
// own copy of the banner text, so editing one and not the other made the guard
// report a clean tree as out of date — a drift guard that had drifted.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')

/** The mobile WebView bundles built from source (the PDF one lives in pdfViewer/bundle.mjs). */
export const BUNDLES = [
  {
    // ADR-025 Phase 3: the engine page — createEngine, the position mappers and the protocol
    // to RN (readerEnginePage.ts). Loaded by buildEngineReaderHtml.
    entry: resolve(repoRoot, 'apps/mobile/src/lib/readerEnginePage.ts'),
    out: resolve(repoRoot, 'apps/mobile/src/lib/readerEngineScript.generated.ts'),
    constName: 'READER_ENGINE_SCRIPT',
    source: 'apps/mobile/src/lib/readerEnginePage.ts',
    // Owner decision (ADR-025): raising it is a deliberate PR. Unminified characters.
    budget: 64 * 1024,   // 60 KB until 2026-10-12: PR B left 44 characters, no room for a hotfix
    blurb:
      'IIFE bundle of the engine page (@textstack/reader-engine + its RN protocol),\n' +
      '// transpiled for Android WebView (es2017). Loaded by buildEngineReaderHtml.',
  },
]

/** The exact contents the generated file should have. */
export async function renderBundle({ entry, constName, source, blurb, globalName }) {
  const result = await build({
    entryPoints: [entry],
    // Fixed, because esbuild writes source paths in the bundle RELATIVE TO CWD.
    // Without it the same source produced two different bundles depending on
    // whether the script was run from the repo root or from apps/web, and the
    // drift guard reported a clean tree as out of date.
    absWorkingDir: resolve(__dirname, '..'),
    bundle: true,
    // es2017 keeps async/await + spread/rest but downlevels class private
    // fields (#x) so the bundle runs on Android 7-9 stock WebView.
    target: ['es2017'],
    format: 'iife',
    globalName,
    platform: 'browser',
    write: false,
    minify: false,
    legalComments: 'none',
  })

  const bundleSource = result.outputFiles[0].text.trim()
  const banner = `// AUTO-GENERATED — do not edit.
// Source: ${source}
// Regenerate: pnpm -C apps/web build:mobile-engine
//
// ${blurb}

/* eslint-disable */
/* prettier-ignore */
`
  return {
    content: `${banner}export const ${constName} = ${JSON.stringify(`\n${bundleSource}\n`)}\n`,
    length: bundleSource.length,
  }
}
