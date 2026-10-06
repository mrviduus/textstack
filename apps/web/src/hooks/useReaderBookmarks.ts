import { useCallback } from 'react'
import { useBookmarks, type Bookmark } from './useBookmarks'
import type { ReaderMode, NormalizedBook } from './useReaderChapter'
import type { Chapter } from '../types/api'

interface Params {
  mode: ReaderMode
  bookSlug: string | undefined
  userBookId: string | undefined
  publicEditionId: string | undefined
  publicChapter: Chapter | null
  book: NormalizedBook | null
  isAuthenticated: boolean
  /** Signed-in user id: offline bookmark rows are kept per user. */
  userId?: string | null
}

export interface UseReaderBookmarksResult {
  bookmarks: Bookmark[]
  isBookmarked: (chapterSlug: string) => boolean
  getBookmarkForChapter: (chapterSlug: string) => Bookmark | undefined
  removeBookmark: (id: string) => void | Promise<unknown>
  addBookmark: (chapterSlug: string, chapterTitle: string) => Promise<unknown>
  // Page bookmarks — userbook Original-layout PDF only.
  addPageBookmark: (page: number) => Promise<unknown>
  isPageBookmarked: (page: number) => boolean
  getPageBookmark: (page: number) => Bookmark | undefined
}

export function useReaderBookmarks({
  mode,
  bookSlug,
  userBookId,
  publicEditionId,
  publicChapter,
  book,
  isAuthenticated,
  userId,
}: Params): UseReaderBookmarksResult {
  const isUpload = mode === 'userbook'
  // One offline queue for catalog books and uploads (lib/bookmarkSync).
  const active = useBookmarks(isUpload ? (userBookId || '') : (bookSlug || ''), {
    editionId: isUpload ? undefined : publicEditionId,
    userBook: isUpload,
    isAuthenticated,
    userId,
    chapters: book?.chapters,
  })
  const { addBookmark: add } = active

  const addBookmark = useCallback(
    async (chapterSlug: string, chapterTitle: string) => {
      // The book's chapter list holds the server id for the slug being bookmarked.
      const ch = book?.chapters.find(c => c.identifier === chapterSlug)
      return add(chapterSlug, chapterTitle, ch?.id ?? (isUpload ? undefined : publicChapter?.id))
    },
    [isUpload, publicChapter?.id, book?.chapters, add],
  )

  return {
    bookmarks: active.bookmarks,
    isBookmarked: active.isBookmarked,
    getBookmarkForChapter: active.getBookmarkForChapter,
    removeBookmark: active.removeBookmark,
    addBookmark,
    addPageBookmark: active.addPageBookmark,
    isPageBookmarked: active.isPageBookmarked,
    getPageBookmark: active.getPageBookmark,
  }
}
