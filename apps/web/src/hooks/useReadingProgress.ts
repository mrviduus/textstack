import { useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { upsertProgress } from '../api/auth'

interface UseReadingProgressOptions {
  editionId?: string
  chapterId?: string
}

export function useReadingProgress(
  bookSlug: string,
  chapterSlug: string,
  options?: UseReadingProgressOptions
) {
  const { isAuthenticated } = useAuth()
  const serverSyncRef = useRef<number | null>(null)
  const lastSyncedRef = useRef<number>(0)
  const { editionId, chapterId } = options || {}

  // Update progress (called by reader when page changes)
  const updateProgress = useCallback((percent: number, page?: number) => {
    // Debounced sync to server (if authenticated)
    if (isAuthenticated && editionId && chapterId) {
      // Skip if same value synced recently
      if (Math.abs(percent - lastSyncedRef.current) < 0.01) return

      if (serverSyncRef.current) clearTimeout(serverSyncRef.current)
      serverSyncRef.current = window.setTimeout(() => {
        lastSyncedRef.current = percent
        upsertProgress(editionId, {
          chapterId,
          locator: page != null ? `page:${page}` : `percent:${percent.toFixed(4)}`,
          percent,
        }).catch(() => {})
      }, 2000)
    }
  }, [bookSlug, chapterSlug, isAuthenticated, editionId, chapterId])

  // Cleanup
  useEffect(() => {
    return () => {
      if (serverSyncRef.current) clearTimeout(serverSyncRef.current)
    }
  }, [])

  return { updateProgress }
}
