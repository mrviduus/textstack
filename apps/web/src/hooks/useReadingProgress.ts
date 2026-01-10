import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { getProgress, upsertProgress } from '../api/auth'

interface StoredProgress {
  chapterSlug: string
  chapterId?: string
  percent: number
  page?: number
  updatedAt: number
}

interface UseReadingProgressOptions {
  editionId?: string
  chapterId?: string
}

function getKey(bookSlug: string) {
  return `reader.progress.${bookSlug}`
}

export function useReadingProgress(
  bookSlug: string,
  chapterSlug: string,
  options?: UseReadingProgressOptions
) {
  const { isAuthenticated } = useAuth()
  const [progress, setProgress] = useState(0)
  const serverSyncRef = useRef<number | null>(null)
  const lastSyncedRef = useRef<number>(0)
  const { editionId, chapterId } = options || {}

  // Load saved progress on mount
  useEffect(() => {
    const loadProgress = async () => {
      // If authenticated and have IDs, try server first
      if (isAuthenticated && editionId) {
        try {
          const serverProgress = await getProgress(editionId)
          if (serverProgress && serverProgress.percent != null) {
            setProgress(serverProgress.percent)
            return
          }
        } catch {
          // Fall through to localStorage
        }
      }

      // Fallback to localStorage
      try {
        const stored = localStorage.getItem(getKey(bookSlug))
        if (stored) {
          const data: StoredProgress = JSON.parse(stored)
          if (data.chapterSlug === chapterSlug) {
            setProgress(data.percent)
          }
        }
      } catch {}
    }

    loadProgress()
  }, [bookSlug, chapterSlug, isAuthenticated, editionId])

  // Update progress (called by reader when page changes)
  const updateProgress = useCallback((percent: number, page?: number) => {
    setProgress(percent)

    // Save to localStorage (always, as fallback)
    const data: StoredProgress = {
      chapterSlug,
      chapterId,
      percent,
      page,
      updatedAt: Date.now(),
    }
    localStorage.setItem(getKey(bookSlug), JSON.stringify(data))

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
        }).catch(() => {
          // Silently fail, localStorage is backup
        })
      }, 2000) // Debounce 2s for server sync
    }
  }, [bookSlug, chapterSlug, isAuthenticated, editionId, chapterId])

  // Cleanup
  useEffect(() => {
    return () => {
      if (serverSyncRef.current) clearTimeout(serverSyncRef.current)
    }
  }, [])

  const getLastPosition = useCallback((): StoredProgress | null => {
    try {
      const stored = localStorage.getItem(getKey(bookSlug))
      if (stored) return JSON.parse(stored)
    } catch {}
    return null
  }, [bookSlug])

  return { progress, updateProgress, getLastPosition }
}
