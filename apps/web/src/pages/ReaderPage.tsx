import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { useLanguage } from '../context/LanguageContext'
import type { Chapter, BookDetail } from '../types/api'
import { useReaderSettings } from '../hooks/useReaderSettings'
import { useAutoHideBar } from '../hooks/useAutoHideBar'
import { useReadingProgress } from '../hooks/useReadingProgress'
import { useRestoreProgress } from '../hooks/useRestoreProgress'
import { useBookmarks } from '../hooks/useBookmarks'
import { useInBookSearch } from '../hooks/useInBookSearch'
import { useFullscreen } from '../hooks/useFullscreen'
import { usePagination } from '../hooks/usePagination'
import { useSwipe } from '../hooks/useSwipe'
import { useLibrary } from '../hooks/useLibrary'
import { useIsMobile } from '../hooks/useIsMobile'
import { useNetworkRecovery } from '../hooks/useNetworkRecovery'
import { getCachedChapter, cacheChapter } from '../lib/offlineDb'
import { SeoHead } from '../components/SeoHead'
import { Toast } from '../components/Toast'
import { ReaderTopBar } from '../components/reader/ReaderTopBar'
import { ReaderContent } from '../components/reader/ReaderContent'
import { ReaderFooterNav } from '../components/reader/ReaderFooterNav'
import { ReaderPageNav } from '../components/reader/ReaderPageNav'
import { ReaderSettingsDrawer } from '../components/reader/ReaderSettingsDrawer'
import { ReaderTocDrawer, type AutoSaveInfo } from '../components/reader/ReaderTocDrawer'
import { ReaderSearchDrawer } from '../components/reader/ReaderSearchDrawer'

