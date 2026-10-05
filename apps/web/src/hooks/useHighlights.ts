import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
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
  getPublicHighlights,
  getUserBookHighlights,
  createPublicHighlight,
  updatePublicHighlight,
  deletePublicHighlight,
} from '../api/userData'
import { ApiError } from '../api/client'
import { emitDataChange } from '../lib/dataEvents'
import { planHighlightSync, fromServerHighlight, isLocalHighlightId } from '../lib/highlightSync'
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
  const serverSyncedRef = useRef(false)

  const bookId = userBookId || editionId || ''
  const isUserBook = !!userBookId

  // Fetch server list, merge with local pending rows (local pending wins and
  // stays visible), then replay pending creates/updates/deletes. A failed replay
  // leaves the row pending for the next load / `online` event — never discarded.
  // Runs are serialized (each starts after the previous finished and re-reads
  // IndexedDB), so overlapping triggers can't POST the same pending row twice.
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve())
  const syncOnce = useCallback(
    async (isCancelled: () => boolean) => {
      try {
        const serverHighlights = isUserBook
          ? await getUserBookHighlights(bookId)
          : await getPublicHighlights(bookId)
        if (isCancelled()) return
        serverSyncedRef.current = true

        const local = isUserBook
          ? await getHighlightsForUserBook(bookId)
          : await getHighlightsForEdition(bookId)
        const plan = planHighlightSync(serverHighlights.map(fromServerHighlight), local)

        // Reconcile, don't wipe-and-rebuild (see git history: a wipe window
        // could leave IndexedDB empty on navigation).
        for (const h of plan.store) await saveHighlight(h)
        for (const id of plan.drop) await deleteHighlightFromDB(id)
        if (isCancelled()) return
        setHighlights(plan.visible)

        let changed = false
        for (const h of plan.create) {
          try {
            const created = fromServerHighlight(
              await createPublicHighlight(
                h.userBookId
                  ? {
                      userBookId: h.userBookId,
                      userChapterId: h.userChapterId,
                      anchorJson: JSON.stringify(h.anchor),
                      color: h.color,
                      selectedText: h.selectedText,
                      noteText: h.noteText,
                    }
                  : {
                      editionId: h.editionId,
                      chapterId: h.chapterId,
                      anchorJson: JSON.stringify(h.anchor),
                      color: h.color,
                      selectedText: h.selectedText,
                      noteText: h.noteText,
                    }
              )
            )
            await saveHighlight(created)
            await deleteHighlightFromDB(h.id)
            if (!isCancelled()) setHighlights((prev) => prev.map((p) => (p.id === h.id ? created : p)))
            changed = true
          } catch {
            // stays pending
          }
        }
        for (const h of plan.update) {
          try {
            // No `version`: the offline edit is the reader's latest intent (last write wins).
            // A note absent locally was removed offline — `null` clears it on the server too.
            const saved = fromServerHighlight(await updatePublicHighlight(h.id, { color: h.color, noteText: h.noteText ?? null }))
            await saveHighlight(saved)
            if (!isCancelled()) setHighlights((prev) => prev.map((p) => (p.id === h.id ? saved : p)))
            changed = true
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) await deleteHighlightFromDB(h.id)
          }
        }
        for (const { serverId, localId } of plan.remove) {
          try {
            await deletePublicHighlight(serverId)
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 404)) continue // stays pending
          }
          await deleteHighlightFromDB(localId)
          changed = true
        }
        if (changed) emitDataChange('highlights')
      } catch {
        // Server unavailable, keep local data.
      }
    },
    [bookId, isUserBook]
  )
  const syncWithServer = useCallback(
    (isCancelled: () => boolean) => {
      const run = syncQueueRef.current.then(() => syncOnce(isCancelled))
      syncQueueRef.current = run
      return run
    },
    [syncOnce]
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
    serverSyncedRef.current = false

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
          if (!cancelled) setLoading(false)
        })
    } else {
      setLoading(false)
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

      const updated: StoredHighlight = {
        ...existing,
        ...updates,
        // Convert null to undefined for storage
        noteText: updates.noteText === null ? undefined : (updates.noteText ?? existing.noteText),
        updatedAt: Date.now(),
        version: existing.version + 1,
        syncStatus: 'pending',
      }

      // If authenticated, update on server
      if (isAuthenticated) {
        try {
          const serverHighlight = await updatePublicHighlight(id, {
            color: updates.color,
            noteText: updates.noteText,
            version: existing.version,
          })

          updated.syncStatus = 'synced'
          updated.version = serverHighlight.version
          updated.updatedAt = new Date(serverHighlight.updatedAt).getTime()
        } catch {
          // Continue with local update
        }
      }

      await saveHighlight(updated)
      setHighlights((prev) => prev.map((h) => (h.id === id ? updated : h)))
      emitDataChange('highlights')
      return updated
    },
    [highlights, isAuthenticated]
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
    addHighlight,
    updateHighlight,
    removeHighlight,
    getHighlightsForRange,
  }
}
