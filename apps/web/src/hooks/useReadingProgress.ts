import { useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { upsertProgress } from '../api/auth'

const STORAGE_KEY = 'reading.progress.'

interface UseReadingProgressOptions {
  editionId?: string
  chapterId?: string
  chapterSlug?: string
  onSave?: () => void
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
  const { editionId, chapterId, chapterSlug: optionsChapterSlug, onSave } = options || {}
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
      onSave?.()
    } catch {
      // localStorage might be full or disabled
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
      }, 2000)
    }
  }, [bookSlug, chapterSlug, isAuthenticated, editionId, chapterId, resolvedChapterSlug, onSave])

  // Cleanup
  useEffect(() => {
    return () => {
      if (serverSyncRef.current) clearTimeout(serverSyncRef.current)
    }
  }, [])

  return { updateProgress }
}
