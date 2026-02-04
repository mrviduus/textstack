import { useState, useEffect, useCallback, useRef } from 'react'
import {
  type StoredHighlight,
  type TextAnchor,
  type HighlightColor,
  getHighlightsForEdition,
  getHighlightsForChapter,
  saveHighlight,
  deleteHighlight as deleteHighlightFromDB,
  deleteHighlightsByEdition,
} from '../lib/offlineDb'
import {
  getPublicHighlights,
  createPublicHighlight,
  updatePublicHighlight,
  deletePublicHighlight,
} from '../api/userData'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

interface UseHighlightsOptions {
  chapterId?: string
  isAuthenticated?: boolean
}

export function useHighlights(editionId: string, options?: UseHighlightsOptions) {
  const { chapterId, isAuthenticated } = options || {}
  const [highlights, setHighlights] = useState<StoredHighlight[]>([])
  const [loading, setLoading] = useState(true)
  const serverSyncedRef = useRef(false)

  // Load highlights: IndexedDB first, then server if authenticated
  useEffect(() => {
    if (!editionId) {
      setLoading(false)
      return
    }

    let cancelled = false
    serverSyncedRef.current = false

    // 1. Load from IndexedDB first (instant)
    const loadLocal = chapterId
      ? getHighlightsForChapter(editionId, chapterId)
      : getHighlightsForEdition(editionId)

    loadLocal
      .then((localHighlights) => {
        if (cancelled) return
        setHighlights(localHighlights)
      })
      .catch(() => {})

    // 2. If authenticated, fetch from server
    if (isAuthenticated) {
      getPublicHighlights(editionId)
        .then(async (serverHighlights) => {
          if (cancelled) return
          serverSyncedRef.current = true

          // Convert server highlights to local format
          const converted: StoredHighlight[] = serverHighlights.map((sh) => ({
            id: sh.id,
            editionId: sh.editionId,
            chapterId: sh.chapterId,
            anchor: JSON.parse(sh.anchorJson) as TextAnchor,
            color: sh.color as HighlightColor,
            selectedText: sh.selectedText,
            noteText: sh.noteText ?? undefined,
            syncStatus: 'synced' as const,
            version: sh.version,
            createdAt: new Date(sh.createdAt).getTime(),
            updatedAt: new Date(sh.updatedAt).getTime(),
          }))

          // Replace local with server data for this edition
          await deleteHighlightsByEdition(editionId)
          for (const h of converted) {
            await saveHighlight(h)
          }

          // Filter by chapter if needed
          const filtered = chapterId
            ? converted.filter((h) => h.chapterId === chapterId)
            : converted

          if (!cancelled) setHighlights(filtered)
        })
        .catch(() => {
          // Server unavailable, use local data
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    } else {
      setLoading(false)
    }

    return () => {
      cancelled = true
    }
  }, [editionId, chapterId, isAuthenticated])

  const addHighlight = useCallback(
    async (
      anchor: TextAnchor,
      color: HighlightColor,
      selectedText: string
    ): Promise<StoredHighlight> => {
      const now = Date.now()
      const highlight: StoredHighlight = {
        id: generateId(),
        editionId,
        chapterId: anchor.chapterId,
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
          const serverHighlight = await createPublicHighlight({
            editionId,
            chapterId: anchor.chapterId,
            anchorJson: JSON.stringify(anchor),
            color,
            selectedText,
          })

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
      return highlight
    },
    [editionId, isAuthenticated]
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
      return updated
    },
    [highlights, isAuthenticated]
  )

  const removeHighlight = useCallback(
    async (id: string) => {
      // If authenticated, delete from server
      if (isAuthenticated) {
        try {
          await deletePublicHighlight(id)
        } catch {
          // Server unavailable, continue with local delete
        }
      }

      await deleteHighlightFromDB(id)
      setHighlights((prev) => prev.filter((h) => h.id !== id))
    },
    [isAuthenticated]
  )

  const getHighlightsForRange = useCallback(
    (startOffset: number, endOffset: number): StoredHighlight[] => {
      return highlights.filter((h) => {
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
