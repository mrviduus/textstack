import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import type { Chapter, BookDetail } from '../types/api'
import { getUserBook, getUserBookChapter } from '../api/userBooks'
import { useReaderSettings } from '../hooks/useReaderSettings'
import { useAutoHideBar } from '../hooks/useAutoHideBar'
import { useReadingProgress } from '../hooks/useReadingProgress'
import { useRestoreProgress } from '../hooks/useRestoreProgress'
import { useUserBookProgress } from '../hooks/useUserBookProgress'
import { useBookmarks } from '../hooks/useBookmarks'
import { useUserBookBookmarks } from '../hooks/useUserBookBookmarks'
import { useInBookSearch } from '../hooks/useInBookSearch'
import { useFullscreen } from '../hooks/useFullscreen'
import { usePagination } from '../hooks/usePagination'
import { useSwipe } from '../hooks/useSwipe'
import { useLibrary } from '../hooks/useLibrary'
import { useIsMobile } from '../hooks/useIsMobile'
import { useNetworkRecovery } from '../hooks/useNetworkRecovery'
import { useReaderKeyboard } from '../hooks/useReaderKeyboard'
import { useReaderNavigation } from '../hooks/useReaderNavigation'
import { useFullscreenBars } from '../hooks/useFullscreenBars'
import { useImmersiveMode } from '../hooks/useImmersiveMode'
import { getCachedChapter, cacheChapter } from '../lib/offlineDb'
import { InvalidContentTypeError } from '../lib/fetchWithRetry'
import { SeoHead } from '../components/SeoHead'
import { LocalizedLink } from '../components/LocalizedLink'
import { Toast } from '../components/Toast'
import { ReaderTopBar } from '../components/reader/ReaderTopBar'
import { ReaderContent } from '../components/reader/ReaderContent'
import { ScrollReaderContent } from '../components/reader/ScrollReaderContent'
import { ReaderFooterNav } from '../components/reader/ReaderFooterNav'
import { ReaderPageNav } from '../components/reader/ReaderPageNav'
import { ReaderSettingsDrawer } from '../components/reader/ReaderSettingsDrawer'
import { ReaderTocDrawer, type AutoSaveInfo, type TocChapter } from '../components/reader/ReaderTocDrawer'
import { ReaderSearchDrawer } from '../components/reader/ReaderSearchDrawer'
import { ReaderShortcutsModal } from '../components/reader/ReaderShortcutsModal'
import { useScrollReader } from '../hooks/useScrollReader'

export type ReaderMode = 'public' | 'userbook'

interface ReaderPageProps {
  mode?: ReaderMode
}

// Normalized chapter type for both modes
interface NormalizedChapter {
  id: string
  chapterNumber: number
  identifier: string // slug for public, chapterNumber as string for userbook
  title: string
  html: string
  wordCount: number | null
  prev: { identifier: string; title: string } | null
  next: { identifier: string; title: string } | null
}

// Normalized book type for both modes
interface NormalizedBook {
  id: string
  title: string
  chapters: TocChapter[]
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

  const api = useApi()
  const { isAuthenticated } = useAuth()
  const { language, getLocalizedPath } = useLanguage()
  const navigate = useNavigate()
  // Raw state for public books (needed for scroll reader, caching, etc.)
  const [publicChapter, setPublicChapter] = useState<Chapter | null>(null)
  const [publicBook, setPublicBook] = useState<BookDetail | null>(null)

  // Normalized state for both modes
  const [chapter, setChapter] = useState<NormalizedChapter | null>(null)
  const [book, setBook] = useState<NormalizedBook | null>(null)
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

  // Bookmarks: server sync for both public and userbook modes
  // Public mode uses useBookmarks with editionId for server sync
  const publicBookmarks = useBookmarks(mode === 'public' ? (bookSlug || '') : '', {
    editionId: publicBook?.id,
    isAuthenticated,
  })
  // Userbook mode uses dedicated server-synced hook
  const userBookmarks = useUserBookBookmarks(mode === 'userbook' ? (id || '') : '')

