import { useCallback, useState, MutableRefObject } from 'react'
import { bookmarksApi, bookmarkChapterSlug } from '@textstack/shared'
import type { BookmarkDto, Chapter } from '@textstack/shared'

/** Extract chapterSlug from bookmark locator (format: "chapter:slug") */
function getSlugFromLocator(locator: string): string {
  return bookmarkChapterSlug(locator)
}

type ToastFn = (t: { message: string; variant: 'error' | 'success' | 'info' }) => void

type Options = {
  editionIdRef: MutableRefObject<string | null>
  isAuthenticated: boolean
  showToast: ToastFn
}

export function useReaderBookmarks({ editionIdRef, isAuthenticated, showToast }: Options) {
  const [bookmarks, setBookmarks] = useState<BookmarkDto[]>([])

  const isBookmarked = useCallback(
    (slug: string | null | undefined) =>
      !!slug && bookmarks.some(b => getSlugFromLocator(b.locator) === slug),
    [bookmarks]
  )

  const toggle = useCallback(
    async ({ chapter, slug }: { chapter: Chapter; slug: string }) => {
      if (!isAuthenticated || !editionIdRef.current) return
      const existing = bookmarks.find(b => getSlugFromLocator(b.locator) === slug)
      if (existing) {
        // Optimistic remove — restore on server reject so the UI doesn't
        // silently lie about state (P2-3).
        setBookmarks(prev => prev.filter(b => b.id !== existing.id))
        try {
          await bookmarksApi.deleteBookmark(existing.id)
        } catch {
          setBookmarks(prev => (prev.some(b => b.id === existing.id) ? prev : [...prev, existing]))
          showToast({ message: 'Could not remove bookmark. Try again.', variant: 'error' })
        }
      } else {
        try {
          const bm = await bookmarksApi.createBookmark({
            editionId: editionIdRef.current,
            chapterId: chapter.id,
            locator: `chapter:${slug}`,
            title: chapter.title,
          })
          setBookmarks(prev => [...prev, bm])
        } catch {
          showToast({ message: 'Could not add bookmark. Try again.', variant: 'error' })
        }
      }
    },
    [bookmarks, isAuthenticated, editionIdRef, showToast]
  )

  const remove = useCallback(
    async (id: string) => {
      // Snapshot for rollback (P2-3); without it the bookmark vanishes from
      // the sheet even though it's still on the server.
      const snapshot = bookmarks.find(b => b.id === id)
      setBookmarks(prev => prev.filter(b => b.id !== id))
      try {
        await bookmarksApi.deleteBookmark(id)
      } catch {
        if (snapshot) {
          setBookmarks(prev => (prev.some(b => b.id === id) ? prev : [...prev, snapshot]))
        }
        showToast({ message: 'Could not remove bookmark. Try again.', variant: 'error' })
      }
    },
    [bookmarks, showToast]
  )

  return { bookmarks, setBookmarks, isBookmarked, toggle, remove }
}

export { getSlugFromLocator }