export function ReaderPage() {
  const { bookSlug, chapterSlug } = useParams<{ bookSlug: string; chapterSlug: string }>()
  const api = useApi()
  const { getLocalizedPath } = useLanguage()
  const navigate = useNavigate()
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [book, setBook] = useState<BookDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [tocOpen, setTocOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // Refs for pagination
  const contentRef = useRef<HTMLElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const { settings, update } = useReaderSettings()
  const { visible, toggle } = useAutoHideBar()
  const { bookmarks, addBookmark, removeBookmark, isBookmarked, getBookmarkForChapter } = useBookmarks(bookSlug || '')
  const { add: addToLibrary, isInLibrary } = useLibrary()
  const [scrollPercent, setScrollPercent] = useState(0)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [isAutoSaved, setIsAutoSaved] = useState(false)
  const firstAutoSaveRef = useRef(false)
  const libraryAddedRef = useRef(false)
  const editionIdRef = useRef<string | null>(null)
  const { markFetchStart, wasAbortedDueToWake } = useNetworkRecovery()
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen()
  const [showBarsInFullscreen, setShowBarsInFullscreen] = useState(false)
  const hideTimeoutRef = useRef<number | null>(null)

  // Mobile immersive mode
  const isMobile = useIsMobile()
  const [immersiveMode, setImmersiveMode] = useState(false)
  const immersiveTimerRef = useRef<number | null>(null)

  // Show bars on mouse move in fullscreen, hide after 2s
  const handleMouseMove = useCallback(() => {
    if (!isFullscreen) return
    setShowBarsInFullscreen(true)
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
    }
    hideTimeoutRef.current = window.setTimeout(() => {
      setShowBarsInFullscreen(false)
    }, 2000)
  }, [isFullscreen])

  useEffect(() => {
    if (isFullscreen) {
      window.addEventListener('mousemove', handleMouseMove)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
      }
    } else {
      setShowBarsInFullscreen(false)
    }
  }, [isFullscreen, handleMouseMove])

  // Mobile immersive mode: auto-hide after 3s, show on tap
  const startImmersiveTimer = useCallback(() => {
    if (!isMobile) return
    if (immersiveTimerRef.current) clearTimeout(immersiveTimerRef.current)
    immersiveTimerRef.current = window.setTimeout(() => {
      setImmersiveMode(true)
    }, 3000)
  }, [isMobile])

  const showBarsTemporarily = useCallback(() => {
    if (!isMobile) return
    setImmersiveMode(false)
    startImmersiveTimer()
  }, [isMobile, startImmersiveTimer])

  useEffect(() => {
    if (isMobile && !loading) {
      startImmersiveTimer()
    }
    return () => {
      if (immersiveTimerRef.current) clearTimeout(immersiveTimerRef.current)
    }
  }, [isMobile, loading, startImmersiveTimer])

  // Page-based pagination
  const {
    currentPage,
    totalPages,
    progress,
    pagesLeft,
    nextPage,
    prevPage,
    goToPage,
    recalculate,
  } = usePagination(contentRef, containerRef)

  // Handle autosave visual feedback
  const handleAutoSave = useCallback(() => {
    setIsAutoSaved(true)
    if (!firstAutoSaveRef.current) {
      firstAutoSaveRef.current = true
      setToastMessage('Auto-saved')
    }
  }, [])

  // Reading progress sync (with server when authenticated)
  const { updateProgress } = useReadingProgress(
    bookSlug || '',
    chapterSlug || '',
    { editionId: book?.id, chapterId: chapter?.id, chapterSlug: chapterSlug, onSave: handleAutoSave }
  )

  // Restore progress on mount
  const { savedProgress, shouldNavigate, targetChapterSlug, isLoading: progressLoading } =
    useRestoreProgress(book?.id, chapterSlug)

  // Auto-save info for bookmarks drawer
  const autoSaveInfo = useMemo((): AutoSaveInfo | null => {
    if (!book?.id || !book?.chapters) return null
    try {
      const stored = localStorage.getItem(`reading.progress.${book.id}`)
      if (!stored) return null
      const data = JSON.parse(stored) as { chapterSlug: string; locator: string; percent: number }
      if (!data.chapterSlug) return null
      const chapter = book.chapters.find(c => c.slug === data.chapterSlug)
      if (!chapter) return null
      return {
        chapterSlug: data.chapterSlug,
        chapterTitle: chapter.title,
        locator: data.locator,
        percent: data.percent,
      }
    } catch {
      return null
    }
  }, [book?.id, book?.chapters, isAutoSaved]) // isAutoSaved triggers re-read after save

  // Refs for restore logic
  const hasNavigatedRef = useRef(false)
  const restoredRef = useRef(false)

  // Calculate overall book progress based on word counts
  const overallProgress = useMemo(() => {
    if (!book || !chapterSlug || totalPages === 0) return 0

    const chapters = book.chapters
    const currentChapterIndex = chapters.findIndex(c => c.slug === chapterSlug)
    if (currentChapterIndex === -1) return 0

    // Calculate using word counts for accuracy
    const totalWords = chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0)
    if (totalWords === 0) {
      // Fallback to chapter-based if no word counts
      return (currentChapterIndex + progress) / chapters.length
    }

    const wordsBeforeCurrent = chapters
      .slice(0, currentChapterIndex)
      .reduce((sum, c) => sum + (c.wordCount || 0), 0)
    const currentChapterWords = chapters[currentChapterIndex].wordCount || 0
    const wordsRead = wordsBeforeCurrent + currentChapterWords * progress

    return wordsRead / totalWords
  }, [book, chapterSlug, progress, totalPages])

  // Sync progress when page changes
  useEffect(() => {
    if (totalPages > 0 && book?.id && chapter?.id) {
      updateProgress(overallProgress, currentPage)
    }
  }, [currentPage, totalPages, overallProgress, book?.id, chapter?.id, updateProgress])

  // Auto-add to library after page 2 or 1% progress (for single-page chapters)
  useEffect(() => {
    if (!book?.id || libraryAddedRef.current) return
    // Trigger on page 2 OR 1% overall progress (handles single-page chapters)
    if (currentPage < 1 && overallProgress < 0.01) return
    if (isInLibrary(book.id)) {
      libraryAddedRef.current = true
      return
    }
    libraryAddedRef.current = true
    addToLibrary(book.id)
      .then(() => setToastMessage('Added to library'))
      .catch(() => {}) // silent fail
  }, [currentPage, overallProgress, book?.id, isInLibrary, addToLibrary])

  // Navigate to saved chapter if different from current
  useEffect(() => {
    if (shouldNavigate && targetChapterSlug && !hasNavigatedRef.current) {
      hasNavigatedRef.current = true
      navigate(getLocalizedPath(`/books/${bookSlug}/${targetChapterSlug}`), { replace: true })
    }
  }, [shouldNavigate, targetChapterSlug, bookSlug, navigate, getLocalizedPath])

  // Restore page position after pagination is ready
  useEffect(() => {
    // Wait for: pagination ready, progress loaded, book data available
    const bookReady = !!book?.id
    if (restoredRef.current || totalPages === 0 || progressLoading || shouldNavigate || !bookReady) return

    restoredRef.current = true

    // No saved progress - go to page 0
    if (!savedProgress) {
      goToPage(0)
      return
    }

    // Restore to saved position
    const { locator } = savedProgress
    if (locator.startsWith('page:')) {
      const page = parseInt(locator.split(':')[1], 10)
      if (!isNaN(page)) goToPage(Math.min(page, totalPages - 1))
    } else if (locator.startsWith('percent:')) {
      const pct = parseFloat(locator.split(':')[1])
      if (!isNaN(pct)) goToPage(Math.floor(pct * (totalPages - 1)))
    }
  }, [totalPages, savedProgress, progressLoading, shouldNavigate, goToPage, book?.id])

  // Reset restore refs on chapter change
  useEffect(() => {
    restoredRef.current = false
    hasNavigatedRef.current = false
  }, [chapterSlug])

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

  // Fetch chapter and book data (cache-first)
  useEffect(() => {
    if (!bookSlug || !chapterSlug) return
    let cancelled = false
    markFetchStart()

    const fetchData = async () => {
      setLoading(true)
      setError(null)

      try {
        // Try cache first if we have editionId
        const cachedEditionId = editionIdRef.current
        if (cachedEditionId) {
          const cached = await getCachedChapter(cachedEditionId, chapterSlug)
          if (cached && !cancelled) {
            setChapter({
              id: cached.key,
              chapterNumber: 0,
              slug: cached.chapterSlug,
              title: cached.title,
              html: cached.html,
              wordCount: cached.wordCount,
              prev: cached.prev,
              next: cached.next,
            })
            // Still need book for TOC - fetch it
            try {
              const bk = await api.getBook(bookSlug)
              if (!cancelled) setBook(bk)
            } catch {
              // Book fetch failed but chapter from cache - ok
            }
            setLoading(false)
            return
          }
        }

        // Cache miss or no editionId - fetch from API
        const [ch, bk] = await Promise.all([
          api.getChapter(bookSlug, chapterSlug),
          api.getBook(bookSlug),
        ])

        if (cancelled) return

        setChapter(ch)
        setBook(bk)
        editionIdRef.current = bk.id

        // Cache for offline use
        cacheChapter(bk.id, ch).catch(() => {})
      } catch (err) {
        if (cancelled) return
        // If aborted due to wake, auto-retry
        if (wasAbortedDueToWake()) {
          fetchData()
          return
        }
        setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchData()
    return () => { cancelled = true }
  }, [bookSlug, chapterSlug, api, markFetchStart, wasAbortedDueToWake])

  // Recalculate pagination when settings change
  useEffect(() => {
    recalculate()
  }, [settings, recalculate])

  // Recalculate pagination when chapter content changes
  useEffect(() => {
    if (!chapterHtml) return
    // Reset transform immediately
    if (contentRef.current) {
      contentRef.current.style.transform = 'translateX(0)'
    }
    // Wait for CSS columns to settle, then recalculate (page position handled by restore effect)
    const timer = setTimeout(() => {
      recalculate()
    }, 100)
    return () => clearTimeout(timer)
  }, [chapterHtml, recalculate])

  // Track scroll position for mobile progress bar
  useEffect(() => {
    const handleScroll = () => {
      const scrollTop = window.scrollY
      const docHeight = document.documentElement.scrollHeight - window.innerHeight
      if (docHeight > 0) {
        setScrollPercent(scrollTop / docHeight)
      }
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip when typing in input
      if (e.target instanceof HTMLInputElement) return

      const key = e.key.toLowerCase()

      // Escape - close drawers
      if (e.key === 'Escape') {
        if (shortcutsOpen) setShortcutsOpen(false)
        if (tocOpen) setTocOpen(false)
        if (settingsOpen) setSettingsOpen(false)
        if (searchOpen) {
          setSearchOpen(false)
          clearSearch()
        }
        return
      }

      // Arrow navigation
      if (e.key === 'ArrowLeft') {
        if (currentPage > 0) {
          prevPage()
        } else if (chapter?.prev) {
          navigate(getLocalizedPath(`/books/${bookSlug}/${chapter.prev.slug}`))
        }
        return
      }
      if (e.key === 'ArrowRight') {
        if (currentPage < totalPages - 1) {
          nextPage()
        } else if (chapter?.next) {
          navigate(getLocalizedPath(`/books/${bookSlug}/${chapter.next.slug}`))
        }
        return
      }

      // Feature shortcuts
      switch (key) {
        case 'f':
          toggleFullscreen()
          break
        case 's':
        case '/':
          e.preventDefault()
          setSearchOpen(true)
          break
        case 't':
          setTocOpen(true)
          break
        case 'b':
          if (chapterSlug) {
            const bookmark = getBookmarkForChapter(chapterSlug)
            if (bookmark) {
              removeBookmark(bookmark.id)
            } else if (chapter) {
              addBookmark(chapterSlug, chapter.title)
            }
          }
          break
        case ',':
          setSettingsOpen(true)
          break
        case '+':
        case '=':
          if (settings.fontSize < 28) update({ fontSize: settings.fontSize + 2 })
          break
        case '-':
          if (settings.fontSize > 14) update({ fontSize: settings.fontSize - 2 })
          break
        case '1':
          update({ theme: 'light' })
          break
        case '2':
          update({ theme: 'sepia' })
          break
        case '3':
          update({ theme: 'dark' })
          break
        case '4':
          update({ theme: 'high-contrast' })
          break
        case '?':
          setShortcutsOpen(o => !o)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [bookSlug, chapterSlug, chapter, navigate, getLocalizedPath, tocOpen, settingsOpen, searchOpen, shortcutsOpen, clearSearch, currentPage, totalPages, prevPage, nextPage, toggleFullscreen, settings, update, getBookmarkForChapter, removeBookmark, addBookmark])

  // Handle next page click - go to next chapter if at end
  const handleNextPage = () => {
    if (currentPage < totalPages - 1) {
      nextPage()
    } else if (chapter?.next) {
      navigate(getLocalizedPath(`/books/${bookSlug}/${chapter.next.slug}`))
    }
  }

  // Handle prev page click - go to prev chapter if at start
  const handlePrevPage = () => {
    if (currentPage > 0) {
      prevPage()
    } else if (chapter?.prev) {
      navigate(getLocalizedPath(`/books/${bookSlug}/${chapter.prev.slug}`))
    }
  }

  // Swipe navigation - disabled on mobile (use tap zones instead)
  useSwipe({
    onSwipeLeft: handleNextPage,
    onSwipeRight: handlePrevPage,
    threshold: 50,
    enabled: !isMobile && !tocOpen && !settingsOpen && !searchOpen,
  })

  if (loading) {
    return (
      <div className="reader-loading">
        <div className="reader-loading__skeleton" />
        <div className="reader-loading__skeleton" />
        <div className="reader-loading__skeleton" />
      </div>
    )
  }

  if (error || !chapter || !book) {
    return (
      <div className="reader-error">
        <h2>Error loading chapter</h2>
        <p>{error || 'Chapter not found'}</p>
      </div>
    )
  }

  const seoTitle = `${chapter.title} — ${book.title}`
  const seoDescription = `Read ${chapter.title} from ${book.title} online | TextStack`

  const fullscreenClass = isFullscreen ? (showBarsInFullscreen ? 'fullscreen-bars-visible' : 'fullscreen-bars-hidden') : ''
  const immersiveClass = immersiveMode ? 'immersive-mode' : ''

  return (
    <div className={`reader-page ${fullscreenClass} ${immersiveClass}`}>
      {/* noindex: chapters are reading UX only, not search-worthy content */}
      <SeoHead title={seoTitle} description={seoDescription} noindex />
      <a href="#reader-content" className="skip-link">Skip to content</a>
      <ReaderTopBar
        visible={visible}
        bookSlug={bookSlug!}
        title={book.title}
        chapterTitle={chapter.title}
        progress={overallProgress}
        isBookmarked={isBookmarked(chapterSlug!)}
        isAutoSaved={isAutoSaved}
        isFullscreen={isFullscreen}
        onSearchClick={() => setSearchOpen(true)}
        onTocClick={() => setTocOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        onBookmarkClick={() => {
          const bookmark = getBookmarkForChapter(chapterSlug!)
          if (bookmark) {
            removeBookmark(bookmark.id)
          } else {
            addBookmark(chapterSlug!, chapter.title)
          }
        }}
        onFullscreenClick={toggleFullscreen}
        onHelpClick={() => setShortcutsOpen(true)}
      />

      <ReaderPageNav
        direction="prev"
        disabled={currentPage === 0 && !chapter.prev}
        onClick={handlePrevPage}
      />

      <main id="reader-content" className="reader-main">
        <ReaderContent
          ref={contentRef}
          containerRef={containerRef}
          html={chapter.html}
          settings={settings}
          onTap={() => { toggle(); showBarsTemporarily(); }}
          onDoubleTap={toggleFullscreen}
          onLeftTap={isMobile ? handlePrevPage : undefined}
          onRightTap={isMobile ? handleNextPage : undefined}
        />
      </main>

      <ReaderPageNav
        direction="next"
        disabled={currentPage === totalPages - 1 && !chapter.next}
        onClick={handleNextPage}
      />

      <ReaderFooterNav
        bookSlug={bookSlug!}
        chapterTitle={chapter.title}
        prev={chapter.prev}
        next={chapter.next}
        progress={progress}
        pagesLeft={pagesLeft}
        currentPage={currentPage + 1}
        totalPages={totalPages}
        scrollPercent={scrollPercent}
        overallProgress={overallProgress}
      />

      <ReaderTocDrawer
        open={tocOpen}
        bookSlug={bookSlug!}
        chapters={book.chapters}
        currentChapterSlug={chapterSlug!}
        bookmarks={bookmarks}
        autoSave={autoSaveInfo}
        onClose={() => setTocOpen(false)}
        onRemoveBookmark={removeBookmark}
      />

      <ReaderSettingsDrawer
        open={settingsOpen}
        settings={settings}
        onUpdate={update}
        onClose={() => setSettingsOpen(false)}
      />

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

      {shortcutsOpen && (
        <>
          <div className="reader-drawer-backdrop" onClick={() => setShortcutsOpen(false)} />
          <div className="reader-shortcuts-modal">
            <div className="reader-shortcuts-modal__header">
              <h3>Keyboard Shortcuts</h3>
              <button onClick={() => setShortcutsOpen(false)} className="reader-shortcuts-modal__close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="reader-shortcuts-modal__content">
              <div className="reader-shortcuts-modal__group">
                <h4>Navigation</h4>
                <div className="reader-shortcuts-modal__item"><kbd>←</kbd><span>Previous page</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>→</kbd><span>Next page</span></div>
              </div>
              <div className="reader-shortcuts-modal__group">
                <h4>Panels</h4>
                <div className="reader-shortcuts-modal__item"><kbd>S</kbd> or <kbd>/</kbd><span>Search</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>T</kbd><span>Table of contents</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>,</kbd><span>Settings</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>Esc</kbd><span>Close panel</span></div>
              </div>
              <div className="reader-shortcuts-modal__group">
                <h4>Actions</h4>
                <div className="reader-shortcuts-modal__item"><kbd>F</kbd><span>Fullscreen</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>B</kbd><span>Bookmark</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>+</kbd><span>Increase font</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>-</kbd><span>Decrease font</span></div>
              </div>
              <div className="reader-shortcuts-modal__group">
                <h4>Themes</h4>
                <div className="reader-shortcuts-modal__item"><kbd>1</kbd><span>Light</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>2</kbd><span>Sepia</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>3</kbd><span>Dark</span></div>
                <div className="reader-shortcuts-modal__item"><kbd>4</kbd><span>High contrast</span></div>
              </div>
            </div>
          </div>
        </>
      )}

      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
    </div>
  )
}
