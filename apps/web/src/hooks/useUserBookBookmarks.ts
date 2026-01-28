import { useState, useEffect, useCallback } from 'react'
import {
  getUserBookBookmarks,
  createUserBookBookmark,
  deleteUserBookBookmark,
} from '../api/userBooks'
import type { Bookmark } from './useBookmarks'

export function useUserBookBookmarks(bookId: string) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loading, setLoading] = useState(true)

  // Load bookmarks from server on mount
  useEffect(() => {
    if (!bookId) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    getUserBookBookmarks(bookId)
      .then((serverBookmarks) => {
        if (cancelled) return
        setBookmarks(
          serverBookmarks.map((b) => ({
            id: b.id,
            bookId,
            chapterSlug: b.chapterSlug || b.locator.replace('chapter:', ''),
            chapterTitle: b.title || '',
            chapterId: b.chapterId,
            createdAt: new Date(b.createdAt).getTime(),
          }))
        )
      })
      .catch(() => {
        // Server unavailable
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [bookId])

  const addBookmark = useCallback(
    async (chapterId: string, chapterSlug: string | null, title: string) => {
      if (!bookId) return null

      const slug = chapterSlug || ''

      // Check if already bookmarked
      const existing = bookmarks.find((b) => b.chapterSlug === slug)
      if (existing) return existing

      try {
        const locator = `chapter:${slug}`
        const serverBookmark = await createUserBookBookmark(bookId, {
          chapterId,
          locator,
          title,
        })

        const bookmark: Bookmark = {
          id: serverBookmark.id,
          bookId,
          chapterSlug: serverBookmark.chapterSlug || slug,
          chapterTitle: serverBookmark.title || title,
          chapterId: serverBookmark.chapterId,
          createdAt: new Date(serverBookmark.createdAt).getTime(),
        }

        setBookmarks((prev) => [bookmark, ...prev])
        return bookmark
      } catch {
        return null
      }
    },
    [bookId, bookmarks]
  )

  const removeBookmark = useCallback(
    async (id: string) => {
      if (!bookId) return

      try {
        await deleteUserBookBookmark(bookId, id)
        setBookmarks((prev) => prev.filter((b) => b.id !== id))
      } catch {
        // Server unavailable
      }
    },
    [bookId]
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
