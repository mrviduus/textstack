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
  // A tombstone names its server row by id when it has one. A row that never
  // had a server id — pending, or a legacy row the old code stored under a
  // fresh local id — names it by chapter (one bookmark per chapter).
  const remove: { serverId: string; localId: string }[] = []
  const removed = new Set<string>()
  for (const t of local.filter((b) => b.deleted)) {
    const twin = server.find((s) => s.id === t.id)
      ?? (isPendingBookmark(t) ? server.find((s) => s.chapterSlug === t.chapterSlug && !removed.has(s.id)) : undefined)
    if (twin && !removed.has(twin.id)) {
      remove.push({ serverId: twin.id, localId: t.id })
      removed.add(twin.id)
    }
  }
  const synced = server.filter((b) => !removed.has(b.id))
  const slugs = new Set(synced.map((b) => b.chapterSlug))
  // A pending (or legacy) row for a chapter the server already has IS that row.
  const create = local.filter((b) => !b.deleted && isPendingBookmark(b) && !slugs.has(b.chapterSlug))
  const keep = new Set([...synced.map((b) => b.id), ...create.map((b) => b.id), ...remove.map((r) => r.localId)])
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
  /** The book's chapters: resolves a slug to the server id for a row saved under an offline cache key. */
  chapters?: { id: string; identifier: string }[]
}

export function useBookmarks(bookId: string, options?: UseBookmarksOptions) {
  const { editionId, isAuthenticated, chapters } = options || {}
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loading, setLoading] = useState(true)
  // Syncs run one at a time (no double POST of a pending row) but each with its
  // own cancellation: a re-run never early-returns on another run's flag.
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const bookRef = useRef(bookId)
  bookRef.current = bookId
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters
  // Local ids removed while a sync may be creating them on the server.
  const removedRef = useRef(new Set<string>())

  const canSync = !!(isAuthenticated && editionId)

  const serverChapterId = (b: Pick<Bookmark, 'chapterId' | 'chapterSlug'>): string | undefined =>
    b.chapterId && GUID_RE.test(b.chapterId)
      ? b.chapterId
      : chaptersRef.current?.find((c) => c.identifier === b.chapterSlug)?.id

  // Merge server + local, then replay pending creates and tombstoned deletes.
  const runSync = async (forBook: string, ed: string, isCancelled: () => boolean) => {
    const stale = () => isCancelled() || bookRef.current !== forBook
    if (stale()) return
    const server = (await getPublicBookmarks(ed)).map((sb) => fromServer(sb, forBook))
    const plan = planBookmarkSync(server, await getBookmarksForBook(forBook))
    for (const b of plan.store) await saveBookmark(b)
    for (const id of plan.drop) await deleteBookmark(id)
    if (!stale()) setBookmarks(plan.visible)

    for (const r of plan.remove) {
      try {
        await deletePublicBookmark(r.serverId)
      } catch (e) {
        if (!is404(e)) continue // still offline: keep the tombstone
      }
      await deleteBookmark(r.localId)
    }
    for (const b of plan.create) {
      // Never send a non-server id (an old cache key): it stays local until resolvable.
      const chapterId = serverChapterId(b)
      if (!chapterId || removedRef.current.has(b.id)) continue
      let sb: PublicBookmark
      try {
        sb = await createPublicBookmark({ editionId: ed, chapterId, locator: `chapter:${b.chapterSlug}`, title: b.chapterTitle })
      } catch {
        continue // stays pending for the next sync
      }
      const saved: Bookmark = { ...fromServer(sb, forBook), chapterSlug: b.chapterSlug, chapterTitle: b.chapterTitle }
      await deleteBookmark(b.id)
      if (removedRef.current.has(b.id)) {
        // Removed while the create was in flight: delete what it just made.
        try {
          await deletePublicBookmark(saved.id)
        } catch (e) {
          if (!is404(e)) await saveBookmark({ ...saved, deleted: true })
        }
        continue
      }
      await saveBookmark(saved)
      if (!stale()) setBookmarks((prev) => prev.map((p) => (p.id === b.id ? saved : p)))
    }
  }

  const syncWithServer = useCallback((isCancelled: () => boolean): Promise<void> => {
    if (!editionId) return Promise.resolve()
    const forBook = bookId
    const run = queueRef.current.then(() => runSync(forBook, editionId, isCancelled)).catch(() => {
      // Server unavailable: local data stands.
    })
    queueRef.current = run
    return run
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSync reads refs only
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

      // Re-adding a chapter cancels an earlier chapter-matched tombstone, which
      // would otherwise delete this new bookmark at the next sync.
      for (const t of await getBookmarksForBook(bookId).catch(() => [] as Bookmark[])) {
        if (t.deleted && isPendingBookmark(t) && t.chapterSlug === chapterSlug) await deleteBookmark(t.id)
      }

      const serverId = serverChapterId({ chapterId, chapterSlug })
      if (canSync && serverId) {
        try {
          const sb = await createPublicBookmark({
            editionId: editionId!,
            chapterId: serverId,
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

      removedRef.current.add(id)
      // A pending or legacy row may be on the server after all (a create in
      // flight, or the old code's fresh-id copy of a server row): it gets a
      // tombstone, which the next sync matches by chapter or drops.
      let confirmed = false
      if (!isPendingBookmark(bm) && canSync) {
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