  // Select which bookmark functions to use based on mode
  const { bookmarks, removeBookmark, isBookmarked, getBookmarkForChapter } =
    mode === 'public' ? publicBookmarks : userBookmarks

  // Wrap addBookmark to handle different signatures
  const addBookmark = useCallback(
    async (chapterSlug: string, chapterTitle: string) => {
      if (mode === 'public') {
        // Public mode needs chapterId for server sync
        const chapterId = publicChapter?.id
        return publicBookmarks.addBookmark(chapterSlug, chapterTitle, chapterId)
      } else {
        // Userbook mode - find chapterId from book chapters
        const ch = book?.chapters.find((c) => c.identifier === chapterSlug)
        return userBookmarks.addBookmark(ch?.id || '', chapterSlug, chapterTitle)
      }
    },
    [mode, publicChapter?.id, book?.chapters, publicBookmarks, userBookmarks]
  )
  const { add: addToLibrary, isInLibrary } = useLibrary()
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const libraryAddedRef = useRef(false)
  const editionIdRef = useRef<string | null>(null)
  const { markFetchStart, wasAbortedDueToWake } = useNetworkRecovery()
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen()
  const showBarsInFullscreen = useFullscreenBars(isFullscreen)

  // Mobile immersive mode
  const isMobile = useIsMobile()
  const { immersiveMode, showBars: showImmersiveBars } = useImmersiveMode(isMobile, loading)

  // Scroll mode for mobile continuous reading (both public and userbook)
  const useScrollMode = isMobile

  // Adapted book data for scroll reader (normalized to identifier-based interface)
  const scrollReaderBook = useMemo(() => {
    if (mode === 'public' && publicBook) {
      return {
        chapters: publicBook.chapters.map(c => ({
          identifier: c.slug,
          title: c.title,
          chapterNumber: c.chapterNumber,
          wordCount: c.wordCount,
        }))
      }
    }
    if (mode === 'userbook' && book) {
      return {
        chapters: book.chapters.map(c => ({
          identifier: c.identifier, // slug for userbook
          title: c.title,
          chapterNumber: c.chapterNumber,
          wordCount: null, // userbook doesn't have wordCount in list
        }))
      }
    }
    return null
  }, [mode, publicBook, book])

  // Fetch chapter callback for scroll reader (public)
  const fetchPublicChapter = useCallback(
    async (slug: string) => {
      const ch = await api.getChapter(bookSlug!, slug)
      return { identifier: ch.slug, title: ch.title, html: ch.html, wordCount: ch.wordCount }
    },
    [api, bookSlug]
  )

  // Fetch chapter callback for scroll reader (userbook) - now uses slug
  const fetchUserChapter = useCallback(
    async (slug: string) => {
      const ch = await getUserBookChapter(id!, slug)
      return { identifier: ch.slug || slug, title: ch.title, html: ch.html, wordCount: ch.wordCount }
    },
    [id]
  )

  // Scroll reader hook (for mobile continuous scroll)
  const scrollReader = useScrollReader({
    book: scrollReaderBook,
    initialIdentifier: mode === 'public' ? (chapterSlug || '') : (userChapterSlug || ''),
    bookId: mode === 'public' ? (publicBook?.id || '') : (id || ''),
    fetchChapter: mode === 'public' ? fetchPublicChapter : fetchUserChapter,
  })

  // In scroll mode, use visible chapter for bookmarks (URL chapterSlug doesn't update on replaceState)
  const activeChapterIdentifier = useScrollMode && scrollReader.visibleIdentifier
    ? scrollReader.visibleIdentifier
    : chapterIdentifier || ''
  const activeChapter = useScrollMode
    ? book?.chapters.find(c => c.identifier === activeChapterIdentifier)
    : chapter

  // Track current URL chapter (may differ from chapterSlug after replaceState)
  const currentUrlChapterRef = useRef(chapterIdentifier)

  // Sync URL with visible chapter from scroll reader
  useEffect(() => {
    if (!useScrollMode) return
    const visibleId = scrollReader.visibleIdentifier
    if (!visibleId || visibleId === currentUrlChapterRef.current) return

    const newPath = mode === 'public'
      ? getLocalizedPath(`/books/${bookSlug}/${visibleId}`)
      : `/${language}/library/my/${id}/read/${visibleId}`
    window.history.replaceState(null, '', newPath)
    currentUrlChapterRef.current = visibleId
  }, [useScrollMode, mode, scrollReader.visibleIdentifier, bookSlug, id, language, getLocalizedPath])


