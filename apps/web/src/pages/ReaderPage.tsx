import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useReaderSettings } from '../hooks/useReaderSettings'
import { useReaderChapter, type ReaderMode } from '../hooks/useReaderChapter'
import { useReaderScrollSync } from '../hooks/useReaderScrollSync'
import { useReaderProgress } from '../hooks/useReaderProgress'
import { useReaderBookmarks } from '../hooks/useReaderBookmarks'
import { useInBookSearch } from '../hooks/useInBookSearch'
import { useLibrary } from '../hooks/useLibrary'
import { useReaderKeyboard } from '../hooks/useReaderKeyboard'
import { useImmersiveMode } from '../hooks/useImmersiveMode'
import { useTranslation } from '../hooks/useTranslation'
import { SeoHead } from '../components/SeoHead'
import { LocalizedLink } from '../components/LocalizedLink'
import { Toast } from '../components/Toast'
import { ReaderTopBar } from '../components/reader/ReaderTopBar'
import { ReaderSection } from '../components/reader/ReaderSection'
import { ReaderNav } from '../components/reader/ReaderNav'
import { ReaderFooterNav } from '../components/reader/ReaderFooterNav'
import { ReaderSettingsDrawer } from '../components/reader/ReaderSettingsDrawer'
import { AskPanel, type AskPrefill } from '../components/reader/AskPanel'
import type { AskCitation, AskTarget } from '../api/ask'
import { resolveCitationJump } from './readerCitationJump'
import { scrollToCitation } from '../lib/citationScroll'
import { ReaderTocDrawer } from '../components/reader/ReaderTocDrawer'
import { ReaderSearchDrawer } from '../components/reader/ReaderSearchDrawer'
import { ReaderHighlights } from '../components/reader/ReaderHighlights'
import { SearchOverlayLayer } from '../components/reader/SearchOverlayLayer'
import { useReadingSession } from '../hooks/useReadingSession'
import { useQuickStats } from '../hooks/useQuickStats'
import { calculateETF } from '../lib/etf'
import { trackBookOpened } from '../lib/analytics'
import { ReaderStatsWidget } from '../components/reader/ReaderStatsWidget'
import { useGuestLimits } from '../context/GuestLimitsContext'
import { WordHint } from '../components/reader/WordHint'
import { getUserBooks, getUserBookFileUrl, getUserBookProgress } from '../api/userBooks'
import { parsePdfPageLocator, computeBookProgress, clampPage, isPdfAnchor, type PdfAnchor } from '@textstack/shared'
import { useHighlights } from '../hooks/useHighlights'
import type { HighlightColor, StoredHighlight } from '../lib/offlineDb'
import { sourceDomain } from '../components/library/ReadLaterShelf'
import '../styles/micro-practice.css'

// pdfjs is heavy — load the Original-layout view (and its pdfjs chunk) only when
// a user actually opts in for a userbook PDF.
const PdfOriginalView = lazy(() => import('../components/reader/PdfOriginalView'))

export type { ReaderMode } from '../hooks/useReaderChapter'

interface ReaderPageProps {
  mode?: ReaderMode
}

