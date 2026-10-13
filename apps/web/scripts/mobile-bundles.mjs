// The mobile WebView bundles, and how their generated files are rendered.
//
// Shared by build-mobile-overlay.mjs (writes them) and check-mobile-overlay.mjs
// (fails CI if the committed files no longer match). The two used to carry their
// own copy of the banner text, so editing one and not the other made the guard
// report a clean tree as out of date — a drift guard that had drifted.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')

/**
 * Two bundles, historically inlined under different conditions: the overlay
 * used to sit behind the (since removed) overlay-v2 flag; both are now always
 * inlined. The anchor resolver must ALWAYS be there: the reading position is resolved from a text
 * anchor on every chapter open (ADR-015) and, unlike a highlight, has no legacy
 * path behind it — with the resolver absent, `hlFindAnchor` degrades to a bare
 * `indexOf`. Both entries install `window.__TSAnchor` guarded, so loading both
 * installs one.
 */
export const BUNDLES = [
  {
    entry: resolve(repoRoot, 'packages/reader-overlay/src/mobileBootstrap.ts'),
    out: resolve(repoRoot, 'apps/mobile/src/lib/readerOverlayScript.generated.ts'),
    constName: 'READER_OVERLAY_SCRIPT',
    source: 'packages/reader-overlay/src/mobileBootstrap.ts',
    blurb:
      'IIFE bundle of the shared @textstack/reader-overlay package, transpiled\n' +
      '// for Android WebView (es2017). Injected into the WebView by readerHtml.ts.',
  },
  {
    entry: resolve(repoRoot, 'packages/reader-overlay/src/anchorBootstrap.ts'),
    out: resolve(repoRoot, 'apps/mobile/src/lib/readerAnchorScript.generated.ts'),
    constName: 'READER_ANCHOR_SCRIPT',
    source: 'packages/reader-overlay/src/anchorBootstrap.ts',
    blurb:
      'IIFE bundle of the shared text-anchor resolver alone, transpiled for\n' +
      '// Android WebView (es2017). Always inlined by readerHtml.ts — the reading\n' +
      '// position is resolved from an anchor and the overlay flag does not gate it.',
  },
  {
    // ADR-025 Phase 3: the engine page — createEngine, the position mappers and the old page's protocol
    // to RN (readerEnginePage.ts). Loaded by buildEngineReaderHtml when EXPO_PUBLIC_READER_ENGINE is on.
    entry: resolve(repoRoot, 'apps/mobile/src/lib/readerEnginePage.ts'),
    out: resolve(repoRoot, 'apps/mobile/src/lib/readerEngineScript.generated.ts'),
    constName: 'READER_ENGINE_SCRIPT',
    source: 'apps/mobile/src/lib/readerEnginePage.ts',
    // Owner decision (ADR-025): raising it is a deliberate PR. Unminified characters.
    budget: 64 * 1024,   // 60 KB until 2026-10-12: PR B left 44 characters, no room for a hotfix
    blurb:
      'IIFE bundle of the engine page (@textstack/reader-engine + its RN protocol),\n' +
      '// transpiled for Android WebView (es2017). Loaded by buildEngineReaderHtml when\n' +
      '// EXPO_PUBLIC_READER_ENGINE is on.',
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
// Regenerate: pnpm -C apps/web build:mobile-overlay
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
