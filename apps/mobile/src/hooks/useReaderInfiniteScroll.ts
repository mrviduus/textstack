import { useCallback, useRef, MutableRefObject } from 'react'
import { createBooksApi } from '@textstack/shared'
import type { Chapter, Language } from '@textstack/shared'
import { getCachedChapter } from '../lib/offlineDb'

type Options = {
  bookSlug: string | undefined
  language: Language
  injectJs: (js: string) => void
  /** Word counter accumulates across appended chapters so reading-session
   * tracking sees the full body the user has scrolled through. */
  wordCountRef: MutableRefObject<number>
  /** Resolved edition id — the key the offline chapter cache is stored under. */
  editionIdRef: MutableRefObject<string | null>
}

/**
 * Owns the next-chapter prefetch ref and the WebView's infinite-scroll
 * wiring (`enableInfiniteScroll` / `appendChapter` / `disableInfiniteScroll`).
 *
 * `enableForChapter` is called when the WebView posts `'loaded'` — it
 * primes the ref with the current chapter's `next` and turns the bottom
 * sentinel on.
 *
 * `loadNext` is called when the WebView posts `'requestNextChapter'` —
 * fetches the next chapter, appends its HTML, advances the ref, and
 * disables the sentinel once we hit the end of the book.
 *
 * **It reads the device first, and until 2026-09-28 it did not read the device at
 * all.** This path was network-only, and its failure branch is
 * `disableInfiniteScroll()` — so offline, a fully downloaded catalogue book
 * scrolled to the bottom of its first chapter and then quietly stopped scrolling,
 * with no error and nothing to retry. The uploads path had carried a cache
 * fallback since it was written; the catalogue one was simply missed. Cache-first
 * rather than cache-as-fallback for the same reason as the initial load: a
 * network that accepts the connection and never answers would otherwise stall a
 * reader mid-book for the whole socket timeout and then turn the feature off.
 */
export function useReaderInfiniteScroll({ bookSlug, language, injectJs, wordCountRef, editionIdRef }: Options) {
  const nextChapterRef = useRef<{ slug: string; title: string } | null>(null)

  const enableForChapter = useCallback((chapter: Chapter | null) => {
    if (chapter?.next) {
      nextChapterRef.current = chapter.next
      injectJs('enableInfiniteScroll()')
    }
  }, [injectJs])

  const loadNext = useCallback(async () => {
    const next = nextChapterRef.current
    if (!next || !bookSlug) return
    try {
      let html: string
      let title: string
      let slug: string
      let wordCount: number | null
      let following: Chapter['next'] = null

      const editionId = editionIdRef.current
      const cached = editionId ? await getCachedChapter(editionId, next.slug) : null
      if (cached) {
        html = cached.html
        title = cached.title
        slug = cached.chapterSlug
        wordCount = cached.wordCount
        following = cached.next
      } else {
        const api = createBooksApi(language)
        const ch = await api.getChapter(bookSlug, next.slug)
        ;({ html, title, slug, wordCount } = ch)
        following = ch.next
      }

      injectJs(`appendChapter(${JSON.stringify({ html, title, slug })})`)
      wordCountRef.current += wordCount || 0
      nextChapterRef.current = following
      if (!following) injectJs('disableInfiniteScroll()')
    } catch {
      injectJs('disableInfiniteScroll()')
    }
  }, [bookSlug, language, injectJs, wordCountRef, editionIdRef])

  return { enableForChapter, loadNext }
}
