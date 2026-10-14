import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi } from './useApi'
import { useNetworkRecovery } from './useNetworkRecovery'
import { getUserBook, getUserBookChapter } from '../api/userBooks'
import { ApiError } from '../api/client'
import { getCachedChapter, cacheChapter } from '../lib/offlineDb'
import { InvalidContentTypeError } from '../lib/fetchWithRetry'
import type { Chapter, BookDetail } from '../types/api'
import type { TocChapter } from '../components/reader/ReaderTocDrawer'

export type ReaderMode = 'public' | 'userbook'

export interface NormalizedChapter {
  id: string
  chapterNumber: number
  identifier: string
  title: string
  html: string
  wordCount: number | null
  prev: { identifier: string; title: string } | null
  next: { identifier: string; title: string } | null
}

export interface NormalizedBook {
  id: string
  title: string
  totalWordCount?: number | null
  chapters: TocChapter[]
  /** User-uploaded PDF that supports the opt-in Original-layout view. */
  hasOriginalPdf?: boolean
  /** Clipped article's origin page (userbook clips only). */
  sourceUrl?: string | null
}

interface Params {
  mode: ReaderMode
  bookSlug?: string
  chapterSlug?: string
  userBookId?: string
  userChapterSlug?: string
  isAuthenticated: boolean
}

export interface UseReaderChapterResult {
  chapter: NormalizedChapter | null
  book: NormalizedBook | null
  publicChapter: Chapter | null
  publicBook: BookDetail | null
  loading: boolean
  error: string | null
  /**
   * Try again after the engine could not open the chapter (#849): the chapter from the network first; on
   * success it replaces the one on screen and the cache, on failure nothing changes (no loading screen, no
   * page error). Dropped (false) once the reader is on another chapter.
   */
  retryChapter: () => Promise<boolean>
}

const fromPublic = (ch: Chapter): NormalizedChapter => ({
  id: ch.id,
  chapterNumber: ch.chapterNumber,
  identifier: ch.slug,
  title: ch.title,
  html: ch.html,
  wordCount: ch.wordCount,
  prev: ch.prev ? { identifier: ch.prev.slug, title: ch.prev.title } : null,
  next: ch.next ? { identifier: ch.next.slug, title: ch.next.title } : null,
})

const fromUser = (ch: Awaited<ReturnType<typeof getUserBookChapter>>, slug: string): NormalizedChapter => ({
  id: ch.id,
  chapterNumber: ch.chapterNumber,
  identifier: ch.slug || slug,
  title: ch.title,
  html: ch.html,
  wordCount: ch.wordCount,
  prev: ch.previous ? { identifier: ch.previous.slug || String(ch.previous.chapterNumber), title: ch.previous.title } : null,
  next: ch.next ? { identifier: ch.next.slug || String(ch.next.chapterNumber), title: ch.next.title } : null,
})

