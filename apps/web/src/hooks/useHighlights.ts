import { useState, useEffect, useCallback, useMemo } from 'react'
import { isPdfAnchor } from '@textstack/shared'
import {
  type StoredHighlight,
  type HighlightAnchor,
  type HighlightColor,
  getHighlightsForEdition,
  getHighlightsForUserBook,
  saveHighlight,
  deleteHighlight as deleteHighlightFromDB,
} from '../lib/offlineDb'
import {
  createPublicHighlight,
  updatePublicHighlight,
  deletePublicHighlight,
} from '../api/userData'
import { ApiError } from '../api/client'
import { emitDataChange } from '../lib/dataEvents'
import { syncBookHighlights, isLocalHighlightId, fromServerHighlight } from '../lib/highlightSync'
import { useNetworkRecovery } from './useNetworkRecovery'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

interface UseHighlightsOptions {
  isAuthenticated?: boolean
}

export function useHighlights(editionId?: string, userBookId?: string, options?: UseHighlightsOptions) {
  const { isAuthenticated } = options || {}
  const [highlights, setHighlights] = useState<StoredHighlight[]>([])
  const [loading, setLoading] = useState(true)
  // The book whose list is fully loaded. `loading` alone is false before the
  // book id is known and stale for one render after it changes — a ?highlight=
  // link reading it gave up on an empty list.
  const [loadedBookId, setLoadedBookId] = useState<string | null>(null)
  const bookId = userBookId || editionId || ''
  const isUserBook = !!userBookId

  // Merge server + local pending, then replay (lib/highlightSync — shared with the
  // post-sign-in replay, and serialized with it).
  const syncWithServer = useCallback(
    (isCancelled: () => boolean) =>
      syncBookHighlights(bookId, isUserBook, {
        isCancelled,
        onVisible: setHighlights,
        onReplaced: (oldId, saved) => setHighlights((prev) => prev.map((p) => (p.id === oldId ? saved : p))),
      }),
    [bookId, isUserBook]
  )

  // Load highlights: IndexedDB first, then server if authenticated.
  // We intentionally do NOT filter by chapter — the scroll reader mounts
  // multiple chapters and every visible chapter needs its highlights.
  useEffect(() => {
    if (!bookId) {
      setLoading(false)
      return
    }

    let cancelled = false

    const loadLocal = isUserBook
      ? getHighlightsForUserBook(bookId)
      : getHighlightsForEdition(bookId)

    const localLoaded = loadLocal
      .then((localHighlights) => {
        if (cancelled) return
        setHighlights(localHighlights.filter((h) => !h.deleted))
      })
      .catch(() => {})

    if (isAuthenticated) {
      // After the local paint, so a slow IndexedDB read can't overwrite the merged list.
      localLoaded
        .then(() => syncWithServer(() => cancelled))
        .finally(() => {
          if (!cancelled) { setLoading(false); setLoadedBookId(bookId) }
        })
    } else {
      // After the local read: "loaded" with an empty list made a ?highlight= link
      // give up before the highlight it names had been read.
      localLoaded.finally(() => {
        if (!cancelled) { setLoading(false); setLoadedBookId(bookId) }
      })
    }

    return () => {
      cancelled = true
    }
  }, [bookId, isAuthenticated, isUserBook, syncWithServer])

  // Back online → replay whatever is still pending.
  const recoveryOptions = useMemo(
    () => ({ onOnline: () => { if (isAuthenticated && bookId) void syncWithServer(() => false) } }),
    [isAuthenticated, bookId, syncWithServer]
  )
  useNetworkRecovery(recoveryOptions)

  const addHighlight = useCallback(
    async (
      anchor: HighlightAnchor,
      color: HighlightColor,
      selectedText: string
    ): Promise<StoredHighlight> => {
      const now = Date.now()
      // PDF (Original-layout) anchors are chapterless — no chapterId /
      // userChapterId (backend S-a accepts null). Reflow anchors carry a
      // chapter-relative TextAnchor.
      const isPdf = isPdfAnchor(anchor)
      const chapterId = isPdf ? '' : anchor.chapterId
      const highlight: StoredHighlight = {
        id: generateId(),
        editionId: isUserBook ? '' : bookId,
        chapterId,
        userBookId: isUserBook ? bookId : undefined,
        userChapterId: isUserBook && !isPdf ? chapterId : undefined,
        anchor,
        color,
        selectedText,
        syncStatus: 'pending',
        version: 1,
        createdAt: now,
        updatedAt: now,
      }

      // If authenticated, create on server first
      if (isAuthenticated) {
        try {
          const serverHighlight = await createPublicHighlight(
            isUserBook
              ? {
                  userBookId: bookId,
                  // Omit userChapterId for PDF highlights (chapterless).
                  userChapterId: isPdf ? undefined : chapterId,
                  anchorJson: JSON.stringify(anchor),
                  color,
                  selectedText,
                }
              : {
                  editionId: bookId,
                  chapterId,
                  anchorJson: JSON.stringify(anchor),
                  color,
                  selectedText,
                }
          )

          highlight.id = serverHighlight.id
          highlight.syncStatus = 'synced'
          highlight.version = serverHighlight.version
          highlight.createdAt = new Date(serverHighlight.createdAt).getTime()
          highlight.updatedAt = new Date(serverHighlight.updatedAt).getTime()
        } catch {
          // Continue with local-only
        }
      }

      await saveHighlight(highlight)
      setHighlights((prev) => [highlight, ...prev])
      emitDataChange('highlights')
      return highlight
    },
    [bookId, isAuthenticated, isUserBook]
  )

  const updateHighlight = useCallback(
    async (
      id: string,
      updates: { color?: HighlightColor; noteText?: string | null }
    ): Promise<StoredHighlight | null> => {
      const existing = highlights.find((h) => h.id === id)
      if (!existing) return null

      // An earlier offline note edit still pending must ride along with this update.
      const noteEdited = updates.noteText !== undefined || (existing.syncStatus === 'pending' && !!existing.noteEdited)
      let updated: StoredHighlight = {
        ...existing,
        ...updates,
        // Convert null to undefined for storage
        noteText: updates.noteText === null ? undefined : (updates.noteText ?? existing.noteText),
        noteEdited,
        // The server state this edit starts from — replay three-way-merges against it.
        // Kept from the first pending edit; `version` stays the server's.
        base:
          existing.syncStatus === 'synced'
            ? { version: existing.version, color: existing.color, noteText: existing.noteText }
            : existing.base,
        updatedAt: Date.now(),
        syncStatus: 'pending',
      }

      let replay = false
      if (isAuthenticated) {
        if (existing.syncStatus === 'synced') {
          try {
            // Conditional on the version we last saw: another device's edit since → 409.
            const serverHighlight = await updatePublicHighlight(id, {
              color: updates.color,
              noteText: updates.noteText !== undefined ? (updated.noteText ?? null) : undefined,
              version: existing.version,
            })
            updated = fromServerHighlight(serverHighlight) // synced: no base, no pending note
          } catch (err) {
            // 409: merge with the newer server row now. Otherwise (offline) the row stays
            // pending for the next sync.
            replay = err instanceof ApiError && err.status === 409
          }
        } else {
          // Earlier edits still pending: the sync merges them all against the server row.
          replay = true
        }
      }

      await saveHighlight(updated)
      setHighlights((prev) => prev.map((h) => (h.id === id ? updated : h)))
      emitDataChange('highlights')
      if (replay) void syncWithServer(() => false)
      return updated
    },
    [highlights, isAuthenticated, syncWithServer]
  )

  const removeHighlight = useCallback(
    async (id: string) => {
      let confirmed = !isAuthenticated
      // A client-id row never reached the server (as far as we know) — leave a
      // tombstone so sync can remove its twin if a lost-response create did land.
      if (isAuthenticated && !isLocalHighlightId(id)) {
        try {
          await deletePublicHighlight(id)
          confirmed = true
        } catch (err) {
          confirmed = err instanceof ApiError && err.status === 404
        }
      }

      const existing = highlights.find((h) => h.id === id)
      if (confirmed || !existing) await deleteHighlightFromDB(id)
      // Server unreachable: keep a tombstone so the next sync replays the delete
      // instead of the server list resurrecting it.
      else await saveHighlight({ ...existing, deleted: true, syncStatus: 'pending' })
      setHighlights((prev) => prev.filter((h) => h.id !== id))
      emitDataChange('highlights')
    },
    [highlights, isAuthenticated]
  )

  const getHighlightsForRange = useCallback(
    (startOffset: number, endOffset: number): StoredHighlight[] => {
      return highlights.filter((h) => {
        // PDF (quad-rect) anchors have no text offsets — they're never located
        // by range overlap. Skip so they don't corrupt reflow range queries.
        if (isPdfAnchor(h.anchor)) return false
        const hStart = h.anchor.startOffset
        const hEnd = h.anchor.endOffset
        // Check if ranges overlap
        return hStart < endOffset && hEnd > startOffset
      })
    },
    [highlights]
  )

  return {
    highlights,
    loading,
    loadedBookId,
    addHighlight,
    updateHighlight,
    removeHighlight,
    getHighlightsForRange,
  }
}
