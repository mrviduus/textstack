import { useState, useEffect, useCallback, useRef } from 'react'
import type { BookDetail, Chapter, ChapterSummary } from '../types/api'
import { getCachedChapter, cacheChapter } from '../lib/offlineDb'

export interface LoadedChapter {
  slug: string
  title: string
  html: string
  wordCount: number | null
  index: number // position in book.chapters
}

interface UseScrollReaderProps {
  book: BookDetail | null
  initialChapterSlug: string
  editionId: string
  fetchChapter: (chapterSlug: string) => Promise<Chapter>
}

interface UseScrollReaderResult {
  chapters: LoadedChapter[]
  visibleChapterSlug: string
  isLoadingMore: boolean
  loadError: string | null
  scrollOffset: number
  loadMore: () => Promise<void>
  loadPrev: () => Promise<void>
  scrollToChapter: (slug: string) => void
  chapterRefs: React.MutableRefObject<Map<string, HTMLElement>>
}

const CHAPTERS_BUFFER = 2 // Load 2 chapters ahead/behind

export function useScrollReader({
  book,
  initialChapterSlug,
  editionId,
  fetchChapter,
}: UseScrollReaderProps): UseScrollReaderResult {
  const [chapters, setChapters] = useState<LoadedChapter[]>([])
  const [visibleChapterSlug, setVisibleChapterSlug] = useState(initialChapterSlug)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scrollOffset, setScrollOffset] = useState(0)

  const chapterRefs = useRef<Map<string, HTMLElement>>(new Map())
  const loadingRef = useRef(false)
  const loadedSlugsRef = useRef<Set<string>>(new Set())

  // Get chapter index from book
  const getChapterIndex = useCallback(
    (slug: string): number => {
      if (!book) return -1
      return book.chapters.findIndex((c) => c.slug === slug)
    },
    [book]
  )

  // Fetch a single chapter (cache-first)
  const loadChapter = useCallback(
    async (chapterSummary: ChapterSummary): Promise<LoadedChapter | null> => {
      const { slug } = chapterSummary

      // Skip if already loaded
      if (loadedSlugsRef.current.has(slug)) return null

      try {
        // Try cache first
        let chapterData: Chapter | null = null
        const cached = await getCachedChapter(editionId, slug)

        if (cached) {
          chapterData = {
            id: '', // not needed for display
            chapterNumber: chapterSummary.chapterNumber,
            slug: cached.chapterSlug,
            title: cached.title,
            html: cached.html,
            wordCount: cached.wordCount,
            prev: cached.prev,
            next: cached.next,
          }
        } else {
          // Fetch from API
          chapterData = await fetchChapter(slug)
          // Cache for offline
          await cacheChapter(editionId, chapterData)
        }

        const index = book?.chapters.findIndex((c) => c.slug === slug) ?? -1
        loadedSlugsRef.current.add(slug)

        return {
          slug: chapterData.slug,
          title: chapterData.title,
          html: chapterData.html,
          wordCount: chapterData.wordCount,
          index,
        }
      } catch (err) {
        console.error(`Failed to load chapter ${slug}:`, err)
        return null
      }
    },
    [editionId, fetchChapter, book]
  )

  // Initial load: current chapter + next CHAPTERS_BUFFER
  useEffect(() => {
    if (!book || chapters.length > 0) return

    const loadInitial = async () => {
      setIsLoadingMore(true)
      setLoadError(null)

      try {
        const currentIndex = getChapterIndex(initialChapterSlug)
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
  }, [book, initialChapterSlug, getChapterIndex, loadChapter, chapters.length])

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
        let foundSlug: string | null = null
        let foundTop = -Infinity

        chapterRefs.current.forEach((el, slug) => {
          const rect = el.getBoundingClientRect()
          // Chapter is visible if:
          // 1. Its top is within the top portion of viewport OR scrolled past (negative)
          // 2. Its bottom is still visible (positive)
          if (rect.top < viewportTop && rect.bottom > 0) {
            // Pick the chapter with highest top (most recently scrolled into)
            if (rect.top > foundTop) {
              foundSlug = slug
              foundTop = rect.top
            }
          }
        })

        if (foundSlug && foundSlug !== visibleChapterSlug) {
          setVisibleChapterSlug(foundSlug)
        }

        // Calculate offset relative to visible chapter
        const visibleEl = chapterRefs.current.get(foundSlug || visibleChapterSlug)
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
  }, [visibleChapterSlug, chapters])

  // Scroll to a specific chapter
  const scrollToChapter = useCallback((slug: string) => {
    const el = chapterRefs.current.get(slug)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  return {
    chapters,
    visibleChapterSlug,
    isLoadingMore,
    loadError,
    scrollOffset,
    loadMore,
    loadPrev,
    scrollToChapter,
    chapterRefs,
  }
}
