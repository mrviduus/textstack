import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { getProgress } from '../api/auth'

const STORAGE_KEY = 'reading.progress.'

interface LocalProgress {
  chapterId: string
  chapterSlug: string
  locator: string
  /** Serialised TextPosition (ADR-015). Absent on entries written before it. */
  positionJson?: string
  percent: number
  /** Epoch ms. Optional for backward-compat with pre-fix entries (treated as 0 → server wins). */
  updatedAt?: number
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
  })
  // Composite-key dedupe: re-fetch when editionId OR isAuthenticated changes.
  // Covers the "user logs in mid-reading" case — without this, post-login server data
  // never reaches savedProgress until a reload.
  const lastFetchKeyRef = useRef<string | null>(null)

  useEffect(() => {
    // Wait for auth check and editionId
    if (authLoading || !editionId) return
    // Skip if we've already fetched for this (editionId, auth) combo
    const fetchKey = `${editionId}:${isAuthenticated}`
    if (lastFetchKeyRef.current === fetchKey) return
    lastFetchKeyRef.current = fetchKey

    async function fetchProgress() {
      // Skip restore when navigating directly from TOC (?direct=1)
      const params = new URLSearchParams(window.location.search)
      if (params.get('direct') === '1') {
        setState(s => ({ ...s, isLoading: false }))
        return
      }

      let progress: SavedProgress | null = null

      // Always check localStorage first (works offline, always available)
      try {
        const stored = localStorage.getItem(`${STORAGE_KEY}${editionId}`)
        if (stored) {
          const local = JSON.parse(stored) as LocalProgress
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
      // LWW: newer timestamp wins. Percent-based merge was broken — a stale server record
      // at 95% of ch1 beat a fresh local record at 20% of ch5, tossing the user back.
      if (isAuthenticated) {
        try {
          const serverProgress = await getProgress(editionId!)
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
            if (!progress || serverData.updatedAt > progress.updatedAt) {
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
      setState({
        savedProgress: progress,
        isLoading: false,
        shouldNavigate: false,
        targetChapterSlug: null,
      })
    }

    fetchProgress()
  }, [editionId, isAuthenticated, authLoading])

  return state
}
