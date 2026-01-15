import { useRef, useCallback } from 'react'
import { createApi } from '../api/client'
import { useLanguage } from '../context/LanguageContext'
import {
  cacheChapter,
  getCachedBookMeta,
  setCachedBookMeta,
  countCachedChapters,
  type CachedBookMeta,
} from '../lib/offlineDb'

interface DownloadJob {
  editionId: string
  bookSlug: string
  aborted: boolean
}

export function useOfflineDownload() {
  const { language } = useLanguage()
  const api = createApi(language)
  const activeJobsRef = useRef<Map<string, DownloadJob>>(new Map())

  const downloadBook = useCallback(async (editionId: string, bookSlug: string) => {
    // Check if already downloading or fully cached
    if (activeJobsRef.current.has(editionId)) return

    const existingMeta = await getCachedBookMeta(editionId)
    if (existingMeta && existingMeta.cachedChapters >= existingMeta.totalChapters) {
      return // Already fully cached
    }

    const job: DownloadJob = { editionId, bookSlug, aborted: false }
    activeJobsRef.current.set(editionId, job)

    try {
      // Fetch book to get chapters list
      const book = await api.getBook(bookSlug)
      if (job.aborted) return

      const chapters = book.chapters || []
      const totalChapters = chapters.length

      // Initialize meta
      const meta: CachedBookMeta = {
        editionId,
        slug: bookSlug,
        totalChapters,
        cachedChapters: await countCachedChapters(editionId),
        cachedAt: Date.now(),
      }
      await setCachedBookMeta(meta)

      // Download chapters sequentially
      for (const chapterSummary of chapters) {
        if (job.aborted) break

        try {
          const chapter = await api.getChapter(bookSlug, chapterSummary.slug)
          if (job.aborted) break

          await cacheChapter(editionId, chapter)

          // Update meta
          meta.cachedChapters = await countCachedChapters(editionId)
          await setCachedBookMeta(meta)

          // Small delay to avoid overwhelming the server
          await new Promise(resolve => setTimeout(resolve, 300))
        } catch {
          // Skip failed chapter, continue with next
        }
      }
    } finally {
      activeJobsRef.current.delete(editionId)
    }
  }, [api])

  const cancelDownload = useCallback((editionId: string) => {
    const job = activeJobsRef.current.get(editionId)
    if (job) {
      job.aborted = true
    }
  }, [])

  const isDownloading = useCallback((editionId: string) => {
    return activeJobsRef.current.has(editionId)
  }, [])

  return {
    downloadBook,
    cancelDownload,
    isDownloading,
  }
}
