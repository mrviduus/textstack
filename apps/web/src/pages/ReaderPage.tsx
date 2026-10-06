import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useReaderSettings } from '../hooks/useReaderSettings'
import { useReaderChapter, type ReaderMode } from '../hooks/useReaderChapter'
import { useReaderProgress } from '../hooks/useReaderProgress'
import { useReaderBookmarks } from '../hooks/useReaderBookmarks'
import { useImmersiveMode } from '../hooks/useImmersiveMode'
import { useTranslation } from '../hooks/useTranslation'
import { useReaderPdfOriginal } from '../hooks/useReaderPdfOriginal'
import { useReaderBookProgress } from '../hooks/useReaderBookProgress'
import { useReaderSessionTracking } from '../hooks/useReaderSessionTracking'
import { useReaderPositionSync } from '../hooks/useReaderPositionSync'
import { useReaderDrawers } from '../hooks/useReaderDrawers'
import { useReaderLibraryTracking } from '../hooks/useReaderLibraryTracking'
import { useReaderReviews } from '../hooks/useReaderReviews'
import { SeoHead } from '../components/SeoHead'
import { Toast } from '../components/Toast'
import { ReaderTopBar } from '../components/reader/ReaderTopBar'
import { ReaderReflowChapter } from '../components/reader/ReaderReflowChapter'
import { ReaderOriginalPdf } from '../components/reader/ReaderOriginalPdf'
import { ReaderFooterNav } from '../components/reader/ReaderFooterNav'
import { ReaderDrawers } from '../components/reader/ReaderDrawers'
import { ReaderLoadingScreen, ReaderErrorScreen } from '../components/reader/ReaderScreens'
import { ReaderHighlights } from '../components/reader/ReaderHighlights'
import { ReaderCompleteOverlay } from '../components/reader/ReaderCompleteOverlay'
import { chapterForHighlight } from '../lib/textAnchor'
import { SearchOverlayLayer } from '../components/reader/SearchOverlayLayer'
import { ReaderStatsWidget } from '../components/reader/ReaderStatsWidget'
import { WordHint } from '../components/reader/WordHint'
import { useHighlights } from '../hooks/useHighlights'
import { ReviewedMarksContext } from '../components/reader/ReviewedMarks'
import type { StoredHighlight } from '../lib/offlineDb'
import { sourceDomain } from '../components/library/ReadLaterShelf'
import '../styles/micro-practice.css'

export type { ReaderMode } from '../hooks/useReaderChapter'

interface ReaderPageProps {
  mode?: ReaderMode
}

