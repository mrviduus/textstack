import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { createBooksApi, plural, userBooksApi } from '@textstack/shared'
import type { BookDetail, UserBookDetailResponse } from '@textstack/shared'
import {
  cacheChapter,
  setCachedBookMeta,
  updateCachedChapterCount,
  getCachedBookMeta,
  deleteCachedBook,
  isBookFullyCached,
  getAllCachedBooks,
  cacheUserChapter,
  getCachedUserChapter,
  setCachedUserBookMeta,
  updateCachedUserChapterCount,
  deleteCachedUserBook,
  isUserBookFullyCached,
  getAllCachedUserBooks,
  clearCachedUserBooks,
  type CachedBookMeta,
  type CachedUserBookMeta,
} from '../lib/offlineDb'
import { userBookChapterSlug } from '../lib/userBookChapters'
import { deleteAllOriginals, deleteOriginal, downloadOriginal } from '../lib/originalFileCache'
import { useAuth } from './AuthContext'

export type DownloadStatus = 'idle' | 'downloading' | 'complete' | 'error' | 'cancelled'

/**
 * Which library the download belongs to.
 *
 * The two are separate keyspaces and separate APIs — a catalog download is
 * keyed by `editionId` and fetched from `/books/{slug}/chapters/{slug}`, an
 * upload by its own id from `/me/books/{id}/chapters/{slug}` — but the state
 * machine over them (progress, cancel, retry-the-failed-ones) is identical, so
 * they share one map and one set of controls.
 */
export type DownloadKind = 'edition' | 'userbook'

/** A chapter to fetch: its slug, and its place in the book so the offline TOC
 *  can be ordered by something better than arrival time. */
export interface ChapterTask {
  slug: string
  number: number | null
}

export interface DownloadInfo {
  kind: DownloadKind
  /** Edition id (catalog) or user-book id (upload). The key of `downloads`. */
  editionId: string
  /** Catalog route key. Empty for an upload, which routes on its id. */
  bookSlug: string
  title: string
  language: string
  totalChapters: number
  downloadedChapters: number
  failedChapters: number
  /**
   * Chapters that still haven't been cached successfully after the
   * per-chapter retry budget. Kept around so the user can tap "Retry" and we
   * only re-fetch the missing ones (P1-5).
   */
  failedChapterSlugs: ChapterTask[]
  status: DownloadStatus
  errorMessage?: string
}

interface DownloadContextValue {
  downloads: Map<string, DownloadInfo>
  cachedBooks: CachedBookMeta[]
  cachedUserBooks: CachedUserBookMeta[]
  startDownload: (book: BookDetail, language: string) => Promise<void>
  /** Cache every extracted chapter of an upload for offline reading. */
  startUserBookDownload: (book: UserBookDetailResponse) => Promise<void>
  retryFailed: (id: string) => Promise<void>
  cancelDownload: (id: string) => void
  removeDownload: (editionId: string) => Promise<void>
  removeUserBookDownload: (bookId: string) => Promise<void>
  isDownloading: (id: string) => boolean
  isCached: (editionId: string) => Promise<boolean>
  isUserBookCached: (bookId: string) => Promise<boolean>
  refreshCachedBooks: () => Promise<void>
}

const DownloadContext = createContext<DownloadContextValue>({
  downloads: new Map(),
  cachedBooks: [],
  cachedUserBooks: [],
  startDownload: async () => {},
  startUserBookDownload: async () => {},
  retryFailed: async () => {},
  cancelDownload: () => {},
  removeDownload: async () => {},
  removeUserBookDownload: async () => {},
  isDownloading: () => false,
  isCached: async () => false,
  isUserBookCached: async () => false,
  refreshCachedBooks: async () => {},
})

