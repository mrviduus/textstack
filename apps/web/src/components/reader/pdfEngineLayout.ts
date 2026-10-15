// The engine's fixed layout with web's pdf.js (ADR-025 Phase 5, answer 3a: the host brings pdf.js).
// Imported only by PdfEngineView, itself behind React.lazy: pdf.js and its worker stay a lazy chunk.
import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fixedLayout } from '@textstack/reader-engine/fixed'

export { isReaderScrollKey } from '@textstack/reader-engine/fixed'

// pdf.js starts one worker per document from this URL and ends it with the document.
// ?mime=1: nginx served this .mjs as octet-stream with `immutable, max-age=1y` until #857; a browser
// that cached that copy would refuse it for a year. The query is a new cache key; drop it with the
// next pdfjs-dist bump (new hash).
pdfjs.GlobalWorkerOptions.workerSrc = `${workerSrc}?mime=1`

export const pdfFixedLayout = fixedLayout(pdfjs)