  // Page-based pagination
  const {
    currentPage,
    totalPages,
    progress,
    nextPage,
    prevPage,
    goToPage,
    recalculate,
  } = usePagination(contentRef, containerRef)

  // Reading progress sync (with server when authenticated) - public mode only
  const publicProgress = useReadingProgress(
    mode === 'public' ? (bookSlug || '') : '',
    mode === 'public' ? (chapterSlug || '') : '',
    { editionId: publicBook?.id, chapterId: publicChapter?.id, chapterSlug: chapterSlug }
  )

  // User book progress (localStorage) - userbook mode only
  const userProgress = useUserBookProgress(mode === 'userbook' ? (id || '') : '')

  // Migrate legacy progress (chapterNumber -> slug) for userbooks
  const legacyMigratedRef = useRef(false)
  useEffect(() => {
    if (mode !== 'userbook') return
    if (legacyMigratedRef.current) return
    if (!userProgress.legacyProgress || !book?.chapters) return

    legacyMigratedRef.current = true
    const legacyChapterNum = userProgress.legacyProgress.chapterNumber
    const targetChapter = book.chapters.find(c => c.chapterNumber === legacyChapterNum)
    if (targetChapter) {
      // Navigate to the saved chapter using slug
      navigate(`/${language}/library/my/${id}/read/${targetChapter.identifier}`, { replace: true })
    }
  }, [mode, userProgress.legacyProgress, book?.chapters, navigate, language, id])

  // Unified progress interface
  const updateProgress = mode === 'public'
    ? publicProgress.updateProgress
    : (percent: number, page?: number, locator?: string) => {
        userProgress.saveProgress(chapterIdentifier || '', page || 0, percent, locator)
      }

  // Restore progress on mount - public mode only (user books restore handled separately)
  const { savedProgress, shouldNavigate, targetChapterSlug, isLoading: progressLoading } =
    useRestoreProgress(mode === 'public' ? publicBook?.id : undefined, chapterSlug)

