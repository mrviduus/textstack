import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getBookmarksForBook, saveBookmark, deleteBookmark, type Bookmark } from '../lib/bookmarkStore'
import {
  getPublicBookmarks,
  createPublicBookmark,
  deletePublicBookmark,
  type PublicBookmark,
} from '../api/userData'
import { emitDataChange } from '../lib/dataEvents'
import { GUID_RE } from '../lib/progressSync'
import { useNetworkRecovery } from './useNetworkRecovery'

export type { Bookmark }

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Not on the server yet. Rows from before the flag: a GUID id came from the server. */
export function isPendingBookmark(b: Bookmark): boolean {
  return b.syncStatus ? b.syncStatus === 'pending' : !GUID_RE.test(b.id)
}

const byNewest = (a: Bookmark, b: Bookmark) => b.createdAt - a.createdAt
const is404 = (e: unknown) => (e as { status?: number })?.status === 404

function fromServer(sb: PublicBookmark, bookId: string): Bookmark {
  return {
    id: sb.id,
    bookId,
    chapterSlug: sb.locator.replace('chapter:', ''),
    chapterTitle: sb.title || '',
    chapterId: sb.chapterId,
    createdAt: new Date(sb.createdAt).getTime(),
    syncStatus: 'synced',
  }
}

/**
 * Merge the server list with local rows. The server list is the truth for
 * synced rows, but it cannot know about a bookmark that never reached it
 * (pending) or one deleted here while offline (tombstone) — replacing local
 * with server used to wipe the first and resurrect the second.
 */
export function planBookmarkSync(server: Bookmark[], local: Bookmark[]) {
  const tombstones = local.filter((b) => b.deleted)
  const tombstoned = new Set(tombstones.map((b) => b.id))
  const synced = server.filter((b) => !tombstoned.has(b.id))
  const slugs = new Set(synced.map((b) => b.chapterSlug))
  // One bookmark per chapter: a pending row for a chapter the server already has is redundant.
  const create = local.filter((b) => !b.deleted && isPendingBookmark(b) && !slugs.has(b.chapterSlug))
  const remove = tombstones.filter((b) => !isPendingBookmark(b))
  const keep = new Set([...synced, ...create, ...remove].map((b) => b.id))
  return {
    store: synced,
    drop: local.filter((b) => !keep.has(b.id)).map((b) => b.id),
    visible: [...synced, ...create].sort(byNewest),
    create,
    remove,
  }
}

interface UseBookmarksOptions {
  editionId?: string // For server sync (public books)
  isAuthenticated?: boolean
}

export function useBookmarks(bookId: string, options?: UseBookmarksOptions) {
  const { editionId, isAuthenticated } = options || {}
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loading, setLoading] = useState(true)
  const syncingRef = useRef(false)

  const canSync = !!(isAuthenticated && editionId)

  // Merge server + local, then replay pending creates and tombstoned deletes.
  const syncWithServer = useCallback(async (isCancelled: () => boolean) => {
    if (!editionId || syncingRef.current) return
    syncingRef.current = true
    try {
      const server = (await getPublicBookmarks(editionId)).map((sb) => fromServer(sb, bookId))
      const plan = planBookmarkSync(server, await getBookmarksForBook(bookId))
      for (const b of plan.store) await saveBookmark(b)
      for (const id of plan.drop) await deleteBookmark(id)
      if (isCancelled()) return
      setBookmarks(plan.visible)

      for (const b of plan.remove) {
        try {
          await deletePublicBookmark(b.id)
        } catch (e) {
          if (!is404(e)) continue // still offline: keep the tombstone
        }
        await deleteBookmark(b.id)
      }
      for (const b of plan.create) {
        // Never send a non-server id (an old cache key): it stays local until fixed.
        if (!b.chapterId || !GUID_RE.test(b.chapterId)) continue
        try {
          const sb = await createPublicBookmark({ editionId, chapterId: b.chapterId, locator: `chapter:${b.chapterSlug}`, title: b.chapterTitle })
          const saved = { ...fromServer(sb, bookId), chapterSlug: b.chapterSlug, chapterTitle: b.chapterTitle }
          await deleteBookmark(b.id)
          await saveBookmark(saved)
          if (!isCancelled()) setBookmarks((prev) => prev.map((p) => (p.id === b.id ? saved : p)))
        } catch {
          // Stays pending for the next sync.
        }
      }
    } catch {
      // Server unavailable: local data stands.
    } finally {
      syncingRef.current = false
    }
  }, [bookId, editionId])

  // Load bookmarks: IndexedDB first, then server if authenticated
  useEffect(() => {
    if (!bookId) {
      setLoading(false)
      return
    }

    let cancelled = false
    const localLoaded = getBookmarksForBook(bookId)
      .then((local) => {
        if (!cancelled) setBookmarks(local.filter((b) => !b.deleted).sort(byNewest))
      })
      .catch(() => {})

    if (canSync) {
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
  }, [bookId, canSync, syncWithServer])

  // Back online → replay whatever is still pending.
  const recoveryOptions = useMemo(
    () => ({ onOnline: () => { if (canSync && bookId) void syncWithServer(() => false) } }),
    [canSync, bookId, syncWithServer]
  )
  useNetworkRecovery(recoveryOptions)

  const addBookmark = useCallback(
    async (chapterSlug: string, chapterTitle: string, chapterId?: string) => {
      const existing = bookmarks.find((b) => b.chapterSlug === chapterSlug)
      if (existing) return existing

      let bookmark: Bookmark = {
        id: generateId(),
        bookId,
        chapterSlug,
        chapterTitle,
        chapterId,
        createdAt: Date.now(),
        syncStatus: 'pending',
      }

      if (canSync && chapterId && GUID_RE.test(chapterId)) {
        try {
          const sb = await createPublicBookmark({
            editionId: editionId!,
            chapterId,
            locator: `chapter:${chapterSlug}`,
            title: chapterTitle,
          })
          bookmark = { ...fromServer(sb, bookId), chapterSlug, chapterTitle }
        } catch {
          // Stays pending; replayed on the next sync.
        }
      }

      await saveBookmark(bookmark)
      setBookmarks((prev) => [bookmark, ...prev])
      emitDataChange('bookmarks')
      return bookmark
    },
    [bookId, editionId, canSync, bookmarks]
  )

  const removeBookmark = useCallback(
    async (id: string) => {
      const bm = bookmarks.find((b) => b.id === id)
      setBookmarks((prev) => prev.filter((b) => b.id !== id))
      emitDataChange('bookmarks')
      if (!bm) return

      let confirmed = isPendingBookmark(bm) // never on the server: nothing to delete there
      if (!confirmed && canSync) {
        try {
          await deletePublicBookmark(id)
          confirmed = true
        } catch (e) {
          confirmed = is404(e)
        }
      }
      // Unconfirmed: keep a tombstone so the next server list can't resurrect it.
      if (confirmed) await deleteBookmark(id)
      else await saveBookmark({ ...bm, deleted: true })
    },
    [bookmarks, canSync]
  )

  const isBookmarked = useCallback(
    (chapterSlug: string) => {
      return bookmarks.some((b) => b.chapterSlug === chapterSlug)
    },
    [bookmarks]
  )

  const getBookmarkForChapter = useCallback(
    (chapterSlug: string) => {
      return bookmarks.find((b) => b.chapterSlug === chapterSlug)
    },
    [bookmarks]
  )

  return {
    bookmarks,
    loading,
    addBookmark,
    removeBookmark,
    isBookmarked,
    getBookmarkForChapter,
  }
}
