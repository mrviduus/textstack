import { lazy, Suspense } from 'react'
import type { useReaderPdfOriginal } from '../../hooks/useReaderPdfOriginal'
import type { useHighlights } from '../../hooks/useHighlights'

// pdfjs is heavy — load the Original-layout view (the engine's fixed layout, and its pdfjs chunk) only
// when a user actually opts in for a userbook PDF.
const PdfEngineView = lazy(() => import('./PdfEngineView'))

interface Props {
  pdf: ReturnType<typeof useReaderPdfOriginal>
  bookId: string
  /** The progress GET gave no answer: the open restored from this device. */
  resumeUnanswered: boolean
  onActivity: () => void
  highlightsApi: ReturnType<typeof useHighlights>
  /** A tap on a page (shows the bars). */
  onTap?: () => void
  /** The engine's slot while mounted, for ReaderHighlights' selection. */
  onEngine?: (href: string | null) => void
}

/** The Original-layout (pixel-perfect PDF) reader body; its state lives in useReaderPdfOriginal. */
export function ReaderOriginalPdf({ pdf, bookId, resumeUnanswered, onActivity, highlightsApi, onTap, onEngine }: Props) {
  return (
    <Suspense fallback={<div className="pdf-original__loading">Loading original pages…</div>}>
      <PdfEngineView
        // Another book is another view: its engine, document and highlights start fresh.
        key={bookId}
        fileUrl={pdf.pdfFileUrl}
        bookId={bookId}
        initialPage={pdf.initialPdfPage}
        resumePage={pdf.pdfResumePage}
        resumeReady={pdf.pdfResumeReady}
        resumeUnanswered={resumeUnanswered}
        fetchNewerPage={pdf.fetchNewerPdfPage}
        scrollToPage={pdf.pdfScrollTo}
        onPageChange={pdf.setPdfCurrentPage}
        onNumPages={pdf.setPdfNumPages}
        // Time-only: keeps the reading session/streak alive without
        // feeding page position into canonical word-based progress.
        onActivity={onActivity}
        onLoadError={pdf.handlePdfLoadError}
        highlights={highlightsApi.highlights}
        onHighlightUpdate={highlightsApi.updateHighlight}
        onHighlightDelete={highlightsApi.removeHighlight}
        onTap={onTap}
        onEngine={onEngine}
      />
    </Suspense>
  )
}
