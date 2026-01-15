import { useState, useEffect, useCallback, useRef } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import { createApi } from '../api/client'
import { getCachedChapter, cacheChapter } from '../lib/offlineDb'
import { useNetworkRecovery } from './useNetworkRecovery'
import type { Chapter, BookDetail } from '../types/api'

interface UseOfflineChapterResult {
  chapter: Chapter | null
  book: BookDetail | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useOfflineChapter(
  bookSlug: string | undefined,
  chapterSlug: string | undefined,
  editionId: string | undefined
): UseOfflineChapterResult {
  const { language } = useLanguage()
  const api = createApi(language)

  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [book, setBook] = useState<BookDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchIdRef = useRef(0)

  const { markFetchStart, wasAbortedDueToWake } = useNetworkRecovery()

  const fetchData = useCallback(async () => {
    if (!bookSlug || !chapterSlug) return

    const currentFetchId = ++fetchIdRef.current
    const signal = markFetchStart()

    setLoading(true)
    setError(null)

    try {
      // Try cache first if we have editionId
      if (editionId) {
        const cached = await getCachedChapter(editionId, chapterSlug)
        if (cached && currentFetchId === fetchIdRef.current) {
          // Serve from cache
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
          // Still fetch book metadata (needed for TOC etc)
          try {
            const bk = await api.getBook(bookSlug)
            if (currentFetchId === fetchIdRef.current) {
              setBook(bk)
            }
          } catch {
            // Book fetch failed but we have chapter - that's ok
          }
          setLoading(false)
          return
        }
      }

      // Cache miss - fetch from API
      const [ch, bk] = await Promise.all([
        api.getChapter(bookSlug, chapterSlug),
        api.getBook(bookSlug),
      ])

      if (currentFetchId !== fetchIdRef.current) return

      setChapter(ch)
      setBook(bk)

      // Cache the chapter for offline use (if we have editionId)
      const resolvedEditionId = editionId || bk.id
      if (resolvedEditionId) {
        cacheChapter(resolvedEditionId, ch).catch(console.error)
      }
    } catch (err) {
      if (currentFetchId !== fetchIdRef.current) return

      // If aborted due to wake, auto-retry
      if (wasAbortedDueToWake()) {
        fetchData()
        return
      }

      setError((err as Error).message)
    } finally {
      if (currentFetchId === fetchIdRef.current) {
        setLoading(false)
      }
    }
  }, [bookSlug, chapterSlug, editionId, api, markFetchStart, wasAbortedDueToWake])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return {
    chapter,
    book,
    loading,
    error,
    refetch: fetchData,
  }
}
