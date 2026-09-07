import { useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { upsertProgress } from '../api/auth'
import { PERCENT_UNIT_BOOK } from '@textstack/shared'

const STORAGE_KEY = 'reading.progress.'

interface UseReadingProgressOptions {
  editionId?: string
  chapterId?: string
  chapterSlug?: string
}

interface PendingSync {
  editionId: string
  chapterId: string
  locator: string
  positionJson?: string
  percent: number
  updatedAt: number
}

export function useReadingProgress(
  bookSlug: string,
  chapterSlug: string,
  options?: UseReadingProgressOptions
) {
  const { isAuthenticated } = useAuth()
  const serverSyncRef = useRef<number | null>(null)
  // Only advanced after server ACK — transient fails won't lock out retries.
  const lastAckedKeyRef = useRef<string>('')
  const pendingSyncRef = useRef<PendingSync | null>(null)
  const { editionId, chapterId, chapterSlug: optionsChapterSlug } = options || {}
  const resolvedChapterSlug = optionsChapterSlug || chapterSlug

  const updateProgress = useCallback((
    percent: number,
    page?: number,
    scrollLocator?: string,
    overrideChapterId?: string,
    overrideChapterSlug?: string,
    /** Serialised TextPosition — where the reader is in the TEXT (ADR-015).
     *  Travels beside the locator, never instead of it: the locator is what a
     *  build that predates this reads. Absent means absent, and the server
     *  clears the stored one rather than leaving it beside a fresher pixel. */
    positionJson?: string,
  ) => {
    const effectiveChapterId = overrideChapterId || chapterId
    const effectiveChapterSlug = overrideChapterSlug || resolvedChapterSlug

    if (!editionId || !effectiveChapterId) return

    let locator: string
    if (scrollLocator) {
      locator = scrollLocator
    } else if (page != null) {
      locator = `page:${page}`
    } else {
      locator = `percent:${percent.toFixed(4)}`
    }

    const updatedAt = Date.now()

    try {
      localStorage.setItem(`${STORAGE_KEY}${editionId}`, JSON.stringify({
        chapterId: effectiveChapterId,
        chapterSlug: effectiveChapterSlug,
        locator,
        positionJson,
        percent,
        updatedAt,
      }))
    } catch {
      // localStorage might be full or disabled
    }

    pendingSyncRef.current = {
      editionId,
      chapterId: effectiveChapterId,
      locator,
      positionJson,
      percent,
      updatedAt,
    }

    if (!isAuthenticated) return

    const dedupeKey = `${locator}:${percent.toFixed(4)}`
    // Skip server sync only if the last *successful* sync matches — not if we merely
    // attempted the same payload. That way a failed sync stays retriable.
    if (dedupeKey === lastAckedKeyRef.current) return

    if (serverSyncRef.current) clearTimeout(serverSyncRef.current)
    serverSyncRef.current = window.setTimeout(() => {
      const payload = pendingSyncRef.current
      if (!payload) return
      upsertProgress(payload.editionId, {
        chapterId: payload.chapterId,
        locator: payload.locator,
        positionJson: payload.positionJson,
        percent: payload.percent,
        updatedAt: new Date(payload.updatedAt).toISOString(),
      })
        .then(() => {
          lastAckedKeyRef.current = `${payload.locator}:${payload.percent.toFixed(4)}`
          if (pendingSyncRef.current === payload) pendingSyncRef.current = null
        })
        .catch((err) => {
          // Leave lastAckedKeyRef as-is so subsequent updateProgress retries.
          // Log only — never interrupt reading with a toast/UI.
          console.warn('[progress] save failed', err)
        })
    }, 2000)
  }, [bookSlug, chapterSlug, isAuthenticated, editionId, chapterId, resolvedChapterSlug])

  // Flush pending sync immediately via keepalive fetch (bypasses debounce).
  const flushSave = useCallback(() => {
    const payload = pendingSyncRef.current
    if (!payload || !isAuthenticated) return

    if (serverSyncRef.current) {
      clearTimeout(serverSyncRef.current)
      serverSyncRef.current = null
    }

    // Hand-built rather than routed through upsertProgress because this one has
    // to be a keepalive fetch — which means the declarations upsertProgress adds
    // for every other writer have to be repeated here. They were not: this path
    // sent no `percentUnit`, so the LAST write before a tab closes, the one most
    // likely to be the newest the server ever sees, silently failed to store its
    // percentage (Application.ReadingTracking.ProgressUnit drops an undeclared one).
    const body = JSON.stringify({
      chapterId: payload.chapterId,
      locator: payload.locator,
      positionJson: payload.positionJson,
      percent: payload.percent,
      percentUnit: PERCENT_UNIT_BOOK,
      updatedAt: new Date(payload.updatedAt).toISOString(),
    })

    fetch(`/api/me/progress/${payload.editionId}`, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      keepalive: true,
    })
      .then(() => {
        lastAckedKeyRef.current = `${payload.locator}:${payload.percent.toFixed(4)}`
      })
      .catch((err) => {
        console.warn('[progress] flush save failed', err)
      })

    pendingSyncRef.current = null
  }, [isAuthenticated])

  // Belt-and-suspenders lifecycle flush. The caller (ReaderPage) also flushes explicitly
  // after its own debounced write — whichever handler fires first wins.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushSave()
    }
    const handleBeforeUnload = () => flushSave()

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      flushSave()
      if (serverSyncRef.current) clearTimeout(serverSyncRef.current)
    }
  }, [flushSave])

  return { updateProgress, flushSave }
}