export function ReaderPage({ mode = 'public' }: ReaderPageProps) {
  // Get params based on mode - both modes now use slug
  const { bookSlug, chapterSlug, id, chapterSlug: userChapterSlug } = useParams<{
    bookSlug: string
    chapterSlug: string
    id: string
  }>()

  // For userbook mode, chapterSlug comes from the :chapterSlug param
  const chapterIdentifier = mode === 'public' ? chapterSlug : userChapterSlug

  const { isAuthenticated, openAuthModal, ensureSession } = useAuth()
  const { language, getLocalizedPath } = useLanguage()
  const { t } = useTranslation()
  const navigate = useNavigate()

  const { chapter, book, publicChapter, publicBook, loading, error } = useReaderChapter({
    mode,
    bookSlug,
    chapterSlug,
    userBookId: id,
    userChapterSlug,
    isAuthenticated,
  })

  // Source URL for "Send to TextStack" clips. The userbook detail DTO doesn't
  // carry it, so resolve from the Read later list (clips only) once per book.
  const [clipSourceUrl, setClipSourceUrl] = useState<string | null>(null)
  useEffect(() => {
    if (mode !== 'userbook' || !isAuthenticated || !id) { setClipSourceUrl(null); return }
    let cancelled = false
    getUserBooks({ shelf: 'readlater' })
      .then(books => {
        if (cancelled) return
        const match = books.find(b => b.id === id)
        setClipSourceUrl(match?.sourceUrl ?? null)
      })
      .catch(() => { if (!cancelled) setClipSourceUrl(null) })
    return () => { cancelled = true }
  }, [mode, isAuthenticated, id])

  const [tocOpen, setTocOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  // "Ask about this": a reader-selection passage attached to the chat composer as a quote card.
  const [askPrefill, setAskPrefill] = useState<AskPrefill | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

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

  // Highlight ID from URL — scroll to this highlight after chapter loads
  const [scrollToHighlightId] = useState(() => new URLSearchParams(window.location.search).get('highlight'))

  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const { settings, update } = useReaderSettings()

  const {
    bookmarks,
    addBookmark,
    removeBookmark,
    isBookmarked,
    getBookmarkForChapter,
    addPageBookmark,
    isPageBookmarked,
    getPageBookmark,
  } = useReaderBookmarks({
      mode,
      bookSlug,
      userBookId: id,
      publicEditionId: publicBook?.id,
      publicChapter,
      book,
      isAuthenticated,
    })
  const { add: addToLibrary, isInLibrary } = useLibrary()
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [bookCompleted, setBookCompleted] = useState(false)
  const { setCurrentBook: setGuestCurrentBook } = useGuestLimits()

  // Pre-warm guest session on reader mount so first-word-tap doesn't race
  // ensureSession mid-popup, which would flip isAuthenticated and re-run the
  // chapter-fetch effect (reader reload + dropped popup). Single-flight inside.
  useEffect(() => {
    if (!isAuthenticated) {
      ensureSession().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot on mount
  }, [])

  const libraryAddedRef = useRef(false)

  const { immersiveMode, showBars: showImmersiveBars } = useImmersiveMode(true, loading)

  // Chapter list for progress + TOC. URL chapter is authoritative — single
  // chapter mounted per view.
  const chapterList = useMemo(() => {
    if (mode === 'public' && publicBook) {
      return publicBook.chapters.map(c => ({
        identifier: c.slug,
        title: c.title,
        chapterNumber: c.chapterNumber,
        wordCount: c.wordCount,
      }))
    }
    if (mode === 'userbook' && book) {
      return book.chapters.map(c => ({
        identifier: c.identifier,
        title: c.title,
        chapterNumber: c.chapterNumber,
        wordCount: c.wordCount ?? null,
      }))
    }
    return null
  }, [mode, publicBook, book])

  const activeChapterIdentifier = chapterIdentifier || ''
  const activeChapter = book?.chapters.find(c => c.identifier === activeChapterIdentifier)

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

  // Single hoisted highlights hook for the whole reader — shared by the reflow
  // path (down into ReaderHighlights → useHighlightEdit as props), the PDF
  // Original-layout subtree (paint + edit), the SelectionToolbar (create), and
  // the TOC drawer's Highlights tab. One useHighlights instance = one IndexedDB
  // + server load (previously PDF mode double-loaded: here + inside ReaderHighlights).
  const highlightsApi = useHighlights(
    mode === 'userbook' ? undefined : book?.id,
    mode === 'userbook' ? id : undefined,
    { isAuthenticated },
  )
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
  // the highlight's stored page once the highlights have loaded.
  const pdfScrolledToHlRef = useRef(false)
  useEffect(() => {
    if (!originalActive || !scrollToHighlightId || pdfScrolledToHlRef.current) return
    const h = highlightsApi.highlights.find((x) => x.id === scrollToHighlightId)
    if (!h || !isPdfAnchor(h.anchor)) return
    pdfScrolledToHlRef.current = true
    setPdfScrollTo({ page: clampPage(h.anchor.page, pdfNumPages), nonce: Date.now() })
  }, [originalActive, scrollToHighlightId, highlightsApi.highlights, pdfNumPages])

  // Server resume page for the chapterless Original view (parsed from the
  // "page:<N>" progress locator). Fetched once when Original is active; wins over
  // localStorage but loses to a chapter's sourceStartPage. `resumeReady` gates
  // the initial scroll so a cross-device open lands on the saved page.
  const [pdfResumePage, setPdfResumePage] = useState<number | null>(null)
  const [pdfResumeReady, setPdfResumeReady] = useState(false)
  useEffect(() => {
    if (!originalActive || !id) {
      setPdfResumeReady(true)
      return
    }
    let cancelled = false
    setPdfResumeReady(false)
    setPdfResumePage(null)
    getUserBookProgress(id)
      .then((p) => { if (!cancelled) setPdfResumePage(parsePdfPageLocator(p?.locator)) })
      .catch(() => { /* offline → PdfOriginalView falls back to localStorage */ })
      .finally(() => { if (!cancelled) setPdfResumeReady(true) })
    return () => { cancelled = true }
  }, [originalActive, id])

  const { publicProgress, userProgress, effectiveProgress, effectiveLoading, autoSaveInfo } =
    useReaderProgress({
      mode,
      bookSlug,
      chapterSlug,
      userBookId: id,
      publicBook,
      publicChapter,
      book,
    })

  // Migrate legacy progress (chapterNumber -> slug) for userbooks. Stays in
  // page because it owns routing.
  const legacyMigratedRef = useRef(false)
  useEffect(() => {
    if (mode !== 'userbook') return
    if (legacyMigratedRef.current) return
    if (!userProgress.legacyProgress || !book?.chapters) return

    legacyMigratedRef.current = true
    const legacyChapterNum = userProgress.legacyProgress.chapterNumber
    const targetChapter = book.chapters.find(c => c.chapterNumber === legacyChapterNum)
    if (targetChapter) {
      const qs = window.location.search
      navigate(`/${language}/library/my/${id}/read/${targetChapter.identifier}` + qs, { replace: true })
    }
  }, [mode, userProgress.legacyProgress, book?.chapters, navigate, language, id])

  // Single chapter mounted; native window scroll drives intra-chapter progress.
  const [overlayScrollProgress, setOverlayScrollProgress] = useState(0)
  useEffect(() => {
    const read = () => {
      const doc = document.scrollingElement || document.documentElement
      const max = doc.scrollHeight - doc.clientHeight
      if (max <= 0) { setOverlayScrollProgress(0); return }
      setOverlayScrollProgress(Math.min(1, Math.max(0, doc.scrollTop / max)))
    }
    read()
    window.addEventListener('scroll', read, { passive: true })
    window.addEventListener('resize', read)
    return () => {
      window.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
    }
  }, [chapter?.id])

  // Overall book progress = words-read / total-words across chapters,
  // driven by URL chapter + intra-chapter scroll.
  const calculatedProgress = useMemo(() => {
    const chapters = chapterList?.map(c => ({ slug: c.identifier, wordCount: c.wordCount })) ?? []
    // Denominator = canonical book-wide word total so the client's book-% matches
    // the server's Σ chapter WordCount — the same value persisted verbatim into
    // UserBook.ProgressPercent and read back by the library card + shelf. For user
    // books that's book.totalWordCount; for public editions we let computeBookProgress
    // fall back to the chapter-list sum, which already equals Σ Chapters.WordCount.
    const totalWords = mode === 'userbook' ? (book?.totalWordCount || undefined) : undefined
    return computeBookProgress(chapters, chapterIdentifier, overlayScrollProgress, totalWords) ?? 0
  }, [chapterList, chapterIdentifier, overlayScrollProgress, mode, book?.totalWordCount])

  // Force 100% when book is completed
  const rawProgress = bookCompleted ? 1 : calculatedProgress

  // Clamp progress monotonically within a session: scrolling down must never
  // reduce the bar. Fixes jitter from chapter-boundary scroll handoff and
  // Math.round flipping between 99/100.
  const maxProgressRef = useRef(0)
  useEffect(() => {
    maxProgressRef.current = 0
  }, [book?.id])
  if (rawProgress > maxProgressRef.current) maxProgressRef.current = rawProgress
  const overallProgress = maxProgressRef.current

  // Reading session tracking (time, words)
  const readingSession = useReadingSession({
    editionId: mode === 'public' ? publicBook?.id : undefined,
    userBookId: mode === 'userbook' ? id : undefined,
    totalWords: mode === 'public' && publicBook
      ? publicBook.chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0)
      : undefined,
    startPercent: overallProgress,
    isAuthenticated,
  })

  // Sync percent to reading session tracker
  useEffect(() => {
    readingSession.updatePercent(overallProgress)
  }, [overallProgress, readingSession])

  // GA4: fire once per mount when the book is first resolved. Keyed on
  // editionId/userBookId so a re-mount on navigation fires again, but
  // re-renders within the same open don't double-count.
  const bookOpenedFiredRef = useRef<string | null>(null)
  useEffect(() => {
    const editionId = mode === 'public' ? publicBook?.id : undefined
    const userBookId = mode === 'userbook' ? id : undefined
    const key = editionId || userBookId
    if (!key) return
    if (bookOpenedFiredRef.current === key) return
    bookOpenedFiredRef.current = key
    trackBookOpened({
      source: mode === 'public' ? 'library' : 'userbook',
      editionId: editionId || null,
      userBookId: userBookId || null,
      // NormalizedBook doesn't carry language; fall back to the UI language
      // from the route, which is the same locale the reader is rendered in.
      language: mode === 'public' ? publicBook?.language : language,
    })
  }, [mode, publicBook?.id, publicBook?.language, id, language])

  // ETF & reader stats
  const quickStats = useQuickStats()
  const userWpm = quickStats?.wpm ?? null

  const bookTotalWords = useMemo(() => {
    if (mode === 'public' && publicBook) {
      return publicBook.chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0)
    }
    if (mode === 'userbook' && book) {
      return book.totalWordCount || book.chapters.reduce((sum: number, c: any) => sum + (c.wordCount || 0), 0)
    }
    return 0
  }, [mode, publicBook, book])

  const bookEtf = useMemo(
    () => calculateETF(bookTotalWords, overallProgress, userWpm),
    [bookTotalWords, overallProgress, userWpm],
  )

  const totalChapters = chapterList?.length ?? 0
  const currentChapterIndex = useMemo(() => {
    if (!chapterList) return -1
    const id = chapterIdentifier || ''
    if (!id) return -1
    return chapterList.findIndex(c => c.identifier === id)
  }, [chapterList, chapterIdentifier])

  // Track scroll activity for reading session
  useEffect(() => {
    let lastScroll = 0
    const handleScroll = () => {
      const now = Date.now()
      if (now - lastScroll > 5000) { // throttle: once per 5s
        lastScroll = now
        readingSession.recordActivity()
      }
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [readingSession])

  // Scroll-position restore + debounced save + flush on visibility/unload.
  useReaderScrollSync({
    mode,
    chapterIdentifier,
    chapterLoaded: !!chapter,
    // An uploaded PDF usually HAS reflow chapters, so the chapter fetch succeeds
    // in Original layout too and the save-on-open would fire while the reader is
    // looking at pages. Same defect the mobile reader had.
    originalActive,
    overallProgress,
    effectiveProgress,
    effectiveLoading,
    publicBookChapters: publicBook?.chapters,
    publicProgress,
    userProgress,
    // Typography only. Theme is a data-attribute swap and does not re-wrap text,
    // so re-anchoring for it would cost a layout read for nothing.
    settingsKey: `${settings.fontSize} ${settings.lineHeight} ${settings.fontFamily} ${settings.textAlign}`,
  })

  // Track current book for guest returning user feature
  useEffect(() => {
    if (isAuthenticated || !bookSlug || !chapterIdentifier) return
    setGuestCurrentBook({ bookSlug, chapterSlug: chapterIdentifier })
  }, [isAuthenticated, bookSlug, chapterIdentifier, setGuestCurrentBook])

  // Auto-add to library after 1% overall progress
  useEffect(() => {
    if (!book?.id || libraryAddedRef.current) return
    if (overallProgress < 0.01) return
    if (isInLibrary(book.id)) {
      libraryAddedRef.current = true
      return
    }
    libraryAddedRef.current = true
    addToLibrary(book.id)
      .then(() => setToastMessage('Added to library'))
      .catch(() => {}) // silent fail
  }, [overallProgress, book?.id, isInLibrary, addToLibrary])

  // Search hook needs chapter html, use empty string until loaded
  const chapterHtml = chapter?.html || ''
  const {
    query: searchQuery,
    matches: searchMatches,
    activeMatchIndex,
    search,
    nextMatch,
    prevMatch,
    goToMatch,
    clear: clearSearch,
  } = useInBookSearch(chapterHtml)

  // Seed search from `?find=` (slice 16 deep-link from library content search).
  // Runs once when chapter HTML first arrives to avoid clobbering the user's manual search.
  const findSeededRef = useRef(false)
  useEffect(() => {
    if (findSeededRef.current) return
    if (!chapterHtml) return
    const findParam = new URLSearchParams(window.location.search).get('find')
    if (!findParam) { findSeededRef.current = true; return }
    findSeededRef.current = true
    search(findParam)
    setSearchOpen(true)
  }, [chapterHtml, search])

  // Ship the LEAVING chapter's latest scroll synchronously before a same-component
  // route change (the unmount flush doesn't fire when ReaderPage stays mounted).
  const flushProgress = useCallback(() => {
    if (mode === 'public') publicProgress.flushSave()
    else userProgress.flushSave()
  }, [mode, publicProgress, userProgress])

  // Chapter URL helper
  const getChapterUrl = useCallback((identifier: string) => {
    if (mode === 'public') {
      return getLocalizedPath(`/books/${bookSlug}/${identifier}`)
    }
    return `/${language}/library/my/${id}/read/${identifier}`
  }, [mode, bookSlug, id, language, getLocalizedPath])

  // Drawer jump to a reflow highlight in a chapter the reader hasn't mounted
  // (one-chapter-at-a-time). Resolve its chapter id → slug and route there;
  // useHighlightEdit re-runs the scroll once the new chapter's DOM lands.
  const handleHighlightNavigate = useCallback((h: StoredHighlight) => {
    const target = book?.chapters.find(c => c.id === h.chapterId)
    if (!target || target.identifier === activeChapterIdentifier) return
    flushProgress()
    navigate(getChapterUrl(target.identifier))
  }, [book?.chapters, activeChapterIdentifier, flushProgress, navigate, getChapterUrl])

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

  // RAG "Ask this book" target (AI-027). P1: catalog editions. P2: user uploads — on-demand
  // indexing via the owner-scoped `/me/books/{id}/...` endpoints, no spoiler gate. The target
  // carries the kind + seeded index state/counts so the panel routes to the right endpoints.
  const askTarget: AskTarget | undefined =
    mode === 'public' && publicBook
      ? {
          kind: 'edition',
          id: publicBook.id,
          ragStatus: publicBook.ragStatus,
          ragChunkCount: publicBook.ragChunkCount,
          ragEmbeddedCount: publicBook.ragEmbeddedCount,
        }
      : mode === 'userbook' && book
        ? {
            kind: 'userbook',
            id: book.id,
            ragStatus: book.ragStatus,
            ragChunkCount: book.ragChunkCount,
            ragEmbeddedCount: book.ragEmbeddedCount,
          }
        : undefined

  // "Ask about this" (Study Buddy merged into chat): open the chat panel with the selected passage
  // attached as a quote card. Available wherever chat is (any resolved askTarget), not catalog-only.
  const handleAskAboutThis = useCallback((passage: string) => {
    setAskPrefill({ text: passage, nonce: Date.now() })
    setAskOpen(true)
  }, [])

  const pendingCitationRef = useRef<AskCitation | null>(null)
  const handleNavigateToCitation = useCallback((c: AskCitation) => {
    // Original PDF mode: a page-anchored citation jumps the pixel-perfect viewer to
    // its source page (ADR-012 S3c) instead of scrolling the reflow DOM. PDF chunks
    // are not chapter-anchored, so the reflow path below can't locate them.
    const jump = resolveCitationJump(c, originalActive)
    if (jump.kind === 'pdf') {
      setAskOpen(false)
      setPdfScrollTo({ page: jump.page, nonce: Date.now() })
      return
    }
    const target = chapterList?.find(ch => ch.chapterNumber === c.chapterOrd)
    setAskOpen(false)
    if (!target) return
    if (target.identifier === activeChapterIdentifier && scrollContainerRef.current) {
      // Already on the cited chapter — scroll to the passage now (026b).
      scrollToCitation(scrollContainerRef.current, c)
    } else {
      // Different chapter: navigate, then the effect below scrolls once it renders.
      pendingCitationRef.current = c
      navigate(getChapterUrl(target.identifier))
    }
  }, [chapterList, activeChapterIdentifier, getChapterUrl, navigate, originalActive])

  // Consume a pending citation once its chapter has navigated in and rendered. Runs after
  // scroll-restore (slight delay) so an explicit citation jump wins over position restore.
  useEffect(() => {
    const pending = pendingCitationRef.current
    if (!pending || loading) return
    const target = chapterList?.find(ch => ch.chapterNumber === pending.chapterOrd)
    const container = scrollContainerRef.current
    if (!target || target.identifier !== activeChapterIdentifier || !container) return
    pendingCitationRef.current = null
    // Double rAF: runs a frame after scroll-restore's single rAF, so the explicit citation jump
    // wins without racing on a magic timeout.
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => scrollToCitation(container, pending))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [activeChapterIdentifier, loading, chapterList])

  // Back URL
  const backUrl = mode === 'public'
    ? `/books/${bookSlug}`
    : `/${language}/library/my/${id}`

  useReaderKeyboard({
    tocOpen,
    settingsOpen,
    searchOpen,
    setTocOpen,
    setSettingsOpen,
    setSearchOpen,
    clearSearch,
  })

  // Auth check for userbook mode
  if (mode === 'userbook' && !isAuthenticated) {
    return (
      <div className="reader-page">
        <SeoHead title="Reader" noindex />
        <div className="reader-error">
          <h2>Sign in required</h2>
          <p>Sign in to read your uploaded books.</p>
          <Link to={`/${language}/library`} className="reader-error__home-link">
            Back to Library
          </Link>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="reader-page">
        <SeoHead title="Loading..." noindex />
        <div className="reader-loading">
          <div className="reader-loading__skeleton" />
          <div className="reader-loading__skeleton" />
          <div className="reader-loading__skeleton" />
        </div>
      </div>
    )
  }

  // Corrupt/unopenable PDF with no chapters to fall back to (S1b) — a dedicated
  // screen, NOT the generic chapter-error, offering re-upload / retry.
  if (pdfUnopenable && book) {
    return (
      <div className="reader-page">
        <SeoHead title={t('reader.originalLayout.cantOpenTitle')} noindex />
        <div className="reader-error">
          <h2>{t('reader.originalLayout.cantOpenTitle')}</h2>
          <p>{t('reader.originalLayout.cantOpenBody')}</p>
          <Link to={`/${language}/library/my/${id}`} className="reader-error__home-link">
            {t('reader.originalLayout.cantOpenCta')}
          </Link>
        </div>
      </div>
    )
  }

  // Error only when the book itself is missing, OR reflow genuinely needs a
  // chapter it doesn't have. A chapterless Original-layout PDF renders fine.
  if (error || !book || (!chapter && !originalActive)) {
    const errorBackUrl = mode === 'public' ? '/' : `/${language}/library/my/${id}`
    const errorBackText = mode === 'public' ? 'Back to Home' : 'Back to Book'
    const ErrorLink = mode === 'public' ? LocalizedLink : Link
    return (
      <div className="reader-page">
        <SeoHead title="Error" noindex />
        <div className="reader-error">
          <h2>Error loading chapter</h2>
          <p>{error || 'Chapter not found'}</p>
          <ErrorLink to={errorBackUrl} className="reader-error__home-link">
            {errorBackText}
          </ErrorLink>
        </div>
      </div>
    )
  }

  const seoTitle = `${chapter?.title ?? book.title} — ${book.title}`
  const seoDescription = `Read ${chapter?.title ?? book.title} from ${book.title} online | TextStack Reader`

  const immersiveClass = immersiveMode ? 'immersive-mode' : ''
  // Original-layout PDF: the reveal-on-scroll immersive path can never fire (the
  // PDF scrolls internally), so pin the reader chrome. The class offsets the PDF
  // view below the fixed top bar and overrides the immersive hide (reader.css).
  const originalClass = originalActive ? 'reader-page--original' : ''

  return (
    <div className={`reader-page ${immersiveClass} ${originalClass}`}>
      <SeoHead title={seoTitle} description={seoDescription} noindex />
      <a href="#reader-content" className="skip-link">Skip to content</a>
      <ReaderTopBar
        // Original mode pins the bar visible — the immersive reveal can't fire
        // (PDF scrolls internally, window scroll never moves). reader.css also
        // overrides the immersive !important hide for .reader-page--original.
        visible={!immersiveMode || originalActive}
        title={book.title}
        chapterTitle={activeChapter?.title || chapter?.title || book.title}
        progress={overallProgress}
        isBookmarked={originalActive ? isPageBookmarked(pdfCurrentPage) : isBookmarked(activeChapterIdentifier)}
        backUrl={backUrl}
        sourceUrl={mode === 'userbook' ? clipSourceUrl : null}
        sourceDomain={mode === 'userbook' ? sourceDomain(clipSourceUrl) : null}
        useLocalizedLink={mode === 'public'}
        showAsk={!!askTarget}
        // In-chapter search is reflow-DOM based; the PDF canvas has no page-aware
        // search yet, so hide the button rather than open a no-op (follow-up).
        showSearch={!originalActive}
        // Original PDF has no word-based progress (session is time-only → 0%);
        // the footer page indicator (N / total) is the real progress. Hide the % here.
        showProgress={!originalActive}
        onAskClick={() => setAskOpen(true)}
        onSearchClick={() => setSearchOpen(true)}
        onTocClick={() => setTocOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        onBookmarkClick={() => {
          if (originalActive) {
            // Toggle a bookmark on the CURRENT PDF page.
            const existing = getPageBookmark(pdfCurrentPage)
            if (existing) removeBookmark(existing.id)
            else addPageBookmark(pdfCurrentPage)
            return
          }
          const bookmark = getBookmarkForChapter(activeChapterIdentifier)
          if (bookmark) {
            removeBookmark(bookmark.id)
          } else if (activeChapter) {
            addBookmark(activeChapterIdentifier, activeChapter.title)
          }
        }}
      />

      <main id="reader-content" className="reader-main">
        <ReaderHighlights
          editionId={book?.id || ''}
          chapterId={activeChapter?.id || ''}
          containerRef={scrollContainerRef}
          isAuthenticated={isAuthenticated}
          bookLanguage={publicBook?.language}
          bookTitle={book?.title}
          userBookId={mode === 'userbook' ? id : undefined}
          ttsSpeed={settings.ttsSpeed}
          showInlineTranslations={settings.showInlineTranslations}
          scrollToHighlightId={scrollToHighlightId}
          scrollToHl={scrollToHl}
          onNavigateToHighlight={handleHighlightNavigate}
          highlights={highlightsApi.highlights}
          addHighlight={highlightsApi.addHighlight}
          updateHighlight={highlightsApi.updateHighlight}
          removeHighlight={highlightsApi.removeHighlight}
          onAskAbout={askTarget ? handleAskAboutThis : undefined}
          liveActionsOnly={originalActive}
          onPdfHighlight={originalActive ? handlePdfHighlight : undefined}
        >
          <div ref={scrollContainerRef}>
            {originalActive ? (
              // Text layers render inside scrollContainerRef, so the same
              // useTextSelection pipeline (translate/explain/TTS/vocab) works
              // over the PDF text with no changes to the selection components.
              <Suspense fallback={<div className="pdf-original__loading">Loading original pages…</div>}>
                <PdfOriginalView
                  fileUrl={pdfFileUrl}
                  bookId={id!}
                  initialPage={initialPdfPage}
                  resumePage={pdfResumePage}
                  resumeReady={pdfResumeReady}
                  scrollToPage={pdfScrollTo}
                  onPageChange={setPdfCurrentPage}
                  onNumPages={setPdfNumPages}
                  // Time-only: keeps the reading session/streak alive without
                  // feeding page position into canonical word-based progress.
                  onActivity={() => readingSession.recordActivity()}
                  onLoadError={handlePdfLoadError}
                  highlights={highlightsApi.highlights}
                  onHighlightUpdate={highlightsApi.updateHighlight}
                  onHighlightDelete={highlightsApi.removeHighlight}
                />
              </Suspense>
            ) : chapter && (
              // `chapter && …` narrows chapter to non-null — reflow only renders
              // when the gate above has guaranteed a chapter exists.
              <>
                <ReaderSection
                  chapterId={chapter.id}
                  chapterIndex={chapter.chapterNumber}
                  html={chapter.html}
                  settings={settings}
                  onTap={() => { readingSession.recordActivity(); showImmersiveBars() }}
                />
                <ReaderNav
                  chapterTitle={chapter.title}
                  // Positional 1-based index — catalog chapterNumber is 0-based
                  // (0..N-1) but user-books are 1-based, so it's unreliable for
                  // display. Mirror ReaderFooterNav's currentChapterIndex + 1.
                  chapterNumber={currentChapterIndex >= 0 ? currentChapterIndex + 1 : null}
                  totalChapters={totalChapters || null}
                  chapterProgress={overlayScrollProgress}
                  onPrev={chapter.prev ? () => { flushProgress(); navigate(getChapterUrl(chapter.prev!.identifier)) } : null}
                  onNext={chapter.next ? () => { flushProgress(); navigate(getChapterUrl(chapter.next!.identifier)) } : null}
                />
              </>
            )}
          </div>
          {searchOpen && !originalActive && (
            <SearchOverlayLayer
              containerRef={scrollContainerRef}
              query={searchQuery}
              activeMatchIndex={activeMatchIndex}
            />
          )}
        </ReaderHighlights>
      </main>

      {settings.showReaderStats && (
        <ReaderStatsWidget
          sessionStartedAt={readingSession.sessionStartedAt}
          quickStats={quickStats}
          bookEtf={bookEtf?.formatted}
        />
      )}

      <ReaderFooterNav
        chapterTitle={activeChapter?.title || chapter?.title || book.title}
        overallProgress={overallProgress}
        currentChapterIndex={currentChapterIndex}
        totalChapters={totalChapters}
      />

      <ReaderTocDrawer
        open={tocOpen}
        chapters={book.chapters}
        currentChapterIdentifier={activeChapterIdentifier}
        bookmarks={bookmarks}
        highlights={highlightsApi.highlights}
        autoSave={autoSaveInfo}
        getChapterUrl={getChapterUrl}
        useLocalizedLink={mode === 'public'}
        onClose={() => setTocOpen(false)}
        onRemoveBookmark={removeBookmark}
        onHighlightSelect={(h) => { handleHighlightJump(h); setTocOpen(false) }}
        onBookmarkSelect={originalActive ? (bm) => {
          if (bm.page != null) setPdfScrollTo({ page: bm.page, nonce: Date.now() })
        } : undefined}
        onChapterSelect={(identifier) => {
          if (originalActive) {
            // Original mode: scroll the PDF to the chapter's page instead of routing.
            const ch = book.chapters.find(c => c.identifier === identifier)
            setPdfScrollTo({ page: ch?.sourceStartPage ?? 1, nonce: Date.now() })
            return
          }
          navigate(getChapterUrl(identifier) + '?direct=1')
        }}
      />

      <ReaderSettingsDrawer
        open={settingsOpen}
        settings={settings}
        onUpdate={update}
        onClose={() => setSettingsOpen(false)}
        originalMode={originalActive}
      />

      {askTarget && (
        <AskPanel
          open={askOpen}
          askTarget={askTarget}
          currentChapterId={activeChapter?.id}
          prefill={askPrefill}
          isAuthenticated={isAuthenticated}
          onSignIn={openAuthModal}
          onNavigateToCitation={handleNavigateToCitation}
          chapters={chapterList ?? undefined}
          onClose={() => setAskOpen(false)}
        />
      )}

      <ReaderSearchDrawer
        open={searchOpen}
        query={searchQuery}
        matches={searchMatches}
        activeMatchIndex={activeMatchIndex}
        onSearch={search}
        onGoToMatch={goToMatch}
        onNextMatch={nextMatch}
        onPrevMatch={prevMatch}
        onClose={() => {
          setSearchOpen(false)
          clearSearch()
        }}
      />

      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}

      {bookCompleted && (
        <div className="reader-complete-overlay" onClick={() => setBookCompleted(false)}>
          <div className="reader-complete" onClick={e => e.stopPropagation()}>
            <h2>You've finished this book</h2>
            <p className="reader-complete__title">{book.title}</p>
            <div className="reader-complete__actions">
              {mode === 'public' ? (
                <LocalizedLink to={backUrl} className="reader-complete__btn">
                  Back to Book
                </LocalizedLink>
              ) : (
                <Link to={backUrl} className="reader-complete__btn">
                  Back to Book
                </Link>
              )}
              <button
                className="reader-complete__btn reader-complete__btn--secondary"
                onClick={() => setBookCompleted(false)}
              >
                Keep Reading
              </button>
            </div>
          </div>
        </div>
      )}

      <WordHint containerRef={scrollContainerRef} />

    </div>
  )
}
