import { useEffect, useState, MutableRefObject } from 'react'
import { createBooksApi, bookmarksApi } from '@textstack/shared'
import type { ChapterSummary, Language, BookmarkDto } from '@textstack/shared'
import { getAllCachedBooks } from '../lib/offlineDb'

type Options = {
  bookSlug: string | undefined
  language: Language
  isAuthenticated: boolean
  /** Screen-owned refs the hook mutates from the API response — kept here so
   * other hooks (progress, highlights, vocab, …) can keep reading them. */
  editionIdRef: MutableRefObject<string | null>
  bookTitleRef: MutableRefObject<string | null>
  totalWordCountRef: MutableRefObject<number>
  /** Initial bookmarks load on auth users — mirrors the current inline behaviour. */
  setBookmarks: (b: BookmarkDto[]) => void
}

/**
 * Resolves edition id + book metadata from `bookSlug`. On network failure
 * falls back to the offline book catalog so a fully downloaded book still
 * picks up its editionId, title, and bookmarks (progress events keep
 * working downstream).
 *
 * Side effects (intentional, mirror the previous inline effect):
 * - Mutates `editionIdRef`, `bookTitleRef`, `totalWordCountRef`
 * - Loads bookmarks via `setBookmarks` for authed users
 */
export function useReaderBook({
  bookSlug,
  language,
  isAuthenticated,
  editionIdRef,
  bookTitleRef,
  totalWordCountRef,
  setBookmarks,
}: Options) {
  const [bookTitle, setBookTitle] = useState('')
  const [chapters, setChapters] = useState<ChapterSummary[]>([])
  // State mirror of editionIdRef so consumers (e.g. useReaderHighlights) can
  // depend on it in effect deps. The ref alone wouldn't re-trigger an effect
  // when its value lands after chapterId.
  const [editionId, setEditionId] = useState<string | null>(null)
  // Drives TocSheet's loading vs empty state — without it an empty chapters
  // array looks the same whether fetch is in-flight or actually returned 0.
  const [chaptersLoading, setChaptersLoading] = useState(true)

  useEffect(() => {
    if (!bookSlug) return
    let cancelled = false
    setChaptersLoading(true)
    // The DEVICE first, never awaited by the request: a downloaded book has its edition id
    // here, and the id is what restore and every save are keyed on. Waiting for getBook left a
    // hung network with no id at all — no restore, no saves for the visit (C1). The server's
    // answer, when it comes, is the same id.
    getAllCachedBooks().then(books => {
      if (cancelled || editionIdRef.current) return
      const match = books.find(b => b.slug === bookSlug)
      if (!match) return
      editionIdRef.current = match.editionId
      setEditionId(match.editionId)
      if (!bookTitleRef.current) {
        bookTitleRef.current = match.title
        setBookTitle(match.title)
      }
    }).catch(() => {})
    const api = createBooksApi(language)
    api.getBook(bookSlug)
      .then(b => {
        if (cancelled) return
        editionIdRef.current = b.id
        setEditionId(b.id)
        bookTitleRef.current = b.title
        setBookTitle(b.title)
        if (b.chapters) {
          setChapters(b.chapters)
          // Null-guard on wordCount so a chapter missing the field doesn't
          // turn the sum into NaN (book-progress calc downstream divides
          // by it; NaN propagates and breaks the footer percent).
          totalWordCountRef.current = b.chapters.reduce(
            (sum, c) => sum + (typeof c.wordCount === 'number' && c.wordCount > 0 ? c.wordCount : 0),
            0,
          )
        }
        if (isAuthenticated) {
          bookmarksApi.getBookmarks(b.id)
            .then(res => { if (!cancelled) setBookmarks(res) })
            .catch(() => {})
        }
      })
      .catch(() => { /* offline: the device answer above stands */ })
      .finally(() => { if (!cancelled) setChaptersLoading(false) })
    return () => { cancelled = true }
  }, [bookSlug, isAuthenticated, language, editionIdRef, bookTitleRef, totalWordCountRef, setBookmarks])

  return { bookTitle, chapters, editionId, chaptersLoading }
}