export function useReaderChapter({
  mode,
  bookSlug,
  chapterSlug,
  userBookId,
  userChapterSlug,
  isAuthenticated,
}: Params): UseReaderChapterResult {
  const api = useApi()
  const { markFetchStart, wasAbortedDueToWake } = useNetworkRecovery()

  const [publicChapter, setPublicChapter] = useState<Chapter | null>(null)
  const [publicBook, setPublicBook] = useState<BookDetail | null>(null)
  const [chapter, setChapter] = useState<NormalizedChapter | null>(null)
  const [book, setBook] = useState<NormalizedBook | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const editionIdRef = useRef<string | null>(null)
  const fetchedKeyRef = useRef<string | null>(null)
  const keyRef = useRef<string | null>(null)   // the chapter the reader is on: a retry for another is dropped

  useEffect(() => {
    if (mode === 'public' && (!bookSlug || !chapterSlug)) return
    // Chapterless is valid for userbooks: an Original-layout PDF opens before
    // (or without) any chapter, so the slug is optional here.
    if (mode === 'userbook' && (!userBookId || !isAuthenticated)) return

    const fetchKey = mode === 'public'
      ? `public:${bookSlug}:${chapterSlug}`
      : `userbook:${userBookId}:${userChapterSlug ?? ''}`
    keyRef.current = fetchKey
    // Already loaded — skip so an isAuthenticated flip (guest creation) doesn't
    // reset state and drop popups mid-interaction.
    if (fetchedKeyRef.current === fetchKey) return

    let cancelled = false
    if (mode === 'public') markFetchStart()

    const fetchData = async () => {
      setLoading(true)
      setError(null)

      try {
        if (mode === 'public') {
          const cachedEditionId = editionIdRef.current
          if (cachedEditionId) {
            const cached = await getCachedChapter(cachedEditionId, chapterSlug!)
            if (cached && !cancelled) {
              // CachedChapter doesn't persist chapterNumber; resolve the real one
              // from the (separately fetched) book so it isn't a misleading 0.
              let bk: BookDetail | null = null
              try {
                bk = await api.getBook(bookSlug!)
              } catch {
                // Book fetch failed but chapter from cache - ok
              }
              if (cancelled) return
              const bookChapter = bk?.chapters.find(c => c.slug === cached.chapterSlug)
              const realChapterNumber = bookChapter?.chapterNumber ?? 0

              const rawChapter: Chapter = {
                // The real id: bookmarks POST it and highlight anchors are keyed
                // by it. The cache key ("editionId:slug") is a last resort for an
                // old row read offline — never a server id.
                id: cached.chapterId ?? bookChapter?.id ?? cached.key,
                chapterNumber: realChapterNumber,
                slug: cached.chapterSlug,
                title: cached.title,
                html: cached.html,
                wordCount: cached.wordCount,
                prev: cached.prev,
                next: cached.next,
              }
              // Heal a row cached before chapterId was stored, so the next
              // offline read has the real id too.
              if (!cached.chapterId && bookChapter) cacheChapter(cachedEditionId, rawChapter).catch(() => {})
              setPublicChapter(rawChapter)
              setChapter(fromPublic(rawChapter))
              if (bk) {
                setPublicBook(bk)
                setBook({
                  id: bk.id,
                  title: bk.title,
                  chapters: bk.chapters.map(c => ({
                    id: c.id,
                    identifier: c.slug,
                    title: c.title,
                    chapterNumber: c.chapterNumber,
                  })),
                })
              }
              fetchedKeyRef.current = fetchKey
              setLoading(false)
              return
            }
          }

          const [ch, bk] = await Promise.all([
            api.getChapter(bookSlug!, chapterSlug!),
            api.getBook(bookSlug!),
          ])

          if (cancelled) return

          setPublicChapter(ch)
          setPublicBook(bk)
          editionIdRef.current = bk.id

          setChapter(fromPublic(ch))
          setBook({
            id: bk.id,
            title: bk.title,
            chapters: bk.chapters.map(c => ({
              id: c.id,
              identifier: c.slug,
              title: c.title,
              chapterNumber: c.chapterNumber,
            })),
          })

          cacheChapter(bk.id, ch).catch(() => {})
          fetchedKeyRef.current = fetchKey
        } else {
          // Fetch the book first — its hasOriginalPdf decides whether a missing
          // chapter is fatal. A chapterless/indexing PDF opens in Original with
          // no chapter at all.
          const bk = await getUserBook(userBookId!)
          if (cancelled) return

          let ch: Awaited<ReturnType<typeof getUserBookChapter>> | null = null
          if (userChapterSlug) {
            try {
              ch = await getUserBookChapter(userBookId!, userChapterSlug)
            } catch (chErr) {
              // Chapter not found yet (extraction still running or never produced
              // chapters). Swallow ONLY when the original PDF is readable — Original
              // layout opens without a chapter. EPUB / non-PDF 404 stays fatal.
              const status = chErr instanceof ApiError ? chErr.status : undefined
              if (status === 404 && bk.hasOriginalPdf) {
                ch = null
              } else {
                throw chErr
              }
            }
          }

          if (cancelled) return

          setChapter(ch ? fromUser(ch, userChapterSlug!) : null)
          setBook({
            id: bk.id,
            title: bk.title,
            totalWordCount: bk.totalWordCount,
            hasOriginalPdf: bk.hasOriginalPdf,
            sourceUrl: bk.sourceUrl ?? null,
            chapters: bk.chapters.map(c => ({
              id: c.id,
              identifier: c.slug || String(c.chapterNumber),
              title: c.title,
              chapterNumber: c.chapterNumber,
              wordCount: c.wordCount,
              sourceStartPage: c.sourceStartPage ?? null,
            })),
          })
          fetchedKeyRef.current = fetchKey
        }
      } catch (err) {
        if (cancelled) return
        if (mode === 'public' && wasAbortedDueToWake()) {
          fetchData()
          return
        }
        if (err instanceof InvalidContentTypeError) {
          setError('Chapter not found. The book may have been removed.')
        } else {
          setError((err as Error).message)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchData()
    return () => { cancelled = true }
  }, [mode, bookSlug, chapterSlug, userBookId, userChapterSlug, isAuthenticated, api, markFetchStart, wasAbortedDueToWake])

  const retryChapter = useCallback(async (): Promise<boolean> => {
    const key = keyRef.current
    for (;;) {
      if (mode === 'public') markFetchStart()
      try {
        if (mode === 'public') {
          const ch = await api.getChapter(bookSlug!, chapterSlug!)
          if (keyRef.current !== key) return false
          setPublicChapter(ch)
          setChapter(fromPublic(ch))
          if (editionIdRef.current) cacheChapter(editionIdRef.current, ch).catch(() => {})
        } else {
          const ch = await getUserBookChapter(userBookId!, userChapterSlug!)
          if (keyRef.current !== key) return false
          setChapter(fromUser(ch, userChapterSlug!))
        }
        return true
      } catch {
        // A wake from sleep aborted the fetch: no answer yet, so ask again, as the normal load does.
        if (keyRef.current !== key || !(mode === 'public' && wasAbortedDueToWake())) return false
      }
    }
  }, [mode, bookSlug, chapterSlug, userBookId, userChapterSlug, api, markFetchStart, wasAbortedDueToWake])

  return { chapter, book, publicChapter, publicBook, loading, error, retryChapter }
}
