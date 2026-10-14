// The mobile PDF engine page's bundle entry (ADR-025 Phase 5 slice 4, EXPO_PUBLIC_READER_ENGINE_PDF):
// legacy pdf.js (old Android WebViews) + the engine's fixed layout + the page's RN protocol
// (apps/mobile/src/lib/readerEnginePdfPage.ts). Here, not in apps/mobile, because pdf.js resolves from
// apps/web. Outside the 64 KB engine budget, like the old viewer (entry.ts). Bundled by bundle.mjs.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.min.mjs'
import { createEngine } from '../../../../packages/reader-engine/src/engine'
import { fixedLayout, type PdfJs } from '../../../../packages/reader-engine/src/fixed'
import { startPdfPage, type PdfPageWindow } from '../../../mobile/src/lib/readerEnginePdfPage'

const w = window as unknown as PdfPageWindow & { __TS_PDF_WORKER_SRC?: string }
const log = (msg: string) => w.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', level: 'error', msg }))
// A page that breaks is a blank reader: say why in RN's log.
addEventListener('error', (e) => log(`[pdf engine page] ${e.message}`))
addEventListener('unhandledrejection', (e) => log(`[pdf engine page] ${String(e.reason)}`))

// A real worker off the UI thread, from the inlined worker source (PDF_WORKER_SCRIPT, loaded before this).
if (w.__TS_PDF_WORKER_SRC) {
  ;(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
    URL.createObjectURL(new Blob([w.__TS_PDF_WORKER_SRC], { type: 'application/javascript' }))
}

startPdfPage(createEngine(document.getElementById('pdf-root')!, { fixed: fixedLayout(pdfjsLib as unknown as PdfJs) }), w)
