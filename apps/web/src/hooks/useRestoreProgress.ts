import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { readProgress } from '../api/auth'
import { preferLocalProgress, PROGRESS_GET_TIMEOUT_MS, timeoutSignal } from '../lib/progressSync'

const STORAGE_KEY = 'reading.progress.'

interface LocalProgress {
  chapterId: string
  chapterSlug: string
  locator: string
  /** Serialised TextPosition (ADR-015). Absent on entries written before it. */
  positionJson?: string
  percent: number
  /** Epoch ms, this browser's clock. Never compared with the server's `updatedAt`. */
  updatedAt?: number
  /** Set once the server acknowledged this exact write (markProgressSynced). */
  synced?: boolean
}

interface SavedProgress {
  chapterSlug: string | null
  locator: string
  /** Serialised TextPosition (ADR-015). Preferred over `locator` on restore. */
  positionJson?: string | null
  percent?: number
  /** Epoch ms. 0 when unknown. */
  updatedAt: number
}

interface RestoreState {
  savedProgress: SavedProgress | null
  isLoading: boolean
  /** @deprecated auto-navigate removed — URL is authoritative. Always false. */
  shouldNavigate: boolean
  /** @deprecated auto-navigate removed. Always null. */
  targetChapterSlug: string | null
  /**
   * The restore has no server answer behind it: auth or the progress GET took longer than
   * PROGRESS_GET_TIMEOUT_MS, or the GET failed (offline, 5xx, 401). `savedProgress` is this
   * device's record. Sticky for the book — the reader re-asks in the background and applies
   * the newer-position rules. Never set for a `?direct=1` open, which asks nothing.
   */
  serverUnanswered: boolean
}

export function useRestoreProgress(
  editionId: string | undefined,
  _currentChapterSlug: string | undefined
): RestoreState {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const [state, setState] = useState<RestoreState>({
    savedProgress: null,
    isLoading: true,
    shouldNavigate: false,
    targetChapterSlug: null,
    serverUnanswered: false,
  })
  const [unansweredFor, setUnansweredFor] = useState<string | null>(null)
  // Composite-key dedupe: re-fetch when editionId OR isAuthenticated changes.
  // Covers the "user logs in mid-reading" case — without this, post-login server data
  // never reaches savedProgress until a reload.
  const lastFetchKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!editionId) return
    // Auth first, but not forever: past the deadline restore from this device as a signed-out
    // reader would. When auth settles signed in, the key changes and the server is asked then.
    if (authLoading) {
      if (lastFetchKeyRef.current?.startsWith(`${editionId}:`)) return
      const timer = window.setTimeout(() => {
        lastFetchKeyRef.current = `${editionId}:false`
        void fetchProgress(false, true)
      }, PROGRESS_GET_TIMEOUT_MS)
      return () => clearTimeout(timer)
    }
    // Skip if we've already fetched for this (editionId, auth) combo
    const fetchKey = `${editionId}:${isAuthenticated}`
    if (lastFetchKeyRef.current === fetchKey) return
    lastFetchKeyRef.current = fetchKey
    void fetchProgress(isAuthenticated)

    async function fetchProgress(askServer: boolean, authTimedOut = false) {
      // Skip restore when navigating directly from TOC (?direct=1)
      const params = new URLSearchParams(window.location.search)
      if (params.get('direct') === '1') {
        setState(s => ({ ...s, isLoading: false }))
        return
      }
      if (authTimedOut) setUnansweredFor(editionId!)

      let progress: SavedProgress | null = null
      let local: LocalProgress | null = null

      // Always check localStorage first (works offline, always available)
      try {
        const stored = localStorage.getItem(`${STORAGE_KEY}${editionId}`)
        if (stored) {
          local = JSON.parse(stored) as LocalProgress
          progress = {
            chapterSlug: local.chapterSlug,
            locator: local.locator,
            positionJson: local.positionJson,
            percent: local.percent,
            updatedAt: local.updatedAt ?? 0,
          }
        }
      } catch {
        // localStorage might be unavailable
      }

      // If authenticated, check server (may have newer data from another device).
      // Not by timestamp (two clocks) nor by percent (a stale 95% of ch1 beat a fresh 20% of
      // ch5): an unsynced local write wins, otherwise the server does — see preferLocalProgress.
      if (askServer) {
        try {
          const serverProgress = await readProgress(editionId!, timeoutSignal(PROGRESS_GET_TIMEOUT_MS))
          if (serverProgress === undefined) setUnansweredFor(editionId!)
          if (serverProgress) {
            const serverData: SavedProgress = {
              chapterSlug: serverProgress.chapterSlug,
              locator: serverProgress.locator,
              positionJson: serverProgress.positionJson,
              percent: serverProgress.percent ?? undefined,
              updatedAt: serverProgress.updatedAt
                ? Date.parse(serverProgress.updatedAt)
                : 0,
            }
            if (!preferLocalProgress(local, true)) {
              progress = serverData
            }
          }
        } catch {
          // Server error, use localStorage
        }
      }

      // URL is authoritative: don't auto-navigate to saved chapter. "Continue
      // reading" entry points link directly to the saved slug, so this hook
      // only exposes savedProgress for within-chapter scroll restore.
      setState(s => ({ ...s, savedProgress: progress, isLoading: false }))
    }
  }, [editionId, isAuthenticated, authLoading])

  return { ...state, serverUnanswered: !!editionId && unansweredFor === editionId }
}
