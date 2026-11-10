import { PERCENT_UNIT_BOOK, LOCATOR_SPACE_SCROLL, parsePdfPageLocator, v2Api } from '@textstack/shared'
import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { readUserBookProgress, saveUserBookProgress, type UserBookProgress } from '../api/userBooks'
import { v2Enabled, v2ProgressBody, rememberV2State } from '../api/v2'
import { applyV2Outcome } from '../lib/v2Reading'
import { preferLocalProgress, markProgressSynced, keepalivePut, PROGRESS_GET_TIMEOUT_MS, timeoutSignal } from '../lib/progressSync'

const STORAGE_KEY = 'userbook.progress.'
const DEBOUNCE_MS = 2000

interface SavedProgress {
  chapterSlug: string
  locator?: string
  /** Serialised TextPosition (ADR-015). Beside the locator, never instead of it. */
  positionJson?: string
  percent: number
  /** Epoch ms, this browser's clock. Never compared with the server's `updatedAt`. */
  updatedAt: number
  /** Set once the server acknowledged this exact write (markProgressSynced). */
  synced?: boolean
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
  // The progress GET got no answer for this book (timeout, offline, 5xx, 401): the restore used
  // the local record. Sticky for the book; the reader re-asks in the background.
  const [unansweredFor, setUnansweredFor] = useState<string | null>(null)
  // The server row as answered, whichever record won the merge. A PDF read in Original layout
  // resumes from its `page:<N>` when it is provably newer than this device's page — the only
  // progress GET the reader makes at open.
  const [serverRow, setServerRow] = useState<UserBookProgress | null>(null)
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
    setServerRow(null)

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
    readUserBookProgress(bookId, timeoutSignal(PROGRESS_GET_TIMEOUT_MS)).then((serverProgress) => {
      if (cancelled) return
      if (serverProgress === undefined) setUnansweredFor(bookId)
      setServerRow(serverProgress ?? null)
      if (!serverProgress?.chapterSlug) return

      const serverData: SavedProgress = {
        chapterSlug: serverProgress.chapterSlug,
        locator: serverProgress.locator ?? undefined,
        positionJson: serverProgress.positionJson ?? undefined,
        percent: serverProgress.percent ?? 0,
        updatedAt: serverProgress.updatedAt ? new Date(serverProgress.updatedAt).getTime() : 0,
        synced: true,
      }

      // Merge: an unsynced local write wins, otherwise the server (no cross-clock compare —
      // see preferLocalProgress)
      const currentStored = localStorage.getItem(`${STORAGE_KEY}${bookId}`)
      let localData: SavedProgress | null = null
      if (currentStored) {
        try {
          const parsed = JSON.parse(currentStored)
          if ('chapterSlug' in parsed) localData = parsed
        } catch {}
      }

      if (!preferLocalProgress(localData, true)) {
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

  // V2 (#1025), a write the server did not take as sent: a lost write takes the server's place
  // (moving the reader only if the place differs; a PDF page becomes the PDF view's place); a
  // replaced file reloads the book; a dropped write leaves the local place unsynced, to be sent again.
  const adoptV2 = useCallback((server: UserBookProgress, sent: SavedProgress) => {
    if (pendingSyncRef.current === sent) pendingSyncRef.current = null
    if (parsePdfPageLocator(server.locator) != null) {
      setServerRow(server) // the PDF view's page was taken by applyV2Outcome
      // The server's place is the newer one: this record no longer wins a restore.
      markProgressSynced(`${STORAGE_KEY}${bookId}`, sent.updatedAt)
      return
    }
    if (!server.chapterSlug) return
    const adopted: SavedProgress = {
      chapterSlug: server.chapterSlug,
      locator: server.locator ?? undefined,
      positionJson: server.positionJson ?? undefined,
      percent: server.percent ?? 0,
      updatedAt: Date.now(),
      synced: true,
    }
    lastAckedKeyRef.current = `${adopted.chapterSlug}:${adopted.locator ?? ''}`
    try { localStorage.setItem(`${STORAGE_KEY}${bookId}`, JSON.stringify(adopted)) } catch {}
    setSavedProgress((prev) =>
      prev && prev.chapterSlug === adopted.chapterSlug && prev.positionJson === adopted.positionJson ? prev : adopted)
  }, [bookId])

  // Sync to server (debounced). Advance lastAckedKeyRef only on success.
  const syncToServer = useCallback((data: SavedProgress) => {
    pendingSyncRef.current = data
    const dedupeKey = `${data.chapterSlug}:${data.locator ?? ''}`
    if (dedupeKey === lastAckedKeyRef.current) {
      // Same position the server already holds — the rewritten local entry is synced too.
      markProgressSynced(`${STORAGE_KEY}${bookId}`, data.updatedAt)
      return
    }

    if (serverSyncTimerRef.current) clearTimeout(serverSyncTimerRef.current)

    serverSyncTimerRef.current = window.setTimeout(() => {
      const toSync = pendingSyncRef.current
      if (!toSync || !bookId) return

      void saveUserBookProgress(bookId, {
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
        .then((outcome) => {
          // V2 marks synced only what the server accepted; legacy resolves with nothing on success.
          if (outcome && outcome !== 'accepted') {
            const adopted = applyV2Outcome(bookId, outcome)
            if (adopted) adoptV2(adopted, toSync)
            return
          }
          lastAckedKeyRef.current = `${toSync.chapterSlug}:${toSync.locator ?? ''}`
          if (pendingSyncRef.current === toSync) pendingSyncRef.current = null
          markProgressSynced(`${STORAGE_KEY}${bookId}`, toSync.updatedAt)
        })
        .catch((err) => {
          // Leave ref so next save retries. Log only — never interrupt reading.
          console.warn('[progress] userbook save failed', err)
        })
    }, DEBOUNCE_MS)
  }, [bookId, adoptV2])

  /** The V2 keepalive PUT; a book not known yet goes the ordinary way. */
  const flushV2 = useCallback((id: string, toSync: SavedProgress) => {
    const data = { ...toSync, updatedAt: new Date(toSync.updatedAt).toISOString() }
    const body = v2ProgressBody(id, data)
    const ack = () => {
      lastAckedKeyRef.current = `${toSync.chapterSlug}:${toSync.locator ?? ''}`
      markProgressSynced(`${STORAGE_KEY}${id}`, toSync.updatedAt)
    }
    if (!body) {
      void saveUserBookProgress(id, data)
        .then((outcome) => { if (outcome === 'accepted') ack() })
        .catch((err) => console.warn('[progress] userbook flush save failed', err))
      return
    }
    // A 409 here is left to the next write, which reads the answer and applies the revision rule.
    rememberV2State(keepalivePut(v2Api.readingStateUrl(id), JSON.stringify(body)).then((res) => (res.ok ? res.json() : null)))
      .then((s) => { if (s) ack() })
      .catch((err) => console.warn('[progress] userbook flush save failed', err))
  }, [])

  // Flush pending sync immediately (bypasses debounce, uses keepalive for tab close reliability)
  const flushSave = useCallback(() => {
    const toSync = pendingSyncRef.current
    if (!toSync || !bookId) return

    // Cancel pending debounced sync
    if (serverSyncTimerRef.current) {
      clearTimeout(serverSyncTimerRef.current)
      serverSyncTimerRef.current = null
    }

    if (v2Enabled()) {
      flushV2(bookId, toSync)
      pendingSyncRef.current = null
      return
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

    keepalivePut(url, payload)
      .then((res) => {
        // A non-ok answer is not an ACK: leave the dedupe key and the unsynced local entry
        // alone, so the next write of this same position is sent rather than deduped away.
        if (!res.ok) return
        lastAckedKeyRef.current = `${toSync.chapterSlug}:${toSync.locator ?? ''}`
        markProgressSynced(`${STORAGE_KEY}${bookId}`, toSync.updatedAt)
      })
      .catch((err) => {
        console.warn('[progress] userbook flush save failed', err)
      })

    pendingSyncRef.current = null
  }, [bookId, flushV2])

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

  // Stable identity: consumers put this object in effect deps (M4).
  return useMemo(() => ({
    savedProgress,
    legacyProgress, // For migration: caller can use chapterNumber to look up slug
    isLoading,
    serverUnanswered: !!bookId && unansweredFor === bookId,
    serverRow,
    saveProgress,
    flushSave,
    clearProgress,
  }), [savedProgress, legacyProgress, isLoading, bookId, unansweredFor, serverRow, saveProgress, flushSave, clearProgress])
}
