#!/usr/bin/env node
// Drift guard for the mobile PDF viewer bundle. Rebuilds it, compares against
// the committed file, fails non-zero on any difference.
//
// Mirrors check-mobile-overlay.mjs, which the PDF bundle never had. That gap is
// not theoretical: apps/web/scripts/pdfViewer/engineEntry.ts is the source of the
// page that owns the reader's position in a PDF, and an edit to it that ships
// without a rebuild changes nothing at runtime — silently, with a green CI and
// a passing review.

import { readFile } from 'node:fs/promises'
import { buildPdfViewerFile, OUT_FILE } from './pdfViewer/bundle.mjs'

const { fileContent } = await buildPdfViewerFile()
const actual = await readFile(OUT_FILE, 'utf8')

if (actual !== fileContent) {
  console.error(`\n[check:mobile-pdf] ${OUT_FILE} is out of date.\n`)
  console.error('Run: pnpm -C apps/web build:mobile-pdf\n')
  process.exit(1)
}

console.log(`[check:mobile-pdf] ${OUT_FILE} is up to date.`)