export function useDownload() {
  return useContext(DownloadContext)
}

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [downloads, setDownloads] = useState<Map<string, DownloadInfo>>(new Map())
  const [cachedBooks, setCachedBooks] = useState<CachedBookMeta[]>([])
  const [cachedUserBooks, setCachedUserBooks] = useState<CachedUserBookMeta[]>([])
  const cancelledRef = useRef<Set<string>>(new Set())
  const { isAuthenticated } = useAuth()
  const wasAuthenticatedRef = useRef(isAuthenticated)

  // When the auth state flips from true → false (explicit sign out OR a
  // terminal refresh failure emitted by the API layer), cancel every
  // in-flight download and drop the in-memory download/cached-books
  // state so the UI doesn't show stale entries from the previous
  // session. The CATALOG disk cache is preserved — it's keyed by editionId and
  // belongs to the device, not the user (R-5).
  //
  // Uploads are the exception and are wiped: an upload is one account's private
  // file, so leaving its text on the device would hand it to whoever signs in
  // next. Fire-and-forget — a failed wipe must not block the sign-out.
  useEffect(() => {
    if (wasAuthenticatedRef.current && !isAuthenticated) {
      for (const editionId of downloads.keys()) {
        cancelledRef.current.add(editionId)
      }
      clearCachedUserBooks().catch(err => console.warn('Clearing cached uploads failed:', err))
      // The SQLite rows are not the whole of it any more: an upload's original
      // is a real file on disk. Same fire-and-forget shape as above — a failed
      // wipe must not block sign-out — and the same weakness, that it reports
      // only to the console.
      deleteAllOriginals().catch(err => console.warn('Clearing stored originals failed:', err))
      setDownloads(new Map())
      setCachedBooks([])
      setCachedUserBooks([])
    }
    wasAuthenticatedRef.current = isAuthenticated
    // `downloads` intentionally omitted — we only care about the
    // auth transition, not every mutation of the map. Reading .keys()
    // from the closure is fine because React batches state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated])

  const refreshCachedBooks = useCallback(async () => {
    const [books, uploads] = await Promise.all([getAllCachedBooks(), getAllCachedUserBooks()])
    setCachedBooks(books)
    setCachedUserBooks(uploads)
  }, [])

  const updateDownload = useCallback((editionId: string, update: Partial<DownloadInfo>) => {
    setDownloads(prev => {
      const next = new Map(prev)
      const current = next.get(editionId)
      if (current) {
        next.set(editionId, { ...current, ...update })
      }
      return next
    })
  }, [])

  /**
   * Fetch + cache a single chapter with up to 2 retries and exponential
   * backoff (P1-5). Returns true on success, false if we gave up. Callers
   * aggregate success/failure to update the UI counters in one place.
   *
   * One loop for both libraries: only the fetch-and-store step differs, and it
   * is passed in. The retry budget, the cancellation checks and the backoff are
   * the parts that were worth not writing twice.
   */
  const downloadChapter = useCallback(async (
    bookKey: string,
    task: ChapterTask,
    store: (task: ChapterTask) => Promise<void>,
  ): Promise<boolean> => {
    const MAX_ATTEMPTS = 3
    let delay = 400
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (cancelledRef.current.has(bookKey)) return false
      try {
        await store(task)
        return true
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          console.warn(`Chapter ${task.slug} failed after ${MAX_ATTEMPTS} attempts:`, err)
          return false
        }
        // Linear-ish backoff: 400ms → 1200ms → 2400ms. Enough to ride out a
        // brief 502/connection reset without making the total download take
        // forever if every chapter is retrying.
        await new Promise(r => setTimeout(r, delay))
        delay = Math.min(delay * 2, 3000)
      }
    }
    return false
  }, [])

  /**
   * The download loop itself, shared by both libraries and by both entry points
   * (a fresh download and a retry of only what failed).
   *
   * `alreadyDone` is the count to continue from, so a retry's progress counter
   * keeps the chapters the first run cached instead of restarting at zero.
   */
  const runDownload = useCallback(async (
    bookKey: string,
    tasks: ChapterTask[],
    alreadyDone: number,
    store: (task: ChapterTask) => Promise<void>,
    saveCount: (n: number) => Promise<void>,
    failureMessage: (n: number) => string,
  ) => {
    let downloaded = alreadyDone
    const failed: ChapterTask[] = []

    for (const task of tasks) {
      if (cancelledRef.current.has(bookKey)) {
        updateDownload(bookKey, { status: 'cancelled' })
        return
      }

      const ok = await downloadChapter(bookKey, task, store)
      if (ok) downloaded++
      else failed.push(task)

      await saveCount(downloaded)
      updateDownload(bookKey, {
        downloadedChapters: downloaded,
        failedChapters: failed.length,
        failedChapterSlugs: [...failed],
      })

      // Small delay between requests so a large book doesn't hammer the API.
      await new Promise(r => setTimeout(r, 100))
    }

    const status: DownloadStatus = failed.length > 0 ? 'error' : 'complete'
    updateDownload(bookKey, {
      status,
      errorMessage: failed.length > 0 ? failureMessage(failed.length) : undefined,
    })
    await refreshCachedBooks()
  }, [downloadChapter, updateDownload, refreshCachedBooks])

  /**
   * The per-chapter fetch-and-store step for one book, and the counter write
   * that follows it. Derived from the download's `kind` so that the loop, the
   * retry path and the UI never have to branch on it again.
   */
  const storeFor = useCallback((info: Pick<DownloadInfo, 'kind' | 'editionId' | 'bookSlug' | 'language'>) => {
    if (info.kind === 'userbook') {
      return {
        store: async (task: ChapterTask) => {
          // Resume, rather than restart. The progress map is in memory only, so
          // a download interrupted by the app being killed looks untouched when
          // the reader comes back — while its chapters are still on disk. A
          // 123-chapter book would re-fetch every one of them. (To force a
          // refresh, Remove the download first: that clears the rows.)
          if (await getCachedUserChapter(info.editionId, task.slug)) return
          const chapter = await userBooksApi.getUserBookChapter(info.editionId, task.slug)
          await cacheUserChapter(info.editionId, chapter, task.number)
        },
        saveCount: (n: number) => updateCachedUserChapterCount(info.editionId, n),
      }
    }
    const api = createBooksApi(info.language)
    return {
      store: async (task: ChapterTask) => {
        const chapter = await api.getChapter(info.bookSlug, task.slug)
        await cacheChapter(info.editionId, chapter)
      },
      saveCount: (n: number) => updateCachedChapterCount(info.editionId, n),
    }
  }, [])

  const startDownload = useCallback(async (book: BookDetail, language: string) => {
    const editionId = book.id
    cancelledRef.current.delete(editionId)

    const info: DownloadInfo = {
      kind: 'edition',
      editionId,
      bookSlug: book.slug,
      title: book.title,
      language,
      totalChapters: book.chapters.length,
      downloadedChapters: 0,
      failedChapters: 0,
      failedChapterSlugs: [],
      status: 'downloading',
    }

    setDownloads(prev => new Map(prev).set(editionId, info))

    // Save book meta
    await setCachedBookMeta({
      editionId,
      slug: book.slug,
      title: book.title,
      coverPath: book.coverPath,
      totalChapters: book.chapters.length,
      cachedChapters: 0,
      cachedAt: Date.now(),
    })

    const { store, saveCount } = storeFor(info)
    await runDownload(
      editionId,
      book.chapters.map(ch => ({ slug: ch.slug, number: ch.chapterNumber })),
      0,
      store,
      saveCount,
      n => `${plural(n, 'chapter', 'chapters')} failed. Tap Retry to finish the download.`,
    )
  }, [storeFor, runDownload])

  /**
   * Cache an upload for offline reading: its chapters AND, for a PDF, the
   * original file.
   *
   * The original is what makes an offline PDF look like the book instead of
   * like its extracted text — which mattered more than it sounded, because
   * ADR-012 also dropped inline image extraction on the grounds that "the PDF
   * renders its own images". Offline it could not, so the substitute had the
   * figures stripped out of exactly the books that are mostly figures.
   *
   * Chapters are still downloaded for a PDF: search, the table of contents and
   * the corrupt-file fallback all read them. The file is added, not swapped in.
   */
  const startUserBookDownload = useCallback(async (book: UserBookDetailResponse) => {
    const bookId = book.id
    cancelledRef.current.delete(bookId)

    const tasks: ChapterTask[] = book.chapters.map(ch => ({
      slug: userBookChapterSlug(ch),
      number: ch.chapterNumber,
    }))

    const info: DownloadInfo = {
      kind: 'userbook',
      editionId: bookId,
      bookSlug: '',
      title: book.title,
      language: book.language,
      totalChapters: tasks.length,
      downloadedChapters: 0,
      failedChapters: 0,
      failedChapterSlugs: [],
      status: 'downloading',
    }

    setDownloads(prev => new Map(prev).set(bookId, info))

    await setCachedUserBookMeta({
      bookId,
      title: book.title,
      author: book.author,
      coverPath: book.coverPath,
      language: book.language,
      totalChapters: tasks.length,
      cachedChapters: 0,
      totalWordCount: book.totalWordCount,
      isPdf: book.hasOriginalPdf === true,
      cachedAt: Date.now(),
    })

    const { store, saveCount } = storeFor(info)
    await runDownload(
      bookId,
      tasks,
      0,
      store,
      saveCount,
      n => `${plural(n, 'chapter', 'chapters')} failed. Tap Retry to finish the download.`,
    )

    // After the chapters, and only if the reader did not cancel meanwhile. One
    // request, no per-byte progress — see the note on `downloadOriginal`. A
    // failure here is not a failed download: the book is still readable offline
    // as text, which is exactly what it was before this existed.
    if (book.hasOriginalPdf === true && !cancelledRef.current.has(bookId)) {
      const outcome = await downloadOriginal(bookId, 'pdf')
      if (outcome.status !== 'downloaded') {
        console.warn(`[originals] ${bookId}: ${outcome.status}`)
      }
    }
  }, [storeFor, runDownload])

  /**
   * Retry just the chapters we failed to cache on the previous run, rather
   * than re-downloading the whole book. Resets failure state, keeps the
   * existing downloaded count (P1-5).
   */
  const retryFailed = useCallback(async (id: string) => {
    const current = downloads.get(id)
    if (!current) return
    const toRetry = [...current.failedChapterSlugs]
    if (toRetry.length === 0) return

    cancelledRef.current.delete(id)
    updateDownload(id, {
      status: 'downloading',
      failedChapters: 0,
      failedChapterSlugs: [],
      errorMessage: undefined,
    })

    const { store, saveCount } = storeFor(current)
    await runDownload(
      id,
      toRetry,
      current.downloadedChapters,
      store,
      saveCount,
      n => `${plural(n, 'chapter', 'chapters')} still failing. Check your connection and retry.`,
    )
  }, [downloads, updateDownload, storeFor, runDownload])

  const cancelDownload = useCallback((editionId: string) => {
    cancelledRef.current.add(editionId)
  }, [])

  const forgetDownload = useCallback((id: string) => {
    setDownloads(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const removeDownload = useCallback(async (editionId: string) => {
    cancelledRef.current.add(editionId)
    await deleteCachedBook(editionId)
    forgetDownload(editionId)
    await refreshCachedBooks()
  }, [forgetDownload, refreshCachedBooks])

  const removeUserBookDownload = useCallback(async (bookId: string) => {
    // Cancel first: "Remove" on a download still running would otherwise delete
    // the rows and then have the loop write more of them back.
    cancelledRef.current.add(bookId)
    await deleteCachedUserBook(bookId)
    // The file too — "Remove" that leaves twenty megabytes on disk is a lie,
    // and this one is visible to a file manager.
    await deleteOriginal(bookId, 'pdf')
    forgetDownload(bookId)
    await refreshCachedBooks()
  }, [forgetDownload, refreshCachedBooks])

  const isDownloading = useCallback((id: string) => {
    return downloads.get(id)?.status === 'downloading'
  }, [downloads])

  const isCached = useCallback(async (editionId: string) => {
    return isBookFullyCached(editionId)
  }, [])

  const isUserBookCached = useCallback(async (bookId: string) => {
    return isUserBookFullyCached(bookId)
  }, [])

  return (
    <DownloadContext.Provider
      value={{
        downloads,
        cachedBooks,
        cachedUserBooks,
        startDownload,
        startUserBookDownload,
        retryFailed,
        cancelDownload,
        removeDownload,
        removeUserBookDownload,
        isDownloading,
        isCached,
        isUserBookCached,
        refreshCachedBooks,
      }}
    >
      {children}
    </DownloadContext.Provider>
  )
}
