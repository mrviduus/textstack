import { useCallback, useRef, MutableRefObject } from 'react'

type ChapterLink = { slug: string; title: string }

/** What a source hands back for the next chapter, cache or network. */
export type NextChapter = {
  html: string
  title: string
  slug: string
  wordCount: number | null
  next: ChapterLink | null
}

type Options = {
  injectJs: (js: string) => void
  /** Word counter accumulates across appended chapters so reading-session
   * tracking sees the full body the user has scrolled through. */
  wordCountRef: MutableRefObject<number>
  /** The source's next-chapter fetcher. MUST read the device before the network
   * (chapterLoadOrder.test.ts pins it per source). Keep it stable (useCallback). */
  fetchNext: (slug: string) => Promise<NextChapter>
}

/**
 * Owns the next-chapter prefetch ref and the WebView's infinite-scroll
 * wiring (`enableInfiniteScroll` / `appendChapter` / `disableInfiniteScroll`)
 * for BOTH reader sources; only the fetch differs, and each source passes its own.
 *
 * `enableForChapter` is called when the WebView posts `'loaded'` — it
 * primes the ref with the current chapter's `next` and turns the bottom
 * sentinel on.
 *
 * `loadNext` is called when the WebView posts `'requestNextChapter'` —
 * fetches the next chapter, appends its HTML, advances the ref, and
 * disables the sentinel once we hit the end of the book.
 *
 * **The fetch reads the device first, and until 2026-09-28 the catalogue one did
 * not read the device at all.** The failure branch is `disableInfiniteScroll()` —
 * so offline, a fully downloaded catalogue book scrolled to the bottom of its
 * first chapter and then quietly stopped scrolling, with no error and nothing to
 * retry. Cache-first rather than cache-as-fallback for the same reason as the
 * initial load: a network that accepts the connection and never answers would
 * otherwise stall a reader mid-book for the whole socket timeout and then turn
 * the feature off.
 */
export function useReaderInfiniteScroll({ injectJs, wordCountRef, fetchNext }: Options) {
  const nextChapterRef = useRef<ChapterLink | null>(null)

  const enableForChapter = useCallback((chapter: { next?: ChapterLink | null } | null) => {
    if (chapter?.next) {
      nextChapterRef.current = chapter.next
      injectJs('enableInfiniteScroll()')
    }
  }, [injectJs])

  const loadNext = useCallback(async () => {
    const next = nextChapterRef.current
    if (!next) return
    try {
      const { html, title, slug, wordCount, next: following } = await fetchNext(next.slug)
      injectJs(`appendChapter(${JSON.stringify({ html, title, slug })})`)
      wordCountRef.current += wordCount || 0
      nextChapterRef.current = following
      if (!following) injectJs('disableInfiniteScroll()')
    } catch {
      injectJs('disableInfiniteScroll()')
    }
  }, [injectJs, wordCountRef, fetchNext])

  return { enableForChapter, loadNext }
}
