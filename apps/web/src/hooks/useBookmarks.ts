import { useState, useEffect, useCallback } from 'react'
import { openOfflineDb } from '../lib/offlineDb'

export interface Bookmark {
  id: string
  bookId: string
  chapterSlug: string
  chapterTitle: string
  createdAt: number
}

const STORE_NAME = 'bookmarks'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function getAllBookmarks(bookId: string): Promise<Bookmark[]> {
  const db = await openOfflineDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('bookId')
    const request = index.getAll(bookId)

    request.onsuccess = () => {
      const bookmarks = request.result as Bookmark[]
      // Sort by createdAt descending (newest first)
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

async function findBookmark(bookId: string, chapterSlug: string): Promise<Bookmark | null> {
  const bookmarks = await getAllBookmarks(bookId)
  return bookmarks.find((b) => b.chapterSlug === chapterSlug) || null
}

export function useBookmarks(bookId: string) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loading, setLoading] = useState(true)

  // Load bookmarks on mount
  useEffect(() => {
    if (!bookId) return
    setLoading(true)
    getAllBookmarks(bookId)
      .then(setBookmarks)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [bookId])

  const addBookmark = useCallback(async (chapterSlug: string, chapterTitle: string) => {
    const existing = await findBookmark(bookId, chapterSlug)
    if (existing) return existing

    const bookmark = await addBookmarkToDB({ bookId, chapterSlug, chapterTitle })
    setBookmarks((prev) => [bookmark, ...prev])
    return bookmark
  }, [bookId])

  const removeBookmark = useCallback(async (id: string) => {
    await removeBookmarkFromDB(id)
    setBookmarks((prev) => prev.filter((b) => b.id !== id))
  }, [])

  const isBookmarked = useCallback((chapterSlug: string) => {
    return bookmarks.some((b) => b.chapterSlug === chapterSlug)
  }, [bookmarks])

  const getBookmarkForChapter = useCallback((chapterSlug: string) => {
    return bookmarks.find((b) => b.chapterSlug === chapterSlug)
  }, [bookmarks])

  return {
    bookmarks,
    loading,
    addBookmark,
    removeBookmark,
    isBookmarked,
    getBookmarkForChapter,
  }
}
