import { useState, useEffect, useRef, useCallback } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { getUserBookFileUrl } from '../api/userBooks'
import { serverResumePage, fetchNewerPdfPageFor } from '../lib/originalLayoutPref'
import { clampPage, isPdfAnchor, type PdfAnchor } from '@textstack/shared'
import type { HighlightColor, StoredHighlight } from '../lib/offlineDb'
import type { ReaderMode, NormalizedBook, NormalizedChapter } from './useReaderChapter'
import type { useHighlights } from './useHighlights'
import type { useUserBookProgress } from './useUserBookProgress'

interface Params {
  mode: ReaderMode
  /** Upload id from the route (`:id`). */
  id: string | undefined
  book: NormalizedBook | null
  chapter: NormalizedChapter | null
  /** The URL's chapter in the book's TOC (its `sourceStartPage` opens the PDF). */
  activeChapter: NormalizedBook['chapters'][number] | undefined
  highlightsApi: ReturnType<typeof useHighlights>
  /** Live `?highlight=` param. */
  scrollToHighlightId: string | null
  userProgress: ReturnType<typeof useUserBookProgress>
  authLoading: boolean
  isAuthenticated: boolean
  navigate: NavigateFunction
  getChapterUrl: (identifier: string) => string
}

/**
 * Original-layout (pixel-perfect PDF) wiring for ReaderPage: whether it is active,
 * the viewer's page state, resume page, highlight jumps and the load-error fallback.
 */
export function useReaderPdfOriginal({
  mode,
  id,
  book,
  chapter,
  activeChapter,
  highlightsApi,
  scrollToHighlightId,
  userProgress,
  authLoading,
  isAuthenticated,
  navigate,
  getChapterUrl,
}: Params) {
  // Original layout (pixel-perfect PDF) is the DEFAULT for user-uploaded PDFs
  // (ADR-012 — instant read, no toggle). `forceReflow` is set only by the
  // PDF.js load-error fallback to drop into the reflow reader when chapters exist.
  const [forceReflow, setForceReflow] = useState(false)
  // Corrupt/unopenable PDF with no chapters to fall back to → dedicated screen.
  const [pdfUnopenable, setPdfUnopenable] = useState(false)
  // TOC clicks in Original mode scroll the PDF to a page instead of routing.
  const [pdfScrollTo, setPdfScrollTo] = useState<{ page: number; nonce: number } | null>(null)
  // Current top-visible PDF page (Original mode) — drives the top-bar page
  // bookmark toggle + page bookmark creation.
  const [pdfCurrentPage, setPdfCurrentPage] = useState(1)
  // Page count of the loaded Original PDF (0 until pdf.js reports it). Used to
  // clamp highlight/deep-link page jumps against a stale/corrupt anchor.
  const [pdfNumPages, setPdfNumPages] = useState(0)

  // Original-layout availability + active flag. Only user-uploaded PDFs qualify;
  // catalog/EPUB never use it. Original is the DEFAULT — reflow only wins after
  // a PDF.js load error (forceReflow), and only when a chapter exists.
  const hasOriginalPdf = mode === 'userbook' && !!book?.hasOriginalPdf
  const originalActive = hasOriginalPdf && !forceReflow
  // Open at the current chapter's PDF page — this WINS over the localStorage
  // resume page (the user navigated to this chapter). Null when the chapter has
  // no known page, in which case PdfOriginalView falls back to the resume page.
  const initialPdfPage = activeChapter?.sourceStartPage ?? null
  const pdfFileUrl = id ? getUserBookFileUrl(id) : ''

  const handlePdfHighlight = useCallback(
    (anchor: PdfAnchor, text: string, color: HighlightColor) =>
      highlightsApi.addHighlight(anchor, color, text),
    [highlightsApi],
  )

  // Drawer Highlights-tab jump: nonce-driven so re-selecting the same reflow
  // highlight re-fires (mirrors the pdfScrollTo nonce pattern for PDF pages).
  const [scrollToHl, setScrollToHl] = useState<{ id: string; nonce: number } | null>(null)
  const handleHighlightJump = useCallback((h: StoredHighlight) => {
    if (isPdfAnchor(h.anchor)) {
      // Clamp against a stale/corrupt anchor page so a drawer/deep-link jump
      // can't target a page the document doesn't have (viewer also clamps).
      setPdfScrollTo({ page: clampPage(h.anchor.page, pdfNumPages), nonce: Date.now() })
    } else {
      setScrollToHl({ id: h.id, nonce: Date.now() })
    }
  }, [pdfNumPages])

  // Deep-link: when opened with ?highlight=<id> on a PDF, scroll the viewer to
  // the highlight's stored page once the highlights have loaded. Once per link
  // (the id), not once per mount: the param is read live and removed when resolved.
  const pdfScrolledToHlRef = useRef<string | null>(null)
  useEffect(() => {
    if (!originalActive || !scrollToHighlightId || pdfScrolledToHlRef.current === scrollToHighlightId) return
    const h = highlightsApi.highlights.find((x) => x.id === scrollToHighlightId)
    if (!h || !isPdfAnchor(h.anchor)) return
    pdfScrolledToHlRef.current = scrollToHighlightId
    setPdfScrollTo({ page: clampPage(h.anchor.page, pdfNumPages), nonce: Date.now() })
  }, [originalActive, scrollToHighlightId, highlightsApi.highlights, pdfNumPages])

  // Server resume page for the chapterless Original view (parsed from the
  // "page:<N>" progress locator); used only when provably newer than this
  // device's page (serverResumePage — read at every render, so a reflow →
  // Original switch reopens at the page just read, not the row fetched at
  // mount), and loses to a chapter's sourceStartPage. Read from the userbook
  // progress hook's GET — there used to be a second, identical GET here.
  // `resumeReady` gates the initial scroll so a cross-device open lands on the
  // saved page; that GET is time-bounded, so a hanging network opens at the
  // local page instead of never.
  const pdfResumePage = originalActive && id ? serverResumePage(id, userProgress.serverRow) : null
  const pdfResumeReady = !originalActive || !userProgress.isLoading
  const fetchNewerPdfPage = useCallback(
    (signal: AbortSignal) => fetchNewerPdfPageFor(id, { isLoading: authLoading, isAuthenticated }, signal),
    [id, isAuthenticated, authLoading],
  )

  // PDF.js hard-failed to open the original (NOT the internal 401 reload, which
  // PdfOriginalView handles itself). Fall back to reflow when chapters exist;
  // otherwise show the dedicated "Couldn't open this PDF" screen.
  const handlePdfLoadError = useCallback(() => {
    const chapters = book?.chapters ?? []
    if (chapter || chapters.length > 0) {
      setForceReflow(true)
      // If currently chapterless, route to a chapter so reflow has content.
      if (!chapter && chapters.length > 0) {
        const continueSlug = userProgress.savedProgress?.chapterSlug
        const target = continueSlug ?? chapters[0].identifier
        navigate(getChapterUrl(target), { replace: true })
      }
    } else {
      setPdfUnopenable(true)
    }
  }, [book?.chapters, chapter, userProgress.savedProgress, navigate, getChapterUrl])

  return {
    originalActive,
    pdfUnopenable,
    pdfFileUrl,
    initialPdfPage,
    pdfResumePage,
    pdfResumeReady,
    fetchNewerPdfPage,
    pdfScrollTo,
    setPdfScrollTo,
    pdfCurrentPage,
    setPdfCurrentPage,
    setPdfNumPages,
    scrollToHl,
    handleHighlightJump,
    handlePdfHighlight,
    handlePdfLoadError,
  }
}
