import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { createBooksApi, plural, userBooksApi } from '@textstack/shared'
import type { BookDetail, UserBookDetailResponse } from '@textstack/shared'
import {
  cacheChapter,
  setCachedBookMeta,
  updateCachedChapterCount,
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
import { deleteAllOriginals, deleteOriginal, downloadOriginal, evictToBudget } from '../lib/originalFileCache'
import { chooseAutoDownloads, chooseOrphanedDownloads, mayAutoDownload } from '../lib/autoDownloadPolicy'
import { offlineStorageBytes } from '../lib/deviceStorage'
import { listStoredOriginalIds } from '../lib/originalFileCache'
import { declineDownload, listDeclinedDownloads, undeclineDownload } from '../lib/declinedDownloads'
import { AppState } from 'react-native'
import NetInfo from '@react-native-community/netinfo'
import { CACHE_BUDGET_BYTES, isOutOfSpaceError } from '../lib/originalFilePolicy'
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
  /** Fetch anything of the reader's own that is not on the device yet. */
  syncOfflineLibrary: () => Promise<void>
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
  syncOfflineLibrary: async () => {},
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
  /** Books whose ORIGINAL file failed while their chapters succeeded. Kept apart
   *  from `failedChapterSlugs` because it is not a chapter and cannot be
   *  expressed as one, and Retry has to cover it or the promise on the book
   *  screen is not kept. */
  const originalFailedRef = useRef<Set<string>>(new Set())
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

  /**
   * Read what is on the device once, at startup.
   *
   * Nothing did. Both lists started empty and were only ever filled by an event
   * *in this process* — a download finishing, a removal, the sweep — so after a
   * cold start the shelf said "Download" about every book on the phone until the
   * reader happened to download something else. Found on a device: a book that
   * had just reported "On this device" said "Download" again after a restart,
   * offline, with its chapters and its original file both sitting in place.
   */
  useEffect(() => {
    refreshCachedBooks().catch(err => console.warn('[downloads] initial cache read failed:', err))
  }, [refreshCachedBooks])

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
        // A full device is not going to clear in 1.6 seconds. Retrying it three
        // times per chapter meant a 120-chapter book spent about three minutes
        // failing the 110 that were left, and then advised "Tap Retry", which
        // cannot help. Thrown so the loop can stop at the first one and say
        // what is actually wrong — the web side has done this since it was
        // written (`QuotaExceededError` → stop, "Storage full").
        if (isOutOfSpaceError(err)) throw err
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

      let ok: boolean
      try {
        ok = await downloadChapter(bookKey, task, store)
      } catch (err) {
        // Only a full device reaches here — `downloadChapter` rethrows that one
        // case and swallows everything else into `false`. Stop at the first,
        // keep what is already cached, and say the thing that is true.
        console.warn('Download stopped — the device is out of space:', err)
        await saveCount(downloaded)
        updateDownload(bookKey, {
          status: 'error',
          downloadedChapters: downloaded,
          failedChapters: failed.length,
          failedChapterSlugs: [...failed],
          errorMessage: 'This device is out of space. Remove a download to finish this one.',
        })
        await refreshCachedBooks()
        return
      }
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
  const startUserBookDownload = useCallback(async (
    book: UserBookDetailResponse,
    /** Who asked. The automatic sweep must never evict: the budget stops it,
     *  it does not make room. Without this the rule held only at the sweep's
     *  pre-flight gate — a 1.9 GB library passes it, the sweep fetches a 300 MB
     *  book, and `evictToBudget` deletes what the reader chose to keep. */
    origin: 'reader' | 'auto' = 'reader',
  ) => {
    const bookId = book.id
    cancelledRef.current.delete(bookId)
    // Pressing Download is the reader saying the opposite of Remove, just as
    // clearly, so the automatic sweep may consider this book again.
    if (origin === 'reader') void undeclineDownload(bookId)

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

    // The file FIRST, then the chapters. Not an ordering preference: the status
    // set above is `downloading`, and `runDownload` flips it to `complete` when
    // it returns. Fetching the file afterwards left the button rendering its
    // idle "Download for Offline" state for the whole of a 21 MB transfer, so a
    // reader who saw nothing happen and tapped again started a second one.
    // (They now join rather than race — `downloadOriginal` is single-flighted —
    // but a button that lies about what it is doing is the actual defect.)
    if (book.hasOriginalPdf === true && !cancelledRef.current.has(bookId)) {
      const outcome = await downloadOriginal(bookId, 'pdf')
      if (outcome.status !== 'downloaded') {
        // Not swallowed. The screen has already promised that this book will
        // look the same offline, and the chapters alone will finish and render
        // "Downloaded — Remove" — the reader would find out on the plane.
        console.warn(`[originals] ${bookId}: ${outcome.status}`)
        originalFailedRef.current.add(bookId)
      } else if (cancelledRef.current.has(bookId)) {
        // Removed or cancelled while the file was in flight. Nothing aborts the
        // transfer, so it lands after the row deletion and would sit on disk
        // belonging to a book that no longer has a download.
        await deleteOriginal(bookId, 'pdf')
        return
      } else {
        // Evicting a file does NOT lose the reading position — that lives in
        // progressStorage and on the server — so the budget is enforced at the
        // cost of bytes only. The one just downloaded is protected explicitly,
        // because it is the reason we are over budget and deleting it here
        // would be a loop. Everything else is ordered by last open, so the book
        // being read is the last thing LRU reaches.
        // Only when a person asked for this download. See `origin` above.
        if (origin === 'reader') await evictToBudget(new Set([bookId]))
      }
    }
    if (cancelledRef.current.has(bookId)) return

    const { store, saveCount } = storeFor(info)
    await runDownload(
      bookId,
      tasks,
      0,
      store,
      saveCount,
      n => `${plural(n, 'chapter', 'chapters')} failed. Tap Retry to finish the download.`,
    )

    if (originalFailedRef.current.has(bookId)) {
      updateDownload(bookId, {
        status: 'error',
        errorMessage: 'The original pages did not download. Tap Retry — the text is already saved.',
      })
    }
  }, [storeFor, runDownload, updateDownload])

  /**
   * Retry just the chapters we failed to cache on the previous run, rather
   * than re-downloading the whole book. Resets failure state, keeps the
   * existing downloaded count (P1-5).
   */
  const retryFailed = useCallback(async (id: string) => {
    const current = downloads.get(id)
    if (!current) return
    const toRetry = [...current.failedChapterSlugs]
    const originalFailed = originalFailedRef.current.has(id)
    if (toRetry.length === 0 && !originalFailed) return

    cancelledRef.current.delete(id)
    updateDownload(id, {
      status: 'downloading',
      failedChapters: 0,
      failedChapterSlugs: [],
      errorMessage: undefined,
    })

    // The file first, same reasoning as the initial download: while it is in
    // flight the status must not read as finished.
    if (originalFailed) {
      const outcome = await downloadOriginal(id, 'pdf')
      if (outcome.status === 'downloaded') {
        originalFailedRef.current.delete(id)
      } else if (toRetry.length === 0) {
        updateDownload(id, {
          status: 'error',
          errorMessage: 'The original pages still did not download. Check your connection and retry.',
        })
        return
      }
    }
    if (toRetry.length === 0) {
      updateDownload(id, { status: 'complete' })
      return
    }

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
    // And remember the answer. Otherwise the automatic sweep sees an uncached
    // book on the next Wi-Fi and brings it straight back, along with the space
    // the reader had just freed.
    await declineDownload(bookId)
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

  /**
   * The library fetches itself.
   *
   * Offline used to be a feature you had to find: walk into a book, press
   * "Download for Offline". Someone who uploaded a book to us already said they
   * want it, and asking again is asking twice — so their own books now arrive
   * on their own.
   *
   * Four rules, each a decision rather than an implementation detail:
   *
   * - **Wi-Fi only.** A library of 80 MB uploads over a metered connection is a
   *   bill nobody agreed to. Manual download still works on any network,
   *   because it asks first — that is the whole difference.
   * - **It never evicts.** The budget stops the queue; it does not make room.
   *   Deleting a book the reader chose to keep, to fit one they never asked
   *   for, would be the app arguing with them.
   * - **Their own uploads only.** The catalogue is 1,498 editions and stays a
   *   deliberate tap.
   * - **One at a time.** Each download is awaited in turn, so a manual one the
   *   reader is watching never races a background one for the connection.
   */
  const autoRunningRef = useRef(false)
  const autoCancelledRef = useRef(false)
  const autoRerunRef = useRef(false)
  /** Timer and budget for the "a book is still being processed" re-check. */
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processingTriesRef = useRef(0)
  /** Wi-Fi, budget and session, asked fresh. Once before the queue is built and
   *  again between books: the budget moves as the loop fills it, and a reader
   *  can walk out of Wi-Fi halfway through a library. */
  const autoDownloadAllowed = useCallback(async () => {
    const [net, used] = await Promise.all([NetInfo.fetch(), offlineStorageBytes()])
    return mayAutoDownload({
      // Read, not assumed. Passing a literal `true` made the session branch of
      // `mayAutoDownload` unreachable — a rule with a test and no caller.
      connectionType: net.type ?? null,
      hasSession: isAuthenticated,
      usedBytes: used,
      budgetBytes: CACHE_BUDGET_BYTES,
    })
  }, [isAuthenticated])

/**
 * How long to keep looking after a sweep that found a book still being
 * processed, and how often.
 *
 * Extraction happens in the Worker, so a book uploaded a second ago is
 * `Processing`, and `chooseAutoDownloads` takes `Ready` books only — correctly.
 * The sweep the upload screen asks for therefore finds nothing, and before this
 * nothing ran again until the reader backgrounded the app or the network
 * changed. Found on a device: upload a book, stay in the app, and your own
 * just-added book sits on the shelf saying "Download".
 *
 * Bounded by a real condition rather than a timer for its own sake: it stops the
 * moment nothing is processing, and the ceiling is there for a book whose
 * ingestion failed in a way that leaves it processing forever.
 */
const PROCESSING_RECHECK_MS = 12_000
const PROCESSING_RECHECK_LIMIT = 25

  /** One pending re-check at a time, and never more than the ceiling. The timer
   *  is cleared on sign-out and unmount with everything else. */
  const scheduleProcessingRecheck = useCallback((isCancelled: () => boolean) => {
    if (processingTimerRef.current) return
    if (processingTriesRef.current >= PROCESSING_RECHECK_LIMIT) return
    processingTriesRef.current += 1
    processingTimerRef.current = setTimeout(() => {
      processingTimerRef.current = null
      if (isCancelled()) return
      void runAutoDownloadRef.current?.(isCancelled)
    }, PROCESSING_RECHECK_MS)
  }, [])

  /** `runAutoDownload` refers to the scheduler and the scheduler calls it back;
   *  a ref breaks the cycle without making either of them depend on the other's
   *  identity. */
  const runAutoDownloadRef = useRef<((isCancelled: () => boolean) => Promise<void>) | null>(null)

  const runAutoDownload = useCallback(async (isCancelled: () => boolean) => {
    // A sweep already running is not a reason to drop this request — the caller
    // may know something the running sweep does not, which is exactly the case
    // after an upload. Record the ask; the sweep in flight repeats itself once
    // it finishes rather than the new book waiting for the next reconnect.
    if (autoRunningRef.current) {
      autoRerunRef.current = true
      return
    }
    autoRunningRef.current = true
    try {
      do {
        autoRerunRef.current = false
        if (!(await autoDownloadAllowed())) return

        // Not paginated, on purpose and with a ceiling in mind: this is the
        // reader's OWN library, which the server caps at a tier's worth of
        // uploads, not the 1,498-edition catalogue. If that stops being true
        // the fix is a page size here, not a second downloader.
        const [books, metas, storedOriginals, declined] = await Promise.all([
          userBooksApi.getUserBooks(),
          getAllCachedUserBooks(),
          listStoredOriginalIds(),
          listDeclinedDownloads(),
        ])
        // "Cached" has to mean the whole book. Chapters alone satisfied it
        // before, so a PDF whose original had failed or been evicted counted as
        // done — and offline it would open as text with the figures stripped,
        // which is the exact defect the previous slice existed to remove.
        const cached = new Set(
          metas
            .filter(b => b.cachedChapters > 0 && b.cachedChapters >= b.totalChapters)
            .filter(b => !b.isPdf || storedOriginals.has(b.bookId))
            .map(b => b.bookId),
        )

        // Books this device holds that the account no longer has — deleted from
        // another phone or from the web. Done here rather than on a schedule
        // because this is the one place that has just asked the server what the
        // library IS, and the listing succeeded: `Promise.all` above rejects
        // otherwise, so an empty `books` means empty, not unreachable. That
        // distinction is the whole safety of this.
        const orphans = chooseOrphanedDownloads(
          [...metas.map(m => m.bookId), ...storedOriginals],
          new Set(books.map(b => b.id)),
        )
        for (const id of orphans) {
          try {
            // Cancel first, the same order `removeUserBookDownload` uses: a
            // download still running would otherwise have its rows deleted and
            // then write more of them straight back.
            cancelledRef.current.add(id)
            await deleteCachedUserBook(id)
            await deleteOriginal(id, 'pdf')
            // Not `declineDownload` — the book is gone, so there is nothing to
            // decline, and an entry for a dead id would sit in that list for the
            // life of the install.
            await undeclineDownload(id)
            forgetDownload(id)
          } catch (err) {
            console.warn(`[auto-download] could not remove orphaned ${id}:`, err)
          }
        }
        if (orphans.length > 0) {
          console.warn(`[auto-download] removed ${orphans.length} download(s) deleted elsewhere`)
          await refreshCachedBooks()
        }

        // A book the server has not finished with yet is not a book this sweep
        // can fetch — but it is a reason to come back. See
        // PROCESSING_RECHECK_MS.
        const stillProcessing = books.some(b => b.status?.toLowerCase() === 'processing')

        // One line on the happy path, so "it ran and found nothing" stays
        // distinguishable from "it never ran" — the exact ambiguity that made
        // the cancellation bug take a device and a database query to find.
        const queue = chooseAutoDownloads(books, cached, declined)
        if (__DEV__) console.log(`[auto-download] ${queue.length} of ${books.length} book(s) to fetch`)

        for (const id of queue) {
          if (isCancelled()) return
          if (!(await autoDownloadAllowed())) return

          try {
            const detail = await userBooksApi.getUserBook(id)
            if (isCancelled()) return
            await startUserBookDownload(detail, 'auto')
          } catch (err) {
            // One book failing is not the queue failing. The next may well
            // succeed, and this one is retried on the next sweep.
            console.warn(`[auto-download] ${id} skipped:`, err)
          }
        }
        if (stillProcessing && !isCancelled()) scheduleProcessingRecheck(isCancelled)
        else processingTriesRef.current = 0

        // A restart re-reads the library and re-filters what is already cached,
        // so nothing is downloaded twice; the cost of repeating is one list
        // request, which is the right price for not stranding a new book.
      } while (autoRerunRef.current && !isCancelled())
    } finally {
      autoRunningRef.current = false
    }
  }, [autoDownloadAllowed, startUserBookDownload, forgetDownload, refreshCachedBooks, scheduleProcessingRecheck])

  runAutoDownloadRef.current = runAutoDownload

  /**
   * Scheduled on the two moments that change the answer — "there is a session
   * now" and "there is a network now". Both are events, so this is not a timer.
   *
   * **`runAutoDownload` is deliberately NOT a dependency, and that is the whole
   * bug this shape exists to avoid.** It is a `useCallback` over
   * `startUserBookDownload`, which is itself over three more; any of them
   * changing identity re-runs this effect, whose cleanup cancels the sweep in
   * flight — while the re-entry returns immediately, because a sweep IS still
   * running. The queue then never reaches its first book. Found on a device:
   * the book sat Ready on the server and nothing was ever fetched, with no
   * error anywhere, because every participant was behaving correctly.
   *
   * Cancellation therefore keys on the session, not on the render: the sweep
   * stops when the provider unmounts or the reader signs out, which are the
   * only two times stopping it is right.
   */
  useEffect(() => {
    if (!isAuthenticated) return
    autoCancelledRef.current = false

    const sweep = () => {
      autoCancelledRef.current = false
      runAutoDownload(() => autoCancelledRef.current)
        .catch(err => console.warn('[auto-download] stopped:', err))
    }
    sweep()

    // `useReconnectCount` was the wrong signal on its own: it fires on a
    // false → true REACHABILITY edge, and cellular is already reachable. A
    // reader who opens the app on mobile data (gate declines, correctly) and
    // then gets home and joins Wi-Fi produces no edge at all — nothing would
    // have run until the app was restarted. The same hole swallowed the launch
    // where NetInfo answers `unknown` first. So the trigger is the connection
    // TYPE changing, which is the thing the gate actually reads.
    let lastType: string | null = null
    const offNet = NetInfo.addEventListener(state => {
      const type = state.type ?? null
      if (type === lastType) return
      lastType = type
      if (type === 'wifi') sweep()
    })

    // And coming back to the app, which is when a book that was still
    // processing during the last sweep has usually become Ready.
    const offApp = AppState.addEventListener('change', next => {
      if (next === 'active') sweep()
    })

    return () => {
      autoCancelledRef.current = true
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current)
        processingTimerRef.current = null
      }
      processingTriesRef.current = 0
      offNet()
      offApp.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated])

  /**
   * The third moment is not an event anyone can subscribe to: the reader just
   * added a book. The upload screen calls this when one lands, so a book
   * finishes uploading and is simply already on the device.
   */
  const syncOfflineLibrary = useCallback(async () => {
    if (!isAuthenticated) return
    autoCancelledRef.current = false
    await runAutoDownload(() => autoCancelledRef.current)
  }, [isAuthenticated, runAutoDownload])

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
        syncOfflineLibrary,
        refreshCachedBooks,
      }}
    >
      {children}
    </DownloadContext.Provider>
  )
}
