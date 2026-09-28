import { useEffect, useRef, useState, MutableRefObject } from 'react'
import { createBooksApi } from '@textstack/shared'
import type { Chapter, Language } from '@textstack/shared'
import { getCachedChapter, refreshCachedChapter, getAllCachedBooks } from '../lib/offlineDb'

type Options = {
  bookSlug: string | undefined
  chapterSlug: string | undefined
  language: Language
  /** Resolved edition id for the current book (set by the book-meta effect in the screen). */
  editionIdRef: MutableRefObject<string | null>
}

/**
 * Owns the chapter fetch: **device first**, network second.
 *
 * It used to be the other way round, and the cache was a fallback for when the
 * request failed. That is fine on a plane, where `fetch` rejects in
 * milliseconds — and wrong on every network that is *present but useless*: a
 * captive portal, a tunnel, a hotel Wi-Fi that accepts the connection and never
 * answers. There the reader watched a spinner for the whole socket timeout with
 * the entire book already sitting in SQLite. A downloaded book must never wait
 * for a network to time out.
 *
 * When the cache answers, the request still goes out — but only to refresh the
 * stored copy for the *next* open. Swapping the document under someone who has
 * started reading would re-run scroll restoration on a chapter they are already
 * inside.
 *
 * Surfaces `chapterError` so the screen can swap the eternal spinner for a real
 * empty-state on offline-miss / 404 (R-4).
 *
 * `wordCountRef` is exposed as a ref because `loadNextChapter` in the
 * screen accumulates next-chapter word counts into it (infinite scroll).
 */
export function useReaderChapter({ bookSlug, chapterSlug, language, editionIdRef }: Options) {
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [loading, setLoading] = useState(true)
  const [chapterError, setChapterError] = useState<'offline' | 'notfound' | null>(null)
  const wordCountRef = useRef(0)

  // Cancellation keeps rapid chapter navigation from letting a stale response
  // stomp the current chapter (R-4).
  useEffect(() => {
    if (!bookSlug || !chapterSlug) return
    let cancelled = false
    setLoading(true)
    setChapterError(null)

    ;(async () => {
      // Resolve the edition id the cache is keyed by. Prefer the one the book
      // effect already resolved; fall back to the cached-book list so a cold
      // start (no book meta yet) still finds the download.
      let editionId = editionIdRef.current
      if (!editionId) {
        try {
          const books = await getAllCachedBooks()
          if (cancelled) return
          editionId = books.find(b => b.slug === bookSlug)?.editionId ?? null
        } catch (e) {
          console.warn('Offline cache read failed:', e)
        }
      }

      let served = false
      if (editionId) {
        try {
          const cached = await getCachedChapter(editionId, chapterSlug)
          if (cancelled) return
          if (cached) {
            setChapter({
              // Null for rows written before the id column existed. Highlights
              // and the server progress write are keyed by it and already treat
              // an empty id as "nothing to send".
              id: cached.chapterId ?? '',
              chapterNumber: 0,
              slug: cached.chapterSlug,
              title: cached.title,
              html: cached.html,
              wordCount: cached.wordCount,
              prev: cached.prev,
              next: cached.next,
            })
            wordCountRef.current = cached.wordCount || 0
            setLoading(false)
            served = true
          }
        } catch (e) {
          if (!cancelled) console.warn('Offline cache read failed:', e)
        }
      }

      try {
        const api = createBooksApi(language)
        const ch = await api.getChapter(bookSlug, chapterSlug)
        if (cancelled) return
        if (served) {
          // Refresh the stored copy — including the id, which an older row may
          // be missing — and leave the rendered chapter alone.
          if (editionId) void refreshCachedChapter(editionId, ch).catch(() => {})
          return
        }
        setChapter(ch)
        wordCountRef.current = ch.wordCount || 0
        setLoading(false)
      } catch (err) {
        // Already reading from the device: a failed refresh is not the reader's
        // problem and must not paint an error over a chapter they can see.
        if (cancelled || served) return
        const status = (err as { status?: number } | null)?.status
        setChapter(null)
        setChapterError(status === 404 ? 'notfound' : 'offline')
        setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [bookSlug, chapterSlug, language, editionIdRef])

  return { chapter, setChapter, loading, chapterError, wordCountRef }
}
