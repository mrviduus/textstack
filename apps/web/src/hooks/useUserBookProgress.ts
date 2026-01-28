import { useEffect, useCallback, useRef, useState } from 'react'
import { getUserBookProgress, saveUserBookProgress } from '../api/userBooks'

const STORAGE_KEY = 'userbook.progress.'
const DEBOUNCE_MS = 2000

interface SavedProgress {
  chapterSlug: string
  locator?: string
  percent: number
  updatedAt: number
}

// Legacy format for migration
interface LegacyProgress {
  chapterNumber: number
  page: number
  percent: number
  updatedAt: number
}

export function useUserBookProgress(bookId: string) {
  const [savedProgress, setSavedProgress] = useState<SavedProgress | null>(null)
  // Legacy progress requiring migration (has chapterNumber, needs slug)
  const [legacyProgress, setLegacyProgress] = useState<LegacyProgress | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const lastSavedRef = useRef<{ slug: string; locator?: string } | null>(null)
  const serverSyncTimerRef = useRef<number | null>(null)
  const pendingSyncRef = useRef<SavedProgress | null>(null)

  // Load from localStorage first, then fetch from server
  useEffect(() => {
    if (!bookId) {
      setIsLoading(false)
      return
    }

    let cancelled = false

    // 1. Load from localStorage (instant)
    try {
      const stored = localStorage.getItem(`${STORAGE_KEY}${bookId}`)
      if (stored) {
        const data = JSON.parse(stored)
        // Check if this is legacy format (has chapterNumber, no chapterSlug)
        if ('chapterNumber' in data && !('chapterSlug' in data)) {
          setLegacyProgress(data as LegacyProgress)
        } else if ('chapterSlug' in data) {
          setSavedProgress(data as SavedProgress)
        }
      }
    } catch {
      // Invalid data, ignore
    }

    // 2. Fetch from server in background
    getUserBookProgress(bookId).then((serverProgress) => {
      if (cancelled || !serverProgress?.chapterSlug) return

      const serverData: SavedProgress = {
        chapterSlug: serverProgress.chapterSlug,
        locator: serverProgress.locator ?? undefined,
        percent: serverProgress.percent ?? 0,
        updatedAt: serverProgress.updatedAt ? new Date(serverProgress.updatedAt).getTime() : 0,
      }

      // Merge: use newer timestamp
      const currentStored = localStorage.getItem(`${STORAGE_KEY}${bookId}`)
      let localData: SavedProgress | null = null
      if (currentStored) {
        try {
          const parsed = JSON.parse(currentStored)
          if ('chapterSlug' in parsed) localData = parsed
        } catch {}
      }

      if (!localData || serverData.updatedAt > localData.updatedAt) {
        // Server is newer → update localStorage + state
        try {
          localStorage.setItem(`${STORAGE_KEY}${bookId}`, JSON.stringify(serverData))
        } catch {}
        setSavedProgress(serverData)
        setLegacyProgress(null)
      }
    }).catch(() => {
      // Server unavailable, use localStorage
    }).finally(() => {
      if (!cancelled) setIsLoading(false)
    })

    return () => { cancelled = true }
  }, [bookId])

  // Sync to server (debounced)
  const syncToServer = useCallback((data: SavedProgress) => {
    pendingSyncRef.current = data
    if (serverSyncTimerRef.current) clearTimeout(serverSyncTimerRef.current)

    serverSyncTimerRef.current = window.setTimeout(() => {
      const toSync = pendingSyncRef.current
      if (!toSync || !bookId) return
      pendingSyncRef.current = null

      saveUserBookProgress(bookId, {
        chapterSlug: toSync.chapterSlug,
        locator: toSync.locator,
        percent: toSync.percent,
        updatedAt: new Date(toSync.updatedAt).toISOString(),
      }).catch(() => {
        // Server unavailable, localStorage is still saved
      })
    }, DEBOUNCE_MS)
  }, [bookId])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (serverSyncTimerRef.current) clearTimeout(serverSyncTimerRef.current)
      // Flush pending sync immediately on unmount
      const toSync = pendingSyncRef.current
      if (toSync && bookId) {
        saveUserBookProgress(bookId, {
          chapterSlug: toSync.chapterSlug,
          locator: toSync.locator,
          percent: toSync.percent,
          updatedAt: new Date(toSync.updatedAt).toISOString(),
        }).catch(() => {})
      }
    }
  }, [bookId])

  // Save progress - uses slug + locator
  const saveProgress = useCallback((chapterSlug: string, _page: number, percent: number, locator?: string) => {
    if (!bookId) return

    // Skip if same position
    const last = lastSavedRef.current
    if (last && last.slug === chapterSlug && last.locator === locator) return
    lastSavedRef.current = { slug: chapterSlug, locator }

    const data: SavedProgress = {
      chapterSlug,
      locator,
      percent,
      updatedAt: Date.now(),
    }

    // Save to localStorage immediately
    try {
      localStorage.setItem(`${STORAGE_KEY}${bookId}`, JSON.stringify(data))
      setLegacyProgress(null)
      setSavedProgress(data)
    } catch {
      // localStorage full or disabled
    }

    // Sync to server (debounced)
    syncToServer(data)
  }, [bookId, syncToServer])

  // Clear progress (e.g., when book is deleted)
  const clearProgress = useCallback(() => {
    if (!bookId) return
    try {
      localStorage.removeItem(`${STORAGE_KEY}${bookId}`)
    } catch {
      // Ignore
    }
    setSavedProgress(null)
  }, [bookId])

  return {
    savedProgress,
    legacyProgress, // For migration: caller can use chapterNumber to look up slug
    isLoading,
    saveProgress,
    clearProgress,
  }
}
