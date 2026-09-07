import { PERCENT_UNIT_BOOK, LOCATOR_SPACE_SCROLL } from '@textstack/shared'
import { useEffect, useCallback, useRef, useState } from 'react'
import { getUserBookProgress, saveUserBookProgress } from '../api/userBooks'

const STORAGE_KEY = 'userbook.progress.'
const DEBOUNCE_MS = 2000

interface SavedProgress {
  chapterSlug: string
  locator?: string
  /** Serialised TextPosition (ADR-015). Beside the locator, never instead of it. */
  positionJson?: string
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
  // Only advanced after server ACK — transient fails stay retriable.
  const lastAckedKeyRef = useRef<string>('')
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
        positionJson: serverProgress.positionJson ?? undefined,
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

  // Sync to server (debounced). Advance lastAckedKeyRef only on success.
  const syncToServer = useCallback((data: SavedProgress) => {
    pendingSyncRef.current = data
    const dedupeKey = `${data.chapterSlug}:${data.locator ?? ''}`
    if (dedupeKey === lastAckedKeyRef.current) return

    if (serverSyncTimerRef.current) clearTimeout(serverSyncTimerRef.current)

    serverSyncTimerRef.current = window.setTimeout(() => {
      const toSync = pendingSyncRef.current
      if (!toSync || !bookId) return

      saveUserBookProgress(bookId, {
        chapterSlug: toSync.chapterSlug,
        locator: toSync.locator,
        positionJson: toSync.positionJson,
        percent: toSync.percent,
        // Both declarations are required or the server ignores what they
        // describe: without percentUnit the number is dropped (which is what
        // this hook was doing since the unit contract shipped — web has stored
        // NO percent for uploaded books since then), and without locatorKind a
        // scroll write cannot replace a PDF page locator.
        percentUnit: PERCENT_UNIT_BOOK,
        locatorKind: LOCATOR_SPACE_SCROLL,
        updatedAt: new Date(toSync.updatedAt).toISOString(),
      })
        .then(() => {
          lastAckedKeyRef.current = `${toSync.chapterSlug}:${toSync.locator ?? ''}`
          if (pendingSyncRef.current === toSync) pendingSyncRef.current = null
        })
        .catch((err) => {
          // Leave ref so next save retries. Log only — never interrupt reading.
          console.warn('[progress] userbook save failed', err)
        })
    }, DEBOUNCE_MS)
  }, [bookId])

  // Flush pending sync immediately (bypasses debounce, uses keepalive for tab close reliability)
  const flushSave = useCallback(() => {
    const toSync = pendingSyncRef.current
    if (!toSync || !bookId) return

    // Cancel pending debounced sync
    if (serverSyncTimerRef.current) {
      clearTimeout(serverSyncTimerRef.current)
      serverSyncTimerRef.current = null
    }

    const payload = JSON.stringify({
      chapterSlug: toSync.chapterSlug,
      locator: toSync.locator,
      positionJson: toSync.positionJson,
      percent: toSync.percent,
      // Same two declarations as the debounced path above. This body is built
      // by hand rather than by a shared builder, which is exactly how it came to
      // be missing one of them.
      percentUnit: PERCENT_UNIT_BOOK,
      locatorKind: LOCATOR_SPACE_SCROLL,
      updatedAt: new Date(toSync.updatedAt).toISOString(),
    })
    const url = `/api/me/books/${bookId}/progress`

    // Use fetch with keepalive (survives page unload like sendBeacon, but supports PUT)
    fetch(url, {
      method: 'PUT',
      body: payload,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      keepalive: true,
    })
      .then(() => {
        lastAckedKeyRef.current = `${toSync.chapterSlug}:${toSync.locator ?? ''}`
      })
      .catch((err) => {
        console.warn('[progress] userbook flush save failed', err)
      })

    pendingSyncRef.current = null
  }, [bookId])

  // Lifecycle event triggers: flush pending sync on tab switch/close
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
      flushSave()
      if (serverSyncTimerRef.current) clearTimeout(serverSyncTimerRef.current)
    }
  }, [flushSave])

  // Save progress - uses slug + locator
  const saveProgress = useCallback((
    chapterSlug: string,
    _page: number,
    percent: number,
    locator?: string,
    /** Serialised TextPosition (ADR-015) — beside the locator, never instead. */
    positionJson?: string,
  ) => {
    if (!bookId) return

    const data: SavedProgress = {
      chapterSlug,
      locator,
      positionJson,
      percent,
      updatedAt: Date.now(),
    }

    // Save to localStorage immediately (always — offline/fallback safety)
    try {
      localStorage.setItem(`${STORAGE_KEY}${bookId}`, JSON.stringify(data))
      setLegacyProgress(null)
      setSavedProgress(data)
    } catch {
      // localStorage full or disabled
    }

    // Sync to server (debounced, server-side dedupe)
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
    flushSave,
    clearProgress,
  }
}
