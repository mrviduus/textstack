#!/usr/bin/env node
// Writes the Original-layout PDF viewer bundle to
// apps/mobile/src/lib/pdfViewerScript.generated.ts.
//
// The bundling itself lives in pdfViewer/bundle.mjs, shared with
// check-mobile-pdf.mjs so the writer and the freshness guard cannot disagree.
//
// NOTE: legacy pdfjs + worker inlined as a string is HEAVY (~1.5-2 MB). It is
// only paid by user-book readers that open an Original-layout PDF — the string
// const is tree-kept out of every other screen's render.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildPdfViewerFile, OUT_FILE } from './pdfViewer/bundle.mjs'

const { fileContent, workerKb, libKb, engineKb, totalKb } = await buildPdfViewerFile()

await mkdir(dirname(OUT_FILE), { recursive: true })
await writeFile(OUT_FILE, fileContent, 'utf8')

console.log(`wrote ${OUT_FILE}`)
console.log(`  worker: ${workerKb} KB · pdf.js: ${libKb} KB · engine page: ${engineKb} KB · total: ${totalKb} KB`)