// The page wires the reader's jobs (one hook each: useReaderPdfOriginal, useReaderBookProgress,
// useReaderSessionTracking, useReaderPositionSync, useReaderDrawers). Each feeds the next; keep the order.
export function ReaderPage({ mode = 'public' }: ReaderPageProps) {
  // Get params based on mode - both modes now use slug
  const { bookSlug, chapterSlug, id, chapterSlug: userChapterSlug } = useParams<{
    bookSlug: string
    chapterSlug: string
    id: string
  }>()

  // For userbook mode, chapterSlug comes from the :chapterSlug param
  const chapterIdentifier = mode === 'public' ? chapterSlug : userChapterSlug

  const { isAuthenticated, isLoading: authLoading, user, isGuest } = useAuth()
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

  // Highlight ID from URL — scroll to this highlight after chapter loads
  // Live, not read once at mount: a drawer jump to another chapter adds it by
  // SPA navigation. Removed once the link is resolved, so Back / reload restore normally.
  const location = useLocation()
  const scrollToHighlightId = new URLSearchParams(location.search).get('highlight')

  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const { settings, update } = useReaderSettings()

  const bookmarksApi = useReaderBookmarks({
    mode, bookSlug, userBookId: id, publicEditionId: publicBook?.id, publicChapter, book, isAuthenticated,
    userId: user?.id, isGuest,
  })
  const { error: bookmarkError, clearError: clearBookmarkError } = bookmarksApi
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [bookCompleted, setBookCompleted] = useState(false)
  useEffect(() => {
    if (!bookmarkError) return
    setToastMessage(t('reader.bookmarkFailed'))
    clearBookmarkError()
  }, [bookmarkError, clearBookmarkError, t])

  // There is deliberately NO guest pre-warm here. Opening a chapter used to mint
  // one (ead5f446, 2026-04-19) so that the first word tap would not race
  // `ensureSession` mid-popup — a flip of `isAuthenticated` re-ran the
  // chapter-fetch effect and dropped the popup. That race was fixed at its own
  // source a week later: `useReaderChapter` skips a refetch whose key it has
  // already loaded (6b1c1d17). The pre-warm has been redundant ever since, and
  // it was not free.
  //
  // A *render* is not a commitment. Every client that executes JS on a chapter
  // URL got a real `User` row, and the reader's progress write immediately made
  // that row permanent — `GuestCleanupWorker` spares any guest holding progress.
  // Undeclared crawlers walking the catalogue with rotating desktop-Chrome user
  // agents produced 7,147 of the 7,263 guest accounts on production; 5,600 of
  // them lived under five seconds and hold exactly one progress row each.
  //
  // So the mint is back where ADR-014 put it: a commitment signal. On this page
  // that is the first word tap (`useReaderVocabulary`), which calls
  // `ensureSession` itself. Until then an anonymous reader's progress goes to
  // localStorage and `flushLocalProgress` delivers it the moment a session
  // exists. Do not re-add a mint on mount.

  const { immersiveMode, showBars: showImmersiveBars } = useImmersiveMode(true, loading)

  const activeChapterIdentifier = chapterIdentifier || ''
  const activeChapter = book?.chapters.find(c => c.identifier === activeChapterIdentifier)

  // Single hoisted highlights hook for the whole reader — shared by the reflow
  // path (down into ReaderHighlights → useHighlightEdit as props), the PDF
  // Original-layout subtree (paint + edit), the SelectionToolbar (create), and
  // the TOC drawer's Highlights tab. One useHighlights instance = one IndexedDB
  // + server load (previously PDF mode double-loaded: here + inside ReaderHighlights).
  const highlightsApi = useHighlights(
    mode === 'userbook' ? undefined : book?.id,
    mode === 'userbook' ? id : undefined,
    { isAuthenticated, chapters: book?.chapters },
  )
  // Reviewed-highlight badges + end-of-chapter Discuss.
  const { reviewTarget, chapterReviews, reviewedMarks } = useReaderReviews({ mode, isAuthenticated, id, editionId: book?.id, bookSlug })

  const progress = useReaderProgress({ mode, bookSlug, chapterSlug, userBookId: id, publicBook, publicChapter, book })
  const { userProgress, autoSaveInfo } = progress

  // Chapter URL helper
  const getChapterUrl = useCallback((identifier: string) => {
    if (mode === 'public') {
      return getLocalizedPath(`/books/${bookSlug}/${identifier}`)
    }
    return `/${language}/library/my/${id}/read/${identifier}`
  }, [mode, bookSlug, id, language, getLocalizedPath])

  const pdf = useReaderPdfOriginal({
    mode, id, book, chapter, activeChapter, highlightsApi, scrollToHighlightId, userProgress,
    authLoading, isAuthenticated, navigate, getChapterUrl,
  })
  const { originalActive, pdfCurrentPage, setPdfScrollTo, scrollToHl, handleHighlightJump, handlePdfHighlight } = pdf

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

  const { overlayScrollProgress, overallProgress, totalChapters, currentChapterIndex } = useReaderBookProgress({
    mode, publicBook, book, chapterIdentifier, chapterId: chapter?.id, bookCompleted,
  })

  const { readingSession, quickStats, bookEtf, onReaderScroll } = useReaderSessionTracking({
    mode, id, publicBook, book, overallProgress, isAuthenticated, language,
  })

  const { flushProgress, captureBeforeReflow, highlightLinkReady, handleHighlightLinkDone } = useReaderPositionSync({
    mode, publicBook, chapter, chapterIdentifier, loading, originalActive, overallProgress, progress, settings,
    scrollToHighlightId, highlightsLoaded: highlightsApi.loaded, authLoading, onReaderScroll, location, navigate,
  })

  useReaderLibraryTracking({
    mode, book, bookSlug, chapterIdentifier, isAuthenticated, overallProgress, showToast: setToastMessage,
  })

  // Search hook needs chapter html, use empty string until loaded
  const drawers = useReaderDrawers(chapter?.html || '')
  const { setTocOpen, setSettingsOpen, searchOpen, setSearchOpen } = drawers

  // Drawer jump to a reflow highlight in a chapter the reader hasn't mounted
  // (one-chapter-at-a-time). Resolve its chapter id → slug and route there;
  // useHighlightEdit re-runs the scroll once the new chapter's DOM lands.
  // Same chapter key the overlay paints by (anchor id, else the row's chapterId /
  // userChapterId — mobile anchors carry none). An orphan has nowhere to go.
  const handleHighlightNavigate = useCallback((h: StoredHighlight) => {
    const target = chapterForHighlight(book?.chapters, h)
    if (!target || target.identifier === activeChapterIdentifier) return
    flushProgress()
    navigate(`${getChapterUrl(target.identifier)}?highlight=${encodeURIComponent(h.id)}`)
  }, [book?.chapters, activeChapterIdentifier, flushProgress, navigate, getChapterUrl])

  // Back URL
  const backUrl = mode === 'public'
    ? `/books/${bookSlug}`
    : `/${language}/library/my/${id}`

  // Auth check for userbook mode
  if (mode === 'userbook' && !isAuthenticated) {
    return (
      <ReaderErrorScreen seoTitle="Reader" heading="Sign in required" body="Sign in to read your uploaded books."
        linkTo={`/${language}/library`} linkText="Back to Library" />
    )
  }

  if (loading) return <ReaderLoadingScreen />

  // Corrupt/unopenable PDF with no chapters to fall back to (S1b) — a dedicated
  // screen, NOT the generic chapter-error, offering re-upload / retry.
  if (pdf.pdfUnopenable && book) {
    return (
      <ReaderErrorScreen
        seoTitle={t('reader.originalLayout.cantOpenTitle')}
        heading={t('reader.originalLayout.cantOpenTitle')}
        body={t('reader.originalLayout.cantOpenBody')}
        linkTo={`/${language}/library/my/${id}`}
        linkText={t('reader.originalLayout.cantOpenCta')}
      />
    )
  }

  // Error only when the book itself is missing, OR reflow genuinely needs a
  // chapter it doesn't have. A chapterless Original-layout PDF renders fine.
  if (error || !book || (!chapter && !originalActive)) {
    return (
      <ReaderErrorScreen seoTitle="Error" heading="Error loading chapter" body={error || 'Chapter not found'}
        linkTo={mode === 'public' ? '/' : `/${language}/library/my/${id}`}
        linkText={mode === 'public' ? 'Back to Home' : 'Back to Book'}
        localizedLink={mode === 'public'} />
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
    <ReviewedMarksContext.Provider value={reviewedMarks}>
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
        isBookmarked={originalActive ? bookmarksApi.isPageBookmarked(pdfCurrentPage) : bookmarksApi.isBookmarked(activeChapterIdentifier)}
        backUrl={backUrl}
        sourceUrl={mode === 'userbook' ? book.sourceUrl ?? null : null}
        sourceDomain={mode === 'userbook' ? sourceDomain(book.sourceUrl ?? null) : null}
        useLocalizedLink={mode === 'public'}
        // In-chapter search is reflow-DOM based; the PDF canvas has no page-aware
        // search yet, so hide the button rather than open a no-op (follow-up).
        showSearch={!originalActive}
        // Original PDF has no word-based progress (session is time-only → 0%);
        // the footer page indicator (N / total) is the real progress. Hide the % here.
        showProgress={!originalActive}
        onSearchClick={() => setSearchOpen(true)}
        onTocClick={() => setTocOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        onBookmarkClick={() => {
          if (originalActive) {
            // Toggle a bookmark on the CURRENT PDF page.
            const existing = bookmarksApi.getPageBookmark(pdfCurrentPage)
            if (existing) bookmarksApi.removeBookmark(existing.id)
            else bookmarksApi.addPageBookmark(pdfCurrentPage)
            return
          }
          const bookmark = bookmarksApi.getBookmarkForChapter(activeChapterIdentifier)
          if (bookmark) {
            bookmarksApi.removeBookmark(bookmark.id)
          } else if (activeChapter) {
            bookmarksApi.addBookmark(activeChapterIdentifier, activeChapter.title)
          }
        }}
      />

      <main id="reader-content" className="reader-main">
        <ReaderHighlights
          editionId={book?.id || ''}
          // The rendered chapter first: the URL's chapter changes before its
          // content lands, and highlights re-map when this changes.
          chapterId={chapter?.id || activeChapter?.id || ''}
          containerRef={scrollContainerRef}
          isAuthenticated={isAuthenticated}
          bookLanguage={publicBook?.language}
          bookTitle={book?.title}
          userBookId={mode === 'userbook' ? id : undefined}
          ttsSpeed={settings.ttsSpeed}
          showInlineTranslations={settings.showInlineTranslations}
          scrollToHighlightId={scrollToHighlightId}
          highlightLinkReady={highlightLinkReady}
          onHighlightLinkDone={handleHighlightLinkDone}
          scrollToHl={scrollToHl}
          onNavigateToHighlight={handleHighlightNavigate}
          highlights={highlightsApi.highlights}
          addHighlight={highlightsApi.addHighlight}
          updateHighlight={highlightsApi.updateHighlight}
          removeHighlight={highlightsApi.removeHighlight}
          liveActionsOnly={originalActive}
          onPdfHighlight={originalActive ? handlePdfHighlight : undefined}
        >
          <div ref={scrollContainerRef}>
            {originalActive ? (
              // Text layers render inside scrollContainerRef, so the same
              // useTextSelection pipeline (translate/explain/TTS/vocab) works
              // over the PDF text with no changes to the selection components.
              <ReaderOriginalPdf
                pdf={pdf}
                bookId={id!}
                resumeUnanswered={userProgress.serverUnanswered}
                onActivity={() => readingSession.recordActivity()}
                highlightsApi={highlightsApi}
              />
            ) : chapter && (
              // `chapter && …` narrows chapter to non-null — reflow only renders
              // when the gate above has guaranteed a chapter exists.
              <ReaderReflowChapter
                chapter={chapter}
                settings={settings}
                onTap={() => { readingSession.recordActivity(); showImmersiveBars() }}
                discuss={reviewTarget && {
                  reviewed: chapterReviews.has(chapter.identifier),
                  reviewPath: reviewedMarks.reviewPath(chapter.identifier),
                  bookTitle: book?.title ?? '',
                  author: publicBook?.authors.map(a => a.name).join(', ') || null,
                  book: mode === 'userbook' ? { bookId: id } : { editionId: book?.id, slug: bookSlug },
                }}
                // Positional 1-based index — catalog chapterNumber is 0-based
                // (0..N-1) but user-books are 1-based, so it's unreliable for
                // display. Mirror ReaderFooterNav's currentChapterIndex + 1.
                chapterNumber={currentChapterIndex >= 0 ? currentChapterIndex + 1 : null}
                totalChapters={totalChapters || null}
                chapterProgress={overlayScrollProgress}
                onGoTo={(identifier) => { flushProgress(); navigate(getChapterUrl(identifier)) }}
                onFinish={() => setBookCompleted(true)}
                finishLabel={t('reader.finishBook')}
              />
            )}
          </div>
          {searchOpen && !originalActive && (
            <SearchOverlayLayer
              containerRef={scrollContainerRef}
              query={drawers.search.query}
              activeMatchIndex={drawers.search.activeMatchIndex}
            />
          )}
        </ReaderHighlights>
      </main>

      {settings.showReaderStats && (
        <ReaderStatsWidget
          sessionStartedAt={readingSession.sessionStartedAt}
          quickStats={quickStats}
          bookEtf={bookEtf}
        />
      )}

      <ReaderFooterNav
        chapterTitle={activeChapter?.title || chapter?.title || book.title}
        overallProgress={overallProgress}
        currentChapterIndex={currentChapterIndex}
        totalChapters={totalChapters}
      />

      <ReaderDrawers
        drawers={drawers}
        toc={{
          chapters: book.chapters,
          currentChapterIdentifier: activeChapterIdentifier,
          bookmarks: bookmarksApi.bookmarks,
          highlights: highlightsApi.highlights,
          autoSave: autoSaveInfo,
          getChapterUrl,
          useLocalizedLink: mode === 'public',
          onRemoveBookmark: bookmarksApi.removeBookmark,
          onHighlightSelect: (h) => { handleHighlightJump(h); setTocOpen(false) },
          onBookmarkSelect: originalActive ? (bm) => {
            if (bm.page != null) setPdfScrollTo({ page: bm.page, nonce: Date.now() })
          } : undefined,
          onChapterSelect: (identifier) => {
            if (originalActive) {
              // Original mode: scroll the PDF to the chapter's page instead of routing.
              const ch = book.chapters.find(c => c.identifier === identifier)
              setPdfScrollTo({ page: ch?.sourceStartPage ?? 1, nonce: Date.now() })
              return
            }
            navigate(getChapterUrl(identifier) + '?direct=1')
          },
        }}
        settings={settings}
        onSettingsUpdate={(patch) => { captureBeforeReflow(); update(patch) }}
        originalMode={originalActive}
      />

      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}

      {bookCompleted && (
        <ReaderCompleteOverlay
          bookTitle={book.title}
          backUrl={backUrl}
          useLocalizedLink={mode === 'public'}
          onClose={() => setBookCompleted(false)}
        />
      )}

      <WordHint containerRef={scrollContainerRef} />

    </div>
    </ReviewedMarksContext.Provider>
  )
}
