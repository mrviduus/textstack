import { useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { upsertProgress } from '../api/auth'

const STORAGE_KEY = 'reading.progress.'

interface UseReadingProgressOptions {
  editionId?: string
  chapterId?: string
  chapterSlug?: string
}

// Store for pending sync (used by lifecycle triggers)
interface PendingSync {
  editionId: string
  chapterId: string
  locator: string
  percent: number
}

export function useReadingProgress(
  bookSlug: string,
  chapterSlug: string,
  options?: UseReadingProgressOptions
) {
  const { isAuthenticated } = useAuth()
  const serverSyncRef = useRef<number | null>(null)
  const lastSyncedPercentRef = useRef<number>(0)
  const lastSyncedLocatorRef = useRef<string>('')
  const pendingSyncRef = useRef<PendingSync | null>(null)
  const { editionId, chapterId, chapterSlug: optionsChapterSlug } = options || {}
  const resolvedChapterSlug = optionsChapterSlug || chapterSlug

  // Update progress (called by reader when page changes)
  // page: page number for paginated mode
  // scrollLocator: custom locator string for scroll mode (e.g., "scroll:chapter-slug:offset")
  // overrideChapterId/overrideChapterSlug: for scroll mode where visible chapter differs
  const updateProgress = useCallback((
    percent: number,
    page?: number,
    scrollLocator?: string,
    overrideChapterId?: string,
    overrideChapterSlug?: string
  ) => {
    const effectiveChapterId = overrideChapterId || chapterId
    const effectiveChapterSlug = overrideChapterSlug || resolvedChapterSlug

    if (!editionId || !effectiveChapterId) return

    // Build locator early to check for changes
    let locator: string
    if (scrollLocator) {
      locator = scrollLocator
    } else if (page != null) {
      locator = `page:${page}`
    } else {
      locator = `percent:${percent.toFixed(4)}`
    }

    // Skip if same values synced recently (check both percent AND locator)
    const percentUnchanged = Math.abs(percent - lastSyncedPercentRef.current) < 0.01
    const locatorUnchanged = locator === lastSyncedLocatorRef.current
    if (percentUnchanged && locatorUnchanged) return
    lastSyncedPercentRef.current = percent
    lastSyncedLocatorRef.current = locator

    // Always save to localStorage (works offline, fallback if API fails)
    try {
      localStorage.setItem(`${STORAGE_KEY}${editionId}`, JSON.stringify({
        chapterId: effectiveChapterId,
        chapterSlug: effectiveChapterSlug,
        locator,
        percent,
      }))
    } catch {
      // localStorage might be full or disabled
    }

    // Store pending sync data for lifecycle triggers
    pendingSyncRef.current = {
      editionId,
      chapterId: effectiveChapterId,
      locator,
      percent,
    }

    // Also sync to server if authenticated (debounced)
    if (isAuthenticated) {
      if (serverSyncRef.current) clearTimeout(serverSyncRef.current)
      serverSyncRef.current = window.setTimeout(() => {
        upsertProgress(editionId, {
          chapterId: effectiveChapterId,
          locator,
          percent,
        }).catch(() => {})
        pendingSyncRef.current = null
      }, 2000)
    }
  }, [bookSlug, chapterSlug, isAuthenticated, editionId, chapterId, resolvedChapterSlug])

  // Flush pending sync immediately (bypasses debounce)
  const flushSave = useCallback(() => {
    if (!pendingSyncRef.current || !isAuthenticated) return

    // Cancel pending debounced sync
    if (serverSyncRef.current) {
      clearTimeout(serverSyncRef.current)
      serverSyncRef.current = null
    }

    const { editionId, chapterId, locator, percent } = pendingSyncRef.current
    // Use sendBeacon for reliability during page unload
    const payload = JSON.stringify({ chapterId, locator, percent })
    const url = `/api/me/progress/${editionId}`

    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }))
    } else {
      // Fallback to fetch (may not complete during unload)
      upsertProgress(editionId, { chapterId, locator, percent }).catch(() => {})
    }

    pendingSyncRef.current = null
  }, [isAuthenticated])

  // Lifecycle event triggers (ADR-007 section 3.3)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushSave()
      }
    }

    const handleBeforeUnload = () => {
      flushSave()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      if (serverSyncRef.current) clearTimeout(serverSyncRef.current)
    }
  }, [flushSave])

  return { updateProgress, flushSave }
}
