import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { emitDataChange } from '../lib/dataEvents'
import {
  ANON,
  addLocalBookmark,
  bookmarkLocator,
  loadBookmarks,
  removeLocalBookmark,
  syncBookmarks,
  type Bookmark,
  type BookmarkDraft,
  type BookmarkTarget,
  type ChapterRef,
} from '../lib/bookmarkSync'
import { useNetworkRecovery } from './useNetworkRecovery'

export type { Bookmark }

interface UseBookmarksOptions {
  /** Catalog book: its edition id (server sync). */
  editionId?: string
  /** `bookId` is an upload's id (/me/books/{id}/bookmarks). */
  userBook?: boolean
  isAuthenticated?: boolean
  /** The signed-in user: local rows are kept per user. */
  userId?: string | null
  /** The book's chapters: resolves a slug to the server id for a row saved under an offline cache key. */
  chapters?: ChapterRef[]
}

/**
 * Bookmarks for one book (catalog: `bookId` = slug; upload: the UserBook id).
 * Offline-first: every action is written locally and replayed (lib/bookmarkSync).
 */
export function useBookmarks(bookId: string, options: UseBookmarksOptions = {}) {
  const { editionId, userBook, isAuthenticated, userId, chapters } = options
  // Signed in but the user not known yet: wait rather than file rows under 'anon'.
  const owner = isAuthenticated ? userId || null : ANON
  const target = useMemo<BookmarkTarget | null>(
    () => (!bookId ? null : userBook ? { kind: 'userbook', bookId } : editionId ? { kind: 'edition', bookId, editionId } : null),
    [bookId, userBook, editionId]
  )
  const canSync = !!(isAuthenticated && owner && target)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loading, setLoading] = useState(true)
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters
  // Results for another book / reader arriving late are dropped.
  const keyRef = useRef('')
  keyRef.current = `${bookId}|${owner}`

  const refresh = useCallback(async () => {
    if (!bookId || !owner) return
    const key = `${bookId}|${owner}`
    try {
      const list = await loadBookmarks(bookId, owner)
      if (keyRef.current === key) setBookmarks(list)
    } catch {
      // IndexedDB unavailable
    }
  }, [bookId, owner])

  const sync = useCallback((): Promise<void> => {
    if (!canSync || !target || !owner) return Promise.resolve()
    return syncBookmarks(target, owner, { chapters: chaptersRef.current, onChange: () => void refresh() })
  }, [canSync, target, owner, refresh])

  useEffect(() => {
    if (!bookId || !owner) {
      setBookmarks([])
      setLoading(!!bookId)
      return
    }
    let cancelled = false
    setLoading(true)
    refresh()
      .then(sync)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bookId, owner, refresh, sync])

  // Back online → replay whatever is still pending.
  const recoveryOptions = useMemo(() => ({ onOnline: () => void sync() }), [sync])
  useNetworkRecovery(recoveryOptions)

  const add = useCallback(
    async (draft: BookmarkDraft): Promise<Bookmark | null> => {
      if (!bookId || !owner) return null
      let bm: Bookmark
      try {
        bm = await addLocalBookmark(bookId, owner, draft)
      } catch {
        return null
      }
      await refresh()
      emitDataChange('bookmarks')
      void sync()
      return bm
    },
    [bookId, owner, refresh, sync]
  )

  const addBookmark = useCallback(
    (chapterSlug: string, chapterTitle: string, chapterId?: string) => add({ chapterSlug, chapterTitle, chapterId }),
    [add]
  )

  // --- Page bookmarks (Original-layout PDF): anchored to a 1-based page
  // (`locator: page:<N>`, `chapterId: null` on the server). ---
  const addPageBookmark = useCallback(
    async (page: number) => {
      if (!Number.isFinite(page) || page < 1) return null
      return add({ chapterSlug: '', chapterTitle: `Page ${page}`, page })
    },
    [add]
  )

  const removeBookmark = useCallback(
    async (id: string) => {
      if (!bookId || !owner) return
      try {
        // Any account row may be on the server — tombstone it even before the
        // edition id is known; a no-session row is purely local.
        await removeLocalBookmark(bookId, owner, id, owner !== ANON)
      } catch {
        return
      }
      await refresh()
      emitDataChange('bookmarks')
      void sync()
    },
    [bookId, owner, refresh, sync]
  )

  const isBookmarked = useCallback(
    (chapterSlug: string) => bookmarks.some((b) => b.page == null && b.chapterSlug === chapterSlug),
    [bookmarks]
  )

  const getBookmarkForChapter = useCallback(
    (chapterSlug: string) => bookmarks.find((b) => b.page == null && b.chapterSlug === chapterSlug),
    [bookmarks]
  )

  const isPageBookmarked = useCallback(
    (page: number) => bookmarks.some((b) => bookmarkLocator(b) === `page:${page}`),
    [bookmarks]
  )

  const getPageBookmark = useCallback(
    (page: number) => bookmarks.find((b) => bookmarkLocator(b) === `page:${page}`),
    [bookmarks]
  )

  return {
    bookmarks,
    loading,
    addBookmark,
    removeBookmark,
    isBookmarked,
    getBookmarkForChapter,
    addPageBookmark,
    isPageBookmarked,
    getPageBookmark,
  }
}
