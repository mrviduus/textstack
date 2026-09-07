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
 * Two bundles, because they are inlined under different conditions.
 *
 * The overlay is emitted only when the overlay-v2 flag is on. The anchor
 * resolver is emitted ALWAYS: the reading position is resolved from a text
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
]

/** The exact contents the generated file should have. */
export async function renderBundle({ entry, constName, source, blurb }) {
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
