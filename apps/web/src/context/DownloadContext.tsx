import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react'
import { createApi } from '../api/client'
import {
  cacheChapter,
  getCachedBookMeta,
  setCachedBookMeta,
  countCachedChapters,
} from '../lib/offlineDb'

export interface DownloadInfo {
  editionId: string
  bookSlug: string
  title: string
  progress: number // 0-100
  totalChapters: number
  downloadedChapters: number
  failedChapters: number
  status: 'downloading' | 'complete' | 'error' | 'cancelled'
  errorMessage?: string
}

// Check available storage (returns bytes, null if not supported)
async function checkStorageQuota(): Promise<{ available: number; used: number } | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const estimate = await navigator.storage.estimate()
    const quota = estimate.quota || 0
    const usage = estimate.usage || 0
    return { available: quota - usage, used: usage }
  } catch {
    return null
  }
}

// Minimum 50MB required to start download
const MIN_STORAGE_BYTES = 50 * 1024 * 1024

interface DownloadContextValue {
  downloads: Map<string, DownloadInfo>
  startDownload: (editionId: string, bookSlug: string, title: string, language: string) => void
  cancelDownload: (editionId: string) => void
  isDownloading: (editionId: string) => boolean
  getProgress: (editionId: string) => number | null
  getDownloadInfo: (editionId: string) => DownloadInfo | undefined
}

const DownloadContext = createContext<DownloadContextValue | null>(null)

interface DownloadJob {
  editionId: string
  aborted: boolean
}

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [downloads, setDownloads] = useState<Map<string, DownloadInfo>>(new Map())
  const jobsRef = useRef<Map<string, DownloadJob>>(new Map())

  const updateDownload = useCallback((editionId: string, update: Partial<DownloadInfo>) => {
    setDownloads(prev => {
      const next = new Map(prev)
      const current = next.get(editionId)
      if (current) {
        next.set(editionId, { ...current, ...update })
      }
      return next
    })
  }, [])

  const startDownload = useCallback(async (
    editionId: string,
    bookSlug: string,
    title: string,
    language: string
  ) => {
    // Check if already downloading
    if (jobsRef.current.has(editionId)) return

    // Check if already fully cached
    const existingMeta = await getCachedBookMeta(editionId)
    if (existingMeta && existingMeta.cachedChapters >= existingMeta.totalChapters) {
      return
    }

    const job: DownloadJob = { editionId, aborted: false }
    jobsRef.current.set(editionId, job)

    // Check storage quota
    const quota = await checkStorageQuota()
    if (quota && quota.available < MIN_STORAGE_BYTES) {
      const usedMB = Math.round(quota.used / 1024 / 1024)
      const info: DownloadInfo = {
        editionId,
        bookSlug,
        title,
        progress: 0,
        totalChapters: 0,
        downloadedChapters: 0,
        failedChapters: 0,
        status: 'error',
        errorMessage: `Not enough storage (${usedMB}MB used). Free up space and retry.`,
      }
      setDownloads(prev => new Map(prev).set(editionId, info))
      jobsRef.current.delete(editionId)
      return
    }

    // Initialize download state
    const info: DownloadInfo = {
      editionId,
      bookSlug,
      title,
      progress: 0,
      totalChapters: 0,
      downloadedChapters: 0,
      failedChapters: 0,
      status: 'downloading',
    }
    setDownloads(prev => new Map(prev).set(editionId, info))

    const api = createApi(language)
    let failedChapters = 0
    let hasError = false

    try {
      // Fetch book to get chapters list
      const book = await api.getBook(bookSlug)
      if (job.aborted) {
        updateDownload(editionId, { status: 'cancelled' })
        return
      }

      const chapters = book.chapters || []
      const totalChapters = chapters.length

      // Update with total
      updateDownload(editionId, { totalChapters })

      // Initialize meta in IndexedDB
      await setCachedBookMeta({
        editionId,
        slug: bookSlug,
        totalChapters,
        cachedChapters: await countCachedChapters(editionId),
        cachedAt: Date.now(),
      })

      // Download chapters sequentially
      for (let i = 0; i < chapters.length; i++) {
        if (job.aborted) {
          updateDownload(editionId, { status: 'cancelled' })
          break
        }

        const chapterSummary = chapters[i]

        try {
          const chapter = await api.getChapter(bookSlug, chapterSummary.slug)
          if (job.aborted) break

          await cacheChapter(editionId, chapter)

          const downloadedChapters = await countCachedChapters(editionId)
          const progress = Math.round((downloadedChapters / totalChapters) * 100)

          updateDownload(editionId, { downloadedChapters, progress, failedChapters })

          // Update IndexedDB meta
          await setCachedBookMeta({
            editionId,
            slug: bookSlug,
            totalChapters,
            cachedChapters: downloadedChapters,
            cachedAt: Date.now(),
          })

          // Small delay to avoid overwhelming the server
          await new Promise(resolve => setTimeout(resolve, 200))
        } catch (err) {
          failedChapters++
          updateDownload(editionId, { failedChapters })

          // Check if quota exceeded
          if (err instanceof DOMException && err.name === 'QuotaExceededError') {
            hasError = true
            updateDownload(editionId, {
              status: 'error',
              errorMessage: 'Storage full. Delete some offline books to continue.',
            })
            break
          }
          // Other errors: continue with next chapter
        }
      }

      // Mark complete if not aborted and no error
      if (!job.aborted && !hasError) {
        const finalUpdate: Partial<DownloadInfo> = { status: 'complete', progress: 100 }
        if (failedChapters > 0) {
          finalUpdate.errorMessage = `Completed with ${failedChapters} chapter(s) failed`
        }
        updateDownload(editionId, finalUpdate)

        // Auto-remove from UI after 5 seconds (longer if there were errors)
        setTimeout(() => {
          setDownloads(prev => {
            const next = new Map(prev)
            next.delete(editionId)
            return next
          })
        }, failedChapters > 0 ? 8000 : 3000)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Download failed'
      updateDownload(editionId, { status: 'error', errorMessage: message })
    } finally {
      jobsRef.current.delete(editionId)
    }
  }, [updateDownload])

  const cancelDownload = useCallback((editionId: string) => {
    const job = jobsRef.current.get(editionId)
    if (job) {
      job.aborted = true
    }
    // Remove from UI immediately
    setDownloads(prev => {
      const next = new Map(prev)
      next.delete(editionId)
      return next
    })
  }, [])

  const isDownloading = useCallback((editionId: string) => {
    const info = downloads.get(editionId)
    return info?.status === 'downloading'
  }, [downloads])

  const getProgress = useCallback((editionId: string) => {
    return downloads.get(editionId)?.progress ?? null
  }, [downloads])

  const getDownloadInfo = useCallback((editionId: string) => {
    return downloads.get(editionId)
  }, [downloads])

  return (
    <DownloadContext.Provider value={{
      downloads,
      startDownload,
      cancelDownload,
      isDownloading,
      getProgress,
      getDownloadInfo,
    }}>
      {children}
    </DownloadContext.Provider>
  )
}

export function useDownload() {
  const context = useContext(DownloadContext)
  if (!context) {
    throw new Error('useDownload must be used within DownloadProvider')
  }
  return context
}
