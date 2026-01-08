import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { useLanguage } from '../context/LanguageContext'
import type { Chapter, BookDetail } from '../types/api'
import { useReaderSettings } from '../hooks/useReaderSettings'
import { useAutoHideBar } from '../hooks/useAutoHideBar'
import { useReadingProgress } from '../hooks/useReadingProgress'
import { useBookmarks } from '../hooks/useBookmarks'
import { useInBookSearch } from '../hooks/useInBookSearch'
import { useFullscreen } from '../hooks/useFullscreen'
import { usePagination } from '../hooks/usePagination'
import { SeoHead } from '../components/SeoHead'
import { ReaderTopBar } from '../components/reader/ReaderTopBar'
import { ReaderContent } from '../components/reader/ReaderContent'
import { ReaderFooterNav } from '../components/reader/ReaderFooterNav'
import { ReaderPageNav } from '../components/reader/ReaderPageNav'
import { ReaderSettingsDrawer } from '../components/reader/ReaderSettingsDrawer'
import { ReaderTocDrawer } from '../components/reader/ReaderTocDrawer'
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

  // Refs for pagination
  const contentRef = useRef<HTMLElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const { settings, update } = useReaderSettings()
  const { visible, toggle } = useAutoHideBar()
  const { scrollPercent } = useReadingProgress(bookSlug || '', chapterSlug || '')
  const { bookmarks, addBookmark, removeBookmark, isBookmarked, getBookmarkForChapter } = useBookmarks(bookSlug || '')
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen()

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

  // Fetch chapter and book data
  useEffect(() => {
    if (!bookSlug || !chapterSlug) return
    let cancelled = false

    setLoading(true)
    setError(null)

    Promise.all([
      api.getChapter(bookSlug, chapterSlug),
      api.getBook(bookSlug),
    ])
      .then(([ch, bk]) => {
        if (cancelled) return
        setChapter(ch)
        setBook(bk)
        // Reset to first page on chapter change
        goToPage(0)
      })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [bookSlug, chapterSlug, api, goToPage])

  // Recalculate pagination when settings change
  useEffect(() => {
    recalculate()
  }, [settings, recalculate])

  // Reset to first page when chapter content changes
  useEffect(() => {
    if (!chapterHtml) return
    // Reset transform immediately
    if (contentRef.current) {
      contentRef.current.style.transform = 'translateX(0)'
    }
    // Wait for CSS columns to settle, then recalculate and go to page 0
    const timer = setTimeout(() => {
      recalculate()
      goToPage(0)
    }, 100)
    return () => clearTimeout(timer)
  }, [chapterHtml, recalculate, goToPage])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (tocOpen) setTocOpen(false)
        if (settingsOpen) setSettingsOpen(false)
        if (searchOpen) {
          setSearchOpen(false)
          clearSearch()
        }
      } else if (e.key === 'ArrowLeft') {
        if (currentPage > 0) {
          prevPage()
        } else if (chapter?.prev) {
          navigate(getLocalizedPath(`/books/${bookSlug}/${chapter.prev.slug}`))
        }
      } else if (e.key === 'ArrowRight') {
        if (currentPage < totalPages - 1) {
          nextPage()
        } else if (chapter?.next) {
          navigate(getLocalizedPath(`/books/${bookSlug}/${chapter.next.slug}`))
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [bookSlug, chapter, navigate, getLocalizedPath, tocOpen, settingsOpen, searchOpen, clearSearch, currentPage, totalPages, prevPage, nextPage])

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

  return (
    <div className="reader-page">
      <SeoHead title={seoTitle} description={seoDescription} />
      <a href="#reader-content" className="skip-link">Skip to content</a>
      <ReaderTopBar
        visible={visible}
        bookSlug={bookSlug!}
        title={book.title}
        chapterTitle={chapter.title}
        progress={progress}
        isBookmarked={isBookmarked(chapterSlug!)}
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
          onTap={toggle}
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
      />

      <ReaderTocDrawer
        open={tocOpen}
        bookSlug={bookSlug!}
        chapters={book.chapters}
        currentChapterSlug={chapterSlug!}
        bookmarks={bookmarks}
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
    </div>
  )
}
