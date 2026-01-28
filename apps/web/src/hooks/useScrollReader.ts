import { useState, useEffect, useCallback, useRef } from 'react'

export interface LoadedChapter {
  identifier: string // slug for both public and userbook
  title: string
  html: string
  wordCount: number | null
  index: number // position in book.chapters
}

interface ChapterSummary {
  identifier: string
  title: string
  chapterNumber: number
  wordCount?: number | null
}

interface FetchedChapter {
  identifier: string
  title: string
  html: string
  wordCount: number | null
}

interface UseScrollReaderProps {
  book: { chapters: ChapterSummary[] } | null
  initialIdentifier: string
  bookId: string // editionId for public, userBookId for userbook
  fetchChapter: (identifier: string) => Promise<FetchedChapter>
}

interface UseScrollReaderResult {
  chapters: LoadedChapter[]
  visibleIdentifier: string
  isLoadingMore: boolean
  loadError: string | null
  scrollOffset: number
  loadMore: () => Promise<void>
  loadPrev: () => Promise<void>
  scrollToChapter: (identifier: string) => void
  chapterRefs: React.MutableRefObject<Map<string, HTMLElement>>
}

const CHAPTERS_BUFFER = 2 // Load 2 chapters ahead/behind

export function useScrollReader({
  book,
  initialIdentifier,
  bookId: _bookId,
  fetchChapter,
}: UseScrollReaderProps): UseScrollReaderResult {
  const [chapters, setChapters] = useState<LoadedChapter[]>([])
  const [visibleIdentifier, setVisibleIdentifier] = useState(initialIdentifier)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scrollOffset, setScrollOffset] = useState(0)

  const chapterRefs = useRef<Map<string, HTMLElement>>(new Map())
  const loadingRef = useRef(false)
  const loadedIdsRef = useRef<Set<string>>(new Set())
  const lastInitialIdRef = useRef(initialIdentifier)

  // Reset when navigating to a different chapter
  useEffect(() => {
    if (lastInitialIdRef.current !== initialIdentifier) {
      lastInitialIdRef.current = initialIdentifier
      setChapters([])
      setVisibleIdentifier(initialIdentifier)
      setScrollOffset(0)
      loadedIdsRef.current.clear()
      chapterRefs.current.clear()
    }
  }, [initialIdentifier])

  // Get chapter index from book
  const getChapterIndex = useCallback(
    (identifier: string): number => {
      if (!book) return -1
      return book.chapters.findIndex((c) => c.identifier === identifier)
    },
    [book]
  )

  // Fetch a single chapter
  const loadChapter = useCallback(
    async (chapterSummary: ChapterSummary): Promise<LoadedChapter | null> => {
      const { identifier } = chapterSummary

      // Skip if already loaded
      if (loadedIdsRef.current.has(identifier)) return null

      try {
        const chapterData = await fetchChapter(identifier)

        const index = book?.chapters.findIndex((c) => c.identifier === identifier) ?? -1
        loadedIdsRef.current.add(identifier)

        return {
          identifier: chapterData.identifier,
          title: chapterData.title,
          html: chapterData.html,
          wordCount: chapterData.wordCount,
          index,
        }
      } catch (err) {
        console.error(`Failed to load chapter ${identifier}:`, err)
        return null
      }
    },
    [fetchChapter, book]
  )

  // Initial load: current chapter + next CHAPTERS_BUFFER
  useEffect(() => {
    if (!book || chapters.length > 0) return

    const loadInitial = async () => {
      setIsLoadingMore(true)
      setLoadError(null)

      try {
        const currentIndex = getChapterIndex(initialIdentifier)
        if (currentIndex === -1) {
          setLoadError('Chapter not found')
          return
        }

        // Load current + next chapters
        const toLoad = book.chapters.slice(currentIndex, currentIndex + CHAPTERS_BUFFER + 1)
        const loaded: LoadedChapter[] = []

        for (const summary of toLoad) {
          const chapter = await loadChapter(summary)
          if (chapter) loaded.push(chapter)
        }

        // Sort by index to ensure correct order
        loaded.sort((a, b) => a.index - b.index)
        setChapters(loaded)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load chapters')
      } finally {
        setIsLoadingMore(false)
      }
    }

    loadInitial()
  }, [book, initialIdentifier, getChapterIndex, loadChapter, chapters.length])

  // Load more chapters (next)
  const loadMore = useCallback(async () => {
    if (!book || loadingRef.current || isLoadingMore) return
    loadingRef.current = true
    setIsLoadingMore(true)

    try {
      // Find the last loaded chapter's index
      const lastLoaded = chapters[chapters.length - 1]
      if (!lastLoaded) return

      const nextIndex = lastLoaded.index + 1
      const toLoad = book.chapters.slice(nextIndex, nextIndex + CHAPTERS_BUFFER)

      if (toLoad.length === 0) return // No more chapters

      const loaded: LoadedChapter[] = []
      for (const summary of toLoad) {
        const chapter = await loadChapter(summary)
        if (chapter) loaded.push(chapter)
      }

      if (loaded.length > 0) {
        setChapters((prev) => {
          const combined = [...prev, ...loaded]
          combined.sort((a, b) => a.index - b.index)
          return combined
        })
      }
    } finally {
      setIsLoadingMore(false)
      loadingRef.current = false
    }
  }, [book, chapters, isLoadingMore, loadChapter])

  // Load previous chapters (for scrolling up)
  const loadPrev = useCallback(async () => {
    if (!book || loadingRef.current || isLoadingMore) return
    loadingRef.current = true
    setIsLoadingMore(true)

    try {
      // Find the first loaded chapter's index
      const firstLoaded = chapters[0]
      if (!firstLoaded || firstLoaded.index === 0) return

      const startIndex = Math.max(0, firstLoaded.index - CHAPTERS_BUFFER)
      const toLoad = book.chapters.slice(startIndex, firstLoaded.index)

      if (toLoad.length === 0) return

      const loaded: LoadedChapter[] = []
      for (const summary of toLoad) {
        const chapter = await loadChapter(summary)
        if (chapter) loaded.push(chapter)
      }

      if (loaded.length > 0) {
        setChapters((prev) => {
          const combined = [...loaded, ...prev]
          combined.sort((a, b) => a.index - b.index)
          return combined
        })
      }
    } finally {
      setIsLoadingMore(false)
      loadingRef.current = false
    }
  }, [book, chapters, isLoadingMore, loadChapter])

  // Track scroll offset and visible chapter
  useEffect(() => {
    let timeoutId: number

    const handleScroll = () => {
      clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => {
        // Find which chapter is visible at top of viewport
        const viewportTop = window.innerHeight * 0.25 // Check within top 25%
        let foundId: string | null = null
        let foundTop = -Infinity

        chapterRefs.current.forEach((el, identifier) => {
          const rect = el.getBoundingClientRect()
          // Chapter is visible if:
          // 1. Its top is within the top portion of viewport OR scrolled past (negative)
          // 2. Its bottom is still visible (positive)
          if (rect.top < viewportTop && rect.bottom > 0) {
            // Pick the chapter with highest top (most recently scrolled into)
            if (rect.top > foundTop) {
              foundId = identifier
              foundTop = rect.top
            }
          }
        })

        if (foundId && foundId !== visibleIdentifier) {
          setVisibleIdentifier(foundId)
        }

        // Calculate offset relative to visible chapter
        const visibleEl = chapterRefs.current.get(foundId || visibleIdentifier)
        if (visibleEl) {
          const rect = visibleEl.getBoundingClientRect()
          setScrollOffset(Math.abs(rect.top))
        }
      }, 100)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    // Initial check
    handleScroll()
    return () => {
      clearTimeout(timeoutId)
      window.removeEventListener('scroll', handleScroll)
    }
  }, [visibleIdentifier, chapters])

  // Scroll to a specific chapter
  const scrollToChapter = useCallback((identifier: string) => {
    const el = chapterRefs.current.get(identifier)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  return {
    chapters,
    visibleIdentifier,
    isLoadingMore,
    loadError,
    scrollOffset,
    loadMore,
    loadPrev,
    scrollToChapter,
    chapterRefs,
  }
}
