// The engine's fixed layout with web's pdf.js (ADR-025 Phase 5, answer 3a: the host brings pdf.js).
// Imported only by PdfEngineView, itself behind React.lazy: pdf.js and its worker stay a lazy chunk.
import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fixedLayout } from '@textstack/reader-engine/fixed'

// pdf.js starts one worker per document from this URL and ends it with the document.
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

export const pdfFixedLayout = fixedLayout(pdfjs)
