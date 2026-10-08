#!/usr/bin/env node
// Smoke test: the injected overlay script is syntactically valid, and
// readerHtml.ts interpolates it correctly (it is always inlined; the overlay-v2 flag is gone). Parses the
// extracted JS via vm.Script — catches unescaped `${…}`, broken template
// boundaries, missing semicolons across slice-8b surface.
//
// Runs via: node apps/mobile/scripts/smoke-reader-html.mjs
// Exits non-zero on any parse error.

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8')
}

function extractTemplate(source, markerConst) {
  const i = source.indexOf(`export const ${markerConst} = \``)
  if (i === -1) throw new Error(`marker ${markerConst} not found`)
  const start = source.indexOf('`', i)
  const end = source.indexOf('`', start + 1)
  if (end === -1) throw new Error(`template close backtick not found for ${markerConst}`)
  return source.slice(start + 1, end)
}

function parseOrDie(label, code) {
  try {
    new vm.Script(code)
  } catch (e) {
    console.error(`[FAIL] ${label} — ${e.message}`)
    const lines = code.split('\n')
    const m = /:(\d+)$/.exec(e.stack || '')
    if (m) {
      const ln = Number(m[1])
      console.error(lines.slice(Math.max(0, ln - 3), ln + 2).join('\n'))
    }
    process.exit(1)
  }
}

// 1. The selection bridge parses standalone.
//
// This used to point at READER_OVERLAY_SCRIPT in readerOverlayScript.ts. That
// module became a one-line re-export of the generated bundle in April, so the
// marker stopped being found and this script has exited non-zero — unnoticed,
// since nothing runs it — ever since. The generated bundle is covered by
// readerOverlayMobileBundle.test.ts, which loads it into JSDOM.
//
// READER_SELECTION_BRIDGE is the hand-written template that was left
// unguarded: 27KB of JavaScript inside a TypeScript string, where a stray
// brace is invisible to tsc and shows up as a reader with no word tap, no
// selection toolbar and no highlights.
const bridgeRaw = extractTemplate(readSource('src/lib/readerBridge.ts'), 'READER_SELECTION_BRIDGE')
// Decode the escapes rather than parsing the source slice. A regex strip does
// not round-trip them — `\\p{L}` in the source is `\p{L}` in the string the
// WebView receives, and parsing the former fails on a regex that is fine. The
// template carries no `${…}`, so evaluating it as a literal runs no code; that
// is asserted rather than assumed, because it stops being true silently.
if (bridgeRaw.includes('${')) {
  console.error('[FAIL] READER_SELECTION_BRIDGE gained an interpolation — this check decodes it as a plain literal')
  process.exit(1)
}
const bridge = vm.runInNewContext('`' + bridgeRaw + '`')
parseOrDie('READER_SELECTION_BRIDGE', bridge)
console.log(`ok selection-bridge — ${bridge.length} bytes`)

// 2. readerHtml.ts interpolates it under the expected flag gate.
const readerHtml = readSource('src/lib/readerHtml.ts')
const hasImport = /from '\.\/readerOverlayScript'/.test(readerHtml)
const hasFlagSetter = /__textstackOverlayV2Mobile/.test(readerHtml)
const hasDispatcher = /hlOverlayEnabled|hlPaintRangeOverlay/.test(readerHtml)
if (!hasImport) { console.error('[FAIL] readerHtml.ts does not import READER_OVERLAY_SCRIPT'); process.exit(1) }
if (!hasFlagSetter) { console.error('[FAIL] readerHtml.ts has no __textstackOverlayV2Mobile flag setter'); process.exit(1) }
if (!hasDispatcher) { console.error('[FAIL] readerHtml.ts has no overlay dispatcher'); process.exit(1) }
console.log('ok readerHtml wiring — import + flag + dispatcher present')

// Note: deeper parsing of readerHtml's embedded <script> bodies from source
// is unreliable — template literal escapes (e.g. `\\p{L}` → `\p{L}`) don't
// round-trip through a regex strip. TypeScript already validates the string
// literal; runtime syntax of the injected JS is verified device-side.

console.log('all ok')
