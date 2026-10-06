import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { emitDataChange } from '../lib/dataEvents'
import {
  ANON,
  addLocalBookmark,
  bookmarkLocator,
  createServerBookmark,
  deleteServerBookmark,
  fetchServerBookmarks,
  guestOwner,
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
  /** The session is a guest: its rows stay claimable after a sign-in changes the id. */
  isGuest?: boolean
  /** The book's chapters: resolves a slug to the server id for a row saved under an offline cache key. */
  chapters?: ChapterRef[]
}

/**
 * Bookmarks for one book (catalog: `bookId` = slug; upload: the UserBook id).
 * Offline-first: every action is written locally and replayed (lib/bookmarkSync).
 */
export function useBookmarks(bookId: string, options: UseBookmarksOptions = {}) {
  const { editionId, userBook, isAuthenticated, userId, isGuest, chapters } = options
  // Signed in but the user not known yet: wait rather than file rows under 'anon'.
  const owner = !isAuthenticated ? ANON : !userId ? null : isGuest ? guestOwner(userId) : userId
  const target = useMemo<BookmarkTarget | null>(
    () => (!bookId ? null : userBook ? { kind: 'userbook', bookId } : editionId ? { kind: 'edition', bookId, editionId } : null),
    [bookId, userBook, editionId]
  )
  const canSync = !!(isAuthenticated && owner && target)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loading, setLoading] = useState(true)
  // A failed action (server-only mode, below) — the caller shows it.
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => setError(null), [])
  // No IndexedDB (private mode, blocked, quota): server-only, like uploads before the queue.
  const localOkRef = useRef(true)
  const bookmarksRef = useRef(bookmarks)
  bookmarksRef.current = bookmarks
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters
  // Results for another book / reader arriving late are dropped.
  const keyRef = useRef('')
  keyRef.current = `${bookId}|${owner}`

  const refresh = useCallback(async () => {
    if (!bookId || !owner || !localOkRef.current) return
    const key = `${bookId}|${owner}`
    try {
      const list = await loadBookmarks(bookId, owner)
      if (keyRef.current === key) setBookmarks(list)
    } catch {
      localOkRef.current = false
    }
  }, [bookId, owner])

  const sync = useCallback(async (): Promise<void> => {
    if (!canSync || !target || !owner) return
    if (localOkRef.current) {
      return syncBookmarks(target, owner, { chapters: chaptersRef.current, onChange: () => void refresh() })
    }
    const key = `${bookId}|${owner}`
    try {
      const list = await fetchServerBookmarks(target, owner)
      if (keyRef.current === key) setBookmarks(list)
    } catch {
      // offline with no local store: nothing to show
    }
  }, [canSync, target, owner, bookId, refresh])

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
      if (localOkRef.current) {
        try {
          const bm = await addLocalBookmark(bookId, owner, draft)
          await refresh()
          emitDataChange('bookmarks')
          void sync()
          return bm
        } catch {
          localOkRef.current = false
        }
      }
      // Server-only: straight to the server; a failure is shown, never swallowed.
      const existing = bookmarksRef.current.find((b) => bookmarkLocator(b) === bookmarkLocator(draft))
      if (existing) return existing
      try {
        if (!canSync || !target) throw new Error('no session')
        const bm = await createServerBookmark(target, owner, draft, chaptersRef.current)
        setBookmarks((prev) => [bm, ...prev])
        emitDataChange('bookmarks')
        return bm
      } catch {
        setError('bookmark_failed')
        return null
      }
    },
    [bookId, owner, canSync, target, refresh, sync]
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
      if (localOkRef.current) {
        try {
          // Any account row may be on the server — tombstone it even before the
          // edition id is known; a no-session row is purely local.
          await removeLocalBookmark(bookId, owner, id, owner !== ANON)
          await refresh()
          emitDataChange('bookmarks')
          void sync()
          return
        } catch {
          localOkRef.current = false
        }
      }
      try {
        if (!canSync || !target) throw new Error('no session')
        await deleteServerBookmark(target, id)
        setBookmarks((prev) => prev.filter((b) => b.id !== id))
        emitDataChange('bookmarks')
      } catch {
        setError('bookmark_failed')
      }
    },
    [bookId, owner, canSync, target, refresh, sync]
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
    error,
    clearError,
    addBookmark,
    removeBookmark,
    isBookmarked,
    getBookmarkForChapter,
    addPageBookmark,
    isPageBookmarked,
    getPageBookmark,
  }
}