  // Auto-save info for bookmarks drawer
  const autoSaveInfo = useMemo((): AutoSaveInfo | null => {
    if (mode === 'public') {
      if (!publicBook?.id || !publicBook?.chapters) return null
      try {
        const stored = localStorage.getItem(`reading.progress.${publicBook.id}`)
        if (!stored) return null
        const data = JSON.parse(stored) as { chapterSlug: string; locator: string; percent: number }
        if (!data.chapterSlug) return null
        const chapter = publicBook.chapters.find(c => c.slug === data.chapterSlug)
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
    } else {
      // Userbook mode - use server-synced progress
      if (!book?.chapters || !userProgress.savedProgress?.chapterSlug) return null
      const chapter = book.chapters.find(c => c.identifier === userProgress.savedProgress?.chapterSlug)
      if (!chapter) return null
      return {
        chapterSlug: userProgress.savedProgress.chapterSlug,
        chapterTitle: chapter.title,
        locator: userProgress.savedProgress.locator || '',
        percent: userProgress.savedProgress.percent,
      }
    }
  }, [mode, publicBook?.id, publicBook?.chapters, book?.chapters, userProgress.savedProgress])

  // Refs for restore logic
  const hasNavigatedRef = useRef(false)
  const restoredRef = useRef(false)

  // Calculate overall book progress based on word counts
  const overallProgress = useMemo(() => {
    // For scroll mode (both public and userbook)
    if (useScrollMode && scrollReaderBook) {
      const chapters = scrollReaderBook.chapters
      const currentId = scrollReader.visibleIdentifier
      if (!currentId) return 0

      const currentChapterIndex = chapters.findIndex(c => c.identifier === currentId)
      if (currentChapterIndex === -1) return 0

      // Calculate progress within current chapter based on scroll offset
      const chapterEl = scrollReader.chapterRefs.current.get(currentId)
      let chapterProgress = 0
      if (chapterEl) {
        const chapterHeight = chapterEl.scrollHeight
        if (chapterHeight > 0) {
          chapterProgress = Math.min(1, Math.max(0, scrollReader.scrollOffset / chapterHeight))
        }
      }

      // Calculate using word counts for accuracy (public has wordCount, userbook doesn't)
      const totalWords = chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0)
      if (totalWords === 0) {
        // Fallback: simple chapter-based progress (for userbook)
        return (currentChapterIndex + chapterProgress) / chapters.length
      }

      const wordsBeforeCurrent = chapters
        .slice(0, currentChapterIndex)
        .reduce((sum, c) => sum + (c.wordCount || 0), 0)
      const currentChapterWords = chapters[currentChapterIndex].wordCount || 0
      const wordsRead = wordsBeforeCurrent + currentChapterWords * chapterProgress

      return wordsRead / totalWords
    }

    // For public mode pagination
    if (mode === 'public' && publicBook) {
      const chapters = publicBook.chapters
      if (!chapterSlug || totalPages === 0) return 0

      const currentChapterIndex = chapters.findIndex(c => c.slug === chapterSlug)
      if (currentChapterIndex === -1) return 0

      const totalWords = chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0)
      if (totalWords === 0) {
        return (currentChapterIndex + progress) / chapters.length
      }

      const wordsBeforeCurrent = chapters
        .slice(0, currentChapterIndex)
        .reduce((sum, c) => sum + (c.wordCount || 0), 0)
      const currentChapterWords = chapters[currentChapterIndex].wordCount || 0
      const wordsRead = wordsBeforeCurrent + currentChapterWords * progress

      return wordsRead / totalWords
    }

    // For userbook mode: simple chapter-based progress
    if (mode === 'userbook' && book) {
      const chapters = book.chapters
      if (!chapterIdentifier || totalPages === 0) return 0

      const currentChapterIndex = chapters.findIndex(c => c.identifier === chapterIdentifier)
      if (currentChapterIndex === -1) return 0

      // Simple chapter + page progress (no word counts for user books)
      return (currentChapterIndex + progress) / chapters.length
    }

    return 0
  }, [mode, publicBook, book, scrollReaderBook, chapterSlug, chapterIdentifier, progress, totalPages, useScrollMode, scrollReader.visibleIdentifier, scrollReader.scrollOffset, scrollReader.chapterRefs])

  // Sync progress when page changes (pagination mode only)
  useEffect(() => {
    if (useScrollMode) return // Scroll mode has its own save effect
    if (totalPages > 0 && book?.id && chapter?.id) {
      const locator = `page:${currentPage}`
      updateProgress(overallProgress, currentPage, locator)
    }
  }, [useScrollMode, currentPage, totalPages, overallProgress, book?.id, chapter?.id, updateProgress])

  // Sync progress when scroll position changes (scroll mode)
  const lastScrollSaveRef = useRef<{ identifier: string; offset: number } | null>(null)
  const scrollSaveTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (!useScrollMode) return

    const visibleId = scrollReader.visibleIdentifier
    const offset = scrollReader.scrollOffset
    if (!visibleId) return

    // Skip save if scroll handler hasn't populated refs yet (offset would be stale)
    if (scrollReader.chapterRefs.current.size === 0) return

    // Only save if position changed significantly (chapter change OR 500px scroll)
    const last = lastScrollSaveRef.current
    if (last && last.identifier === visibleId && Math.abs(last.offset - offset) < 500) return

    // Update ref immediately to prevent duplicate saves
    lastScrollSaveRef.current = { identifier: visibleId, offset }

    // Debounce the actual save (600ms per ADR-007 spec: 500-800ms)
    if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current)

    // Capture current values for the timeout callback
    const saveId = visibleId
    const saveOffset = offset
    const saveProgress = overallProgress

    scrollSaveTimerRef.current = window.setTimeout(() => {
      if (mode === 'public' && publicBook?.chapters) {
        // Public mode: use server sync
        const bookChapter = publicBook.chapters.find(c => c.slug === saveId)
        if (bookChapter) {
          const scrollLocator = `scroll:${saveId}:${Math.round(saveOffset)}`
          publicProgress.updateProgress(saveProgress, undefined, scrollLocator, bookChapter.id, saveId)
        }
      } else if (mode === 'userbook') {
        // Userbook mode: save to localStorage + server with scroll locator
        const scrollLocator = `scroll:${saveId}:${Math.round(saveOffset)}`
        userProgress.saveProgress(saveId, 0, saveProgress, scrollLocator)
      }
      scrollSaveTimerRef.current = null
    }, 600)
  }, [useScrollMode, mode, publicBook?.chapters, scrollReader.visibleIdentifier, scrollReader.scrollOffset, overallProgress, publicProgress, userProgress])

  // Cleanup scroll save timer on unmount
  useEffect(() => {
    return () => {
      if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current)
    }
  }, [])

  // Time-on-position trigger (ADR-007 section 3.2): save if user stays at same position for 3s
  // Only for pagination mode - scroll mode has its own save effect
  const stablePositionTimerRef = useRef<number | null>(null)
  const lastStablePositionRef = useRef<{ page: number; progress: number } | null>(null)
  const useScrollModeRef = useRef(useScrollMode)
  useScrollModeRef.current = useScrollMode // Keep ref in sync
  useEffect(() => {
    if (useScrollMode) return // Scroll mode has its own save effect
    if (!book?.id || !chapter?.id) return

    const currentPosition = { page: currentPage, progress: overallProgress }
    const lastPosition = lastStablePositionRef.current

    // If position unchanged, don't restart timer
    if (lastPosition &&
        lastPosition.page === currentPosition.page &&
        Math.abs(lastPosition.progress - currentPosition.progress) < 0.001) {
      return
    }

    // Position changed - update ref and start new 3s timer
    lastStablePositionRef.current = currentPosition

    if (stablePositionTimerRef.current) {
      clearTimeout(stablePositionTimerRef.current)
    }

    stablePositionTimerRef.current = window.setTimeout(() => {
      // Double-check scroll mode hasn't changed since timer was set
      if (useScrollModeRef.current) return
      // User has been at same position for 3s - trigger save
      const locator = `page:${currentPage}`
      updateProgress(overallProgress, currentPage, locator)
    }, 3000)

    return () => {
      if (stablePositionTimerRef.current) {
        clearTimeout(stablePositionTimerRef.current)
      }
    }
  }, [useScrollMode, currentPage, overallProgress, book?.id, chapter?.id, updateProgress])

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

  // Restore page position after pagination is ready (pagination mode)
  useEffect(() => {
    if (useScrollMode) return // Skip for scroll mode
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
    } else if (savedProgress.percent != null && savedProgress.percent > 0) {
      // Fallback for scroll: or other formats
      goToPage(Math.floor(savedProgress.percent * (totalPages - 1)))
    }
  }, [useScrollMode, totalPages, savedProgress, progressLoading, shouldNavigate, goToPage, book?.id])

  // Restore scroll position (scroll mode)
  const scrollRestoredRef = useRef(false)
  useEffect(() => {
    if (!useScrollMode) return // Only for scroll mode
    if (scrollRestoredRef.current || progressLoading || shouldNavigate) return
    if (scrollReader.chapters.length === 0) return // Wait for chapters to load

    // Parse scroll locator: scroll:{chapterSlug}:{offset}
    if (!savedProgress?.locator?.startsWith('scroll:')) {
      scrollRestoredRef.current = true
      return
    }

    const parts = savedProgress.locator.split(':')
    if (parts.length < 3) {
      scrollRestoredRef.current = true
      return
    }

    const savedSlug = parts[1]
    const savedOffset = parseInt(parts[2], 10)
    if (isNaN(savedOffset)) {
      scrollRestoredRef.current = true
      return
    }

    // Wait for chapter element to be rendered
    const chapterEl = scrollReader.chapterRefs.current.get(savedSlug)
    if (!chapterEl) return // Chapter not loaded/rendered yet

    scrollRestoredRef.current = true

    // Scroll to chapter position + offset (offsetTop gives absolute position in document)
    requestAnimationFrame(() => {
      window.scrollTo({ top: chapterEl.offsetTop + savedOffset, behavior: 'instant' })
    })
  }, [useScrollMode, progressLoading, shouldNavigate, savedProgress, scrollReader.chapters, scrollReader.chapterRefs])

  // Reset restore refs on chapter change
  useEffect(() => {
    restoredRef.current = false
    scrollRestoredRef.current = false
    hasNavigatedRef.current = false
  }, [chapterIdentifier])

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
    // Public mode requires bookSlug and chapterSlug
    if (mode === 'public' && (!bookSlug || !chapterSlug)) return
    // User mode requires id and chapterSlug, plus auth
    if (mode === 'userbook' && (!id || !userChapterSlug || !isAuthenticated)) return

    let cancelled = false
    if (mode === 'public') markFetchStart()

    const fetchData = async () => {
      setLoading(true)
      setError(null)

      try {
        if (mode === 'public') {
          // Try cache first if we have editionId
          const cachedEditionId = editionIdRef.current
          if (cachedEditionId) {
            const cached = await getCachedChapter(cachedEditionId, chapterSlug!)
            if (cached && !cancelled) {
              // Set raw public chapter
              const rawChapter: Chapter = {
                id: cached.key,
                chapterNumber: 0,
                slug: cached.chapterSlug,
                title: cached.title,
                html: cached.html,
                wordCount: cached.wordCount,
                prev: cached.prev,
                next: cached.next,
              }
              setPublicChapter(rawChapter)
              // Normalize for UI
              setChapter({
                id: rawChapter.id,
                chapterNumber: rawChapter.chapterNumber,
                identifier: rawChapter.slug,
                title: rawChapter.title,
                html: rawChapter.html,
                wordCount: rawChapter.wordCount,
                prev: rawChapter.prev ? { identifier: rawChapter.prev.slug, title: rawChapter.prev.title } : null,
                next: rawChapter.next ? { identifier: rawChapter.next.slug, title: rawChapter.next.title } : null,
              })
              // Still need book for TOC - fetch it
              try {
                const bk = await api.getBook(bookSlug!)
                if (!cancelled) {
                  setPublicBook(bk)
                  setBook({
                    id: bk.id,
                    title: bk.title,
                    chapters: bk.chapters.map(c => ({
                      id: c.id,
                      identifier: c.slug,
                      title: c.title,
                      chapterNumber: c.chapterNumber,
                    })),
                  })
                }
              } catch {
                // Book fetch failed but chapter from cache - ok
              }
              setLoading(false)
              return
            }
          }

          // Cache miss or no editionId - fetch from API
          const [ch, bk] = await Promise.all([
            api.getChapter(bookSlug!, chapterSlug!),
            api.getBook(bookSlug!),
          ])

          if (cancelled) return

          // Set raw data
          setPublicChapter(ch)
          setPublicBook(bk)
          editionIdRef.current = bk.id

          // Normalize for UI
          setChapter({
            id: ch.id,
            chapterNumber: ch.chapterNumber,
            identifier: ch.slug,
            title: ch.title,
            html: ch.html,
            wordCount: ch.wordCount,
            prev: ch.prev ? { identifier: ch.prev.slug, title: ch.prev.title } : null,
            next: ch.next ? { identifier: ch.next.slug, title: ch.next.title } : null,
          })
          setBook({
            id: bk.id,
            title: bk.title,
            chapters: bk.chapters.map(c => ({
              id: c.id,
              identifier: c.slug,
              title: c.title,
              chapterNumber: c.chapterNumber,
            })),
          })

          // Cache for offline use
          cacheChapter(bk.id, ch).catch(() => {})
        } else {
          // User book mode - now uses slug
          const [bk, ch] = await Promise.all([
            getUserBook(id!),
            getUserBookChapter(id!, userChapterSlug!),
          ])

          if (cancelled) return

          // Normalize for UI - use slug as identifier
          setChapter({
            id: ch.id,
            chapterNumber: ch.chapterNumber,
            identifier: ch.slug || userChapterSlug!,
            title: ch.title,
            html: ch.html,
            wordCount: ch.wordCount,
            prev: ch.previous ? { identifier: ch.previous.slug || String(ch.previous.chapterNumber), title: ch.previous.title } : null,
            next: ch.next ? { identifier: ch.next.slug || String(ch.next.chapterNumber), title: ch.next.title } : null,
          })
          setBook({
            id: bk.id,
            title: bk.title,
            chapters: bk.chapters.map(c => ({
              id: c.id,
              identifier: c.slug || String(c.chapterNumber),
              title: c.title,
              chapterNumber: c.chapterNumber,
            })),
          })
        }
      } catch (err) {
        if (cancelled) return
        // If aborted due to wake, auto-retry (public mode only)
        if (mode === 'public' && wasAbortedDueToWake()) {
          fetchData()
          return
        }
        if (err instanceof InvalidContentTypeError) {
          setError('Chapter not found. The book may have been removed.')
        } else {
          setError((err as Error).message)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchData()
    return () => { cancelled = true }
  }, [mode, bookSlug, chapterSlug, id, userChapterSlug, isAuthenticated, api, markFetchStart, wasAbortedDueToWake])

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

  // Keyboard shortcuts
  const toggleBookmark = useCallback(() => {
    const bookmark = getBookmarkForChapter(activeChapterIdentifier)
    if (bookmark) {
      removeBookmark(bookmark.id)
    } else if (activeChapter) {
      addBookmark(activeChapterIdentifier, activeChapter.title)
    }
  }, [activeChapterIdentifier, activeChapter, getBookmarkForChapter, removeBookmark, addBookmark])

  // Chapter URL helper
  const getChapterUrl = useCallback((identifier: string) => {
    if (mode === 'public') {
      return getLocalizedPath(`/books/${bookSlug}/${identifier}`)
    }
    return `/${language}/library/my/${id}/read/${identifier}`
  }, [mode, bookSlug, id, language, getLocalizedPath])

  // Back URL
  const backUrl = mode === 'public'
    ? `/books/${bookSlug}`
    : `/${language}/library/my/${id}`

  // Navigation handlers
  const navigateToChapterCustom = useCallback((identifier: string) => {
    navigate(getChapterUrl(identifier))
  }, [navigate, getChapterUrl])

  const handlePrevPageCustom = useCallback(() => {
    if (currentPage > 0) {
      prevPage()
    } else if (chapter?.prev) {
      navigateToChapterCustom(chapter.prev.identifier)
    }
  }, [currentPage, chapter?.prev, prevPage, navigateToChapterCustom])

  const handleNextPageCustom = useCallback(() => {
    if (currentPage < totalPages - 1) {
      nextPage()
    } else if (chapter?.next) {
      navigateToChapterCustom(chapter.next.identifier)
    }
  }, [currentPage, totalPages, chapter?.next, nextPage, navigateToChapterCustom])

  // Legacy navigation hook (still needed for keyboard shortcuts compatibility)
  const { navigateToChapter } = useReaderNavigation({
    bookSlug: bookSlug || '',
    currentPage,
    totalPages,
    prevChapterSlug: mode === 'public' ? chapter?.prev?.identifier : undefined,
    nextChapterSlug: mode === 'public' ? chapter?.next?.identifier : undefined,
    prevPage,
    nextPage,
  })

  useReaderKeyboard({
    currentPage,
    totalPages,
    prevPage,
    nextPage,
    prevChapterSlug: chapter?.prev?.identifier,
    nextChapterSlug: chapter?.next?.identifier,
    navigateToChapter: mode === 'public' ? navigateToChapter : navigateToChapterCustom,
    tocOpen,
    settingsOpen,
    searchOpen,
    shortcutsOpen,
    setTocOpen,
    setSettingsOpen,
    setSearchOpen,
    setShortcutsOpen,
    clearSearch,
    activeChapterSlug: activeChapterIdentifier,
    toggleBookmark,
    settings,
    updateSettings: update,
    toggleFullscreen,
  })

  // Swipe navigation - disabled on mobile (use tap zones instead)
  useSwipe({
    onSwipeLeft: handleNextPageCustom,
    onSwipeRight: handlePrevPageCustom,
    threshold: 50,
    enabled: !isMobile && !tocOpen && !settingsOpen && !searchOpen,
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

  if (error || !chapter || !book) {
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

  const seoTitle = `${chapter.title} — ${book.title}`
  const seoDescription = `Read ${chapter.title} from ${book.title} online | TextStack`

  const fullscreenClass = isFullscreen ? (showBarsInFullscreen ? 'fullscreen-bars-visible' : 'fullscreen-bars-hidden') : ''
  const immersiveClass = immersiveMode ? 'immersive-mode' : ''
  const scrollModeClass = useScrollMode ? 'reader-page--scroll-mode' : ''

  return (
    <div className={`reader-page ${fullscreenClass} ${immersiveClass} ${scrollModeClass}`}>
      <SeoHead title={seoTitle} description={seoDescription} />
      <a href="#reader-content" className="skip-link">Skip to content</a>
      <ReaderTopBar
        visible={visible}
        title={book.title}
        chapterTitle={activeChapter?.title || chapter.title}
        progress={overallProgress}
        isBookmarked={isBookmarked(activeChapterIdentifier)}
        isFullscreen={isFullscreen}
        backUrl={backUrl}
        useLocalizedLink={mode === 'public'}
        onSearchClick={() => setSearchOpen(true)}
        onTocClick={() => setTocOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        onBookmarkClick={() => {
          const bookmark = getBookmarkForChapter(activeChapterIdentifier)
          if (bookmark) {
            removeBookmark(bookmark.id)
          } else if (activeChapter) {
            addBookmark(activeChapterIdentifier, activeChapter.title)
          }
        }}
        onFullscreenClick={toggleFullscreen}
        onHelpClick={() => setShortcutsOpen(true)}
      />

      {/* Hide side navigation in scroll mode - content scrolls continuously */}
      {!useScrollMode && (
        <ReaderPageNav
          direction="prev"
          disabled={currentPage === 0 && !chapter.prev}
          onClick={handlePrevPageCustom}
        />
      )}

      <main id="reader-content" className="reader-main">
        {useScrollMode ? (
          <ScrollReaderContent
            chapters={scrollReader.chapters}
            settings={settings}
            isLoadingMore={scrollReader.isLoadingMore}
            onLoadMore={scrollReader.loadMore}
            chapterRefs={scrollReader.chapterRefs}
            onTap={showImmersiveBars}
            onDoubleTap={toggleFullscreen}
          />
        ) : (
          <ReaderContent
            ref={contentRef}
            containerRef={containerRef}
            html={chapter.html}
            settings={settings}
            onTap={() => { if (isMobile) { showImmersiveBars(); } else { toggle(); } }}
            onDoubleTap={toggleFullscreen}
            onLeftTap={isMobile ? handlePrevPageCustom : undefined}
            onRightTap={isMobile ? handleNextPageCustom : undefined}
          />
        )}
      </main>

      {!useScrollMode && (
        <ReaderPageNav
          direction="next"
          disabled={currentPage === totalPages - 1 && !chapter.next}
          onClick={handleNextPageCustom}
        />
      )}

      <ReaderFooterNav
        chapterTitle={activeChapter?.title || chapter.title}
        overallProgress={overallProgress}
      />

      <ReaderTocDrawer
        open={tocOpen}
        chapters={book.chapters}
        currentChapterIdentifier={activeChapterIdentifier}
        bookmarks={bookmarks}
        autoSave={autoSaveInfo}
        getChapterUrl={getChapterUrl}
        useLocalizedLink={mode === 'public'}
        onClose={() => setTocOpen(false)}
        onRemoveBookmark={removeBookmark}
        onChapterSelect={useScrollMode ? (identifier) => {
          // In scroll mode: scroll to chapter if loaded, else navigate
          const isLoaded = scrollReader.chapters.some(c => c.identifier === identifier)
          if (isLoaded) {
            scrollReader.scrollToChapter(identifier)
          } else {
            navigate(getChapterUrl(identifier) + '?direct=1')
          }
        } : undefined}
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

      <ReaderShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
    </div>
  )
}
