import { useState, useEffect, useCallback, useRef } from 'react'
import { openOfflineDb } from '../lib/offlineDb'
import {
  getPublicBookmarks,
  createPublicBookmark,
  deletePublicBookmark,
} from '../api/userData'

export interface Bookmark {
  id: string
  bookId: string
  chapterSlug: string
  chapterTitle: string
  chapterId?: string // For server sync
  createdAt: number
}

const STORE_NAME = 'bookmarks'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function getAllBookmarksFromDB(bookId: string): Promise<Bookmark[]> {
  const db = await openOfflineDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('bookId')
    const request = index.getAll(bookId)

    request.onsuccess = () => {
      const bookmarks = request.result as Bookmark[]
      bookmarks.sort((a, b) => b.createdAt - a.createdAt)
      resolve(bookmarks)
    }
    request.onerror = () => reject(request.error)
  })
}

async function addBookmarkToDB(bookmark: Omit<Bookmark, 'id' | 'createdAt'>): Promise<Bookmark> {
  const db = await openOfflineDb()
  const newBookmark: Bookmark = {
    ...bookmark,
    id: generateId(),
    createdAt: Date.now(),
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.add(newBookmark)

    request.onsuccess = () => resolve(newBookmark)
    request.onerror = () => reject(request.error)
  })
}

async function removeBookmarkFromDB(id: string): Promise<void> {
  const db = await openOfflineDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.delete(id)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function clearBookmarksFromDB(bookId: string): Promise<void> {
  const db = await openOfflineDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('bookId')
    const request = index.openCursor(bookId)

    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      } else {
        resolve()
      }
    }
    request.onerror = () => reject(request.error)
  })
}

interface UseBookmarksOptions {
  editionId?: string // For server sync (public books)
  isAuthenticated?: boolean
}

export function useBookmarks(bookId: string, options?: UseBookmarksOptions) {
  const { editionId, isAuthenticated } = options || {}
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loading, setLoading] = useState(true)
  const serverSyncedRef = useRef(false)

  // Load bookmarks: IndexedDB first, then server if authenticated
  useEffect(() => {
    if (!bookId) {
      setLoading(false)
      return
    }

    let cancelled = false
    serverSyncedRef.current = false

    // 1. Load from IndexedDB first (instant)
    getAllBookmarksFromDB(bookId)
      .then((localBookmarks) => {
        if (cancelled) return
        setBookmarks(localBookmarks)
      })
      .catch(() => {})

    // 2. If authenticated with editionId, fetch from server
    if (isAuthenticated && editionId) {
      getPublicBookmarks(editionId)
        .then(async (serverBookmarks) => {
          if (cancelled) return
          serverSyncedRef.current = true

          // Convert server bookmarks to local format
          const converted: Bookmark[] = serverBookmarks.map((sb) => ({
            id: sb.id,
            bookId,
            chapterSlug: sb.locator.replace('chapter:', ''),
            chapterTitle: sb.title || '',
            chapterId: sb.chapterId,
            createdAt: new Date(sb.createdAt).getTime(),
          }))

          // Replace local with server data
          await clearBookmarksFromDB(bookId)
          for (const bm of converted) {
            await addBookmarkToDB({ ...bm })
          }

          if (!cancelled) setBookmarks(converted)
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
  }, [bookId, editionId, isAuthenticated])

  const addBookmark = useCallback(
    async (chapterSlug: string, chapterTitle: string, chapterId?: string) => {
      // Check if already bookmarked
      const existing = bookmarks.find((b) => b.chapterSlug === chapterSlug)
      if (existing) return existing

      // If authenticated with editionId, create on server first
      if (isAuthenticated && editionId && chapterId) {
        try {
          const serverBookmark = await createPublicBookmark({
            editionId,
            chapterId,
            locator: `chapter:${chapterSlug}`,
            title: chapterTitle,
          })

          const bookmark: Bookmark = {
            id: serverBookmark.id,
            bookId,
            chapterSlug,
            chapterTitle,
            chapterId,
            createdAt: new Date(serverBookmark.createdAt).getTime(),
          }

          // Also save to IndexedDB for offline
          await addBookmarkToDB({ bookId, chapterSlug, chapterTitle, chapterId })
          setBookmarks((prev) => [bookmark, ...prev])
          return bookmark
        } catch {
          // Fall through to local-only
        }
      }

      // Local-only bookmark
      const bookmark = await addBookmarkToDB({ bookId, chapterSlug, chapterTitle, chapterId })
      setBookmarks((prev) => [bookmark, ...prev])
      return bookmark
    },
    [bookId, editionId, isAuthenticated, bookmarks]
  )

  const removeBookmark = useCallback(
    async (id: string) => {
      // If authenticated, delete from server
      if (isAuthenticated && editionId) {
        try {
          await deletePublicBookmark(id)
        } catch {
          // Server unavailable, continue with local delete
        }
      }

      await removeBookmarkFromDB(id)
      setBookmarks((prev) => prev.filter((b) => b.id !== id))
    },
    [editionId, isAuthenticated]
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
