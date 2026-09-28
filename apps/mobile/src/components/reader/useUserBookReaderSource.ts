import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { WebView } from 'react-native-webview'
import { userBooksApi, isOfflineError, parseScrollLocator, buildUserBookProgressPayload, buildPdfProgressPayload, parsePdfPageLocator, parseTextPosition, serializeTextPosition } from '@textstack/shared'
import type { UserBookChapterDto, BookmarkDto, TextPosition } from '@textstack/shared'
import { API_URL } from '../../lib/api'
import { getUserBookLocalProgress, saveUserBookLocalProgress } from '../../lib/progressStorage'
import { getCachedUserChapter, getCachedUserBookMeta, listCachedUserChapters } from '../../lib/offlineDb'
import { userBookChapterSlug } from '../../lib/userBookChapters'
import { getCachedOriginalUri } from '../../lib/originalFileCache'
import { reflowWritesEnabled } from '../../lib/readerWriteMode'
import {
  pdfFlushDecision, shouldFlushOnClose, PDF_FLUSH_DEBOUNCE_MS,
} from '../../lib/pdfWritePolicy'
import { useReaderPersistence } from '../../hooks/useReaderPersistence'
import { trackBookOpened } from '../../lib/analytics'
import type { ProgressSnapshot, ReaderChapterMeta, ReaderRuntime, SavedPosition } from './readerSource'

type ToastFn = (t: { message: string; variant: 'error' | 'success' | 'info' }) => void

type Params = {
  bookId: string
  chapterSlug: string
  showToast: ToastFn
}

const bookmarkSlug = (b: BookmarkDto) => (b.locator.startsWith('chapter:') ? b.locator.slice(8) : b.locator)

/**
 * User-uploaded book data source for the unified `<Reader>`. Owns the
 * /me/books data loading (chapter, chapter list, bookmarks) and supplies the
 * user-book progress I/O (`persist` / `loadPosition`) to the shared
 * `useReaderPersistence`. Returns the same normalized `ReaderRuntime` the
 * catalog source does — so there is one reader code path.
 *
 * Server stores chapter-level percent only; book-percent is cached locally
 * for the home/library "% of book" UX.
 */
export function useUserBookReaderSource({ bookId, chapterSlug, showToast }: Params): ReaderRuntime {
  const router = useRouter()

  const webViewRef = useRef<WebView>(null)
  const injectJs = useCallback((js: string) => {
    webViewRef.current?.injectJavaScript(`try{${js}}catch(e){console.error('[diag] injectJs failed:', e && e.message, ${JSON.stringify(js.slice(0, 80))});};true;`)
  }, [])

  const progressRef = useRef(0)
  const scrollOffsetRef = useRef(0)
  const currentChapterSlugRef = useRef<string | null>(null)
  const positionRef = useRef<TextPosition | null>(null)
  const bookProgressRef = useRef<number | null>(null)
  const totalWordCountRef = useRef(0)
  const wordCountRef = useRef(0)
  const bookTitleRef = useRef<string | null>(null)
  const userBookIdRef = useRef<string | null>(null)
  const nextChapterRef = useRef<{ slug: string; title: string } | null>(null)

  const [chapter, setChapter] = useState<UserBookChapterDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [chapterError, setChapterError] = useState<'offline' | 'notfound' | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkDto[]>([])
  const [chapters, setChapters] = useState<ReaderChapterMeta[]>([])
  const [chaptersLoading, setChaptersLoading] = useState(true)
  const [bookTitle, setBookTitle] = useState<string | null>(null)
  // ADR-012 S4b — Original-layout PDF. `hasOriginalPdf` gates the pdf.js viewer;
  // sourceStartPage per chapter drives the open page when a chapter is chosen.
  const [hasOriginalPdf, setHasOriginalPdf] = useState(false)
  /**
   * The downloaded original on this device, as a `file://` URI, or null.
   *
   * Preferred over the network URL whenever it exists — online too, because a
   * file already on disk opens faster than a Range stream and keeps the offline
   * path exercised rather than reserved for emergencies.
   */
  const [localOriginalUri, setLocalOriginalUri] = useState<string | null>(null)
  /**
   * True while a PDF upload is being read offline, as its extracted text —
   * which now happens ONLY when the original was never downloaded to this
   * device (a book cached before originals existed, or a file that failed to
   * download). With the file present the reader stays in Original layout and
   * this stays false.
   *
   * It exists to STOP the server progress write. The position such a session
   * produces is a chapter-space one (`scroll:<slug>:<offset>`), while the book's
   * stored position is a page (`page:<N>`) — and if the connection comes back
   * mid-chapter, that PUT would overwrite the page the reader is actually on in
   * Original layout with a coordinate from a different space. The same
   * corruption `readerWriteMode.ts` was written to prevent, arriving by the one
   * door it does not watch. Local progress is still written, so the offline
   * session resumes itself correctly.
   */
  const offlineReflowOfPdfRef = useRef(false)
  const sourceStartPageBySlugRef = useRef<Record<string, number>>({})
  // S4c — corrupt-PDF fallback: flip out of Original layout into the reflow
  // reader (only offered when the book has reflow chapters).
  const [forceReflow, setForceReflow] = useState(false)
  // S4c — server resume page for the chapterless Original view (parsed from the
  // `page:<N>` progress locator). Fetched once the book is known to be a PDF;
  // it loses to a chapter's sourceStartPage, wins over nothing (mobile has no
  // local page cache). `pdfResumeReady` gates the initial scroll.
  const [pdfResumePage, setPdfResumePage] = useState<number | null>(null)
  const [pdfResumeReady, setPdfResumeReady] = useState(false)

  useEffect(() => { userBookIdRef.current = bookId || null }, [bookId])

  /**
   * Load the current chapter — network first, then the offline cache.
   *
   * The cache read is what makes a downloaded upload readable on a plane. Note
   * the error it reports when BOTH fail: this used to say `'notfound'`
   * unconditionally, so a reader with no signal was told their book did not
   * exist. `isOfflineError` separates "never reached the server" from "the
   * server says there is no such chapter", which are different screens.
   */
  useEffect(() => {
    if (!bookId || !chapterSlug) return
    let cancelled = false
    setLoading(true)
    setChapterError(null)
    ;(async () => {
      let onlineError: unknown = null
      try {
        const ch = await userBooksApi.getUserBookChapter(bookId, chapterSlug)
        if (cancelled) return
        setChapter(ch)
        wordCountRef.current = ch.wordCount || 0
        setLoading(false)
        return
      } catch (e) {
        onlineError = e
      }

      try {
        const cached = await getCachedUserChapter(bookId, chapterSlug)
        if (cancelled) return
        if (cached) {
          setChapter({
            id: cached.chapterId,
            slug: cached.chapterSlug,
            title: cached.title,
            html: cached.html,
            wordCount: cached.wordCount,
            prev: cached.prev,
            next: cached.next,
            sourceStartPage: cached.sourceStartPage,
          })
          wordCountRef.current = cached.wordCount || 0
          setLoading(false)
          return
        }
      } catch (cacheErr) {
        if (!cancelled) console.warn('Offline user-book chapter read failed:', cacheErr)
      }

      if (cancelled) return
      console.warn('Failed to load user book chapter:', onlineError)
      setChapterError(isOfflineError(onlineError) ? 'offline' : 'notfound')
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [bookId, chapterSlug])

  // Load bookmarks + chapter list (TOC + book-wide word count) + analytics.
  const bookOpenedFiredRef = useRef(false)
  useEffect(() => {
    if (!bookId) return
    if (!bookOpenedFiredRef.current) {
      bookOpenedFiredRef.current = true
      trackBookOpened({ source: 'userbook', userBookId: bookId })
    }
    userBooksApi.getUserBookBookmarks(bookId).then(setBookmarks).catch(e => {
      console.warn('Failed to load user-book bookmarks:', e)
    })
    setChaptersLoading(true)
    userBooksApi.getUserBook(bookId).then(b => {
      bookTitleRef.current = b.title || null
      setBookTitle(b.title || null)
      setHasOriginalPdf(b.hasOriginalPdf === true)
      offlineReflowOfPdfRef.current = false
      // Online, but read from disk if the reader downloaded it: faster to open
      // than a Range stream, and it keeps this path in daily use.
      if (b.hasOriginalPdf === true) {
        getCachedOriginalUri(bookId, 'pdf').then(uri => { setLocalOriginalUri(uri) })
      } else {
        setLocalOriginalUri(null)
      }
      const pageBySlug: Record<string, number> = {}
      const mapped: ReaderChapterMeta[] = b.chapters.map(ch => {
        const slug = userBookChapterSlug(ch)
        const startPage = typeof ch.sourceStartPage === 'number' && ch.sourceStartPage >= 1 ? ch.sourceStartPage : null
        if (startPage) pageBySlug[slug] = startPage
        return {
          slug,
          title: ch.title,
          chapterNumber: ch.chapterNumber,
          wordCount: typeof ch.wordCount === 'number' && ch.wordCount > 0 ? ch.wordCount : 0,
          sourceStartPage: startPage,
        }
      })
      sourceStartPageBySlugRef.current = pageBySlug
      setChapters(mapped)
      const summed = mapped.reduce((s, c) => s + (c.wordCount || 0), 0)
      totalWordCountRef.current = (typeof b.totalWordCount === 'number' && b.totalWordCount > 0) ? b.totalWordCount : summed
    }).catch(async e => {
      console.warn('Failed to load user-book chapter list:', e)
      // Offline fallback: the downloaded copy carries the title, the TOC and the
      // word counts the footer's "N min left" is computed from. Without this the
      // reader opened a cached chapter inside an untitled book with an empty
      // table of contents.
      try {
        const [meta, cachedChapters] = await Promise.all([
          getCachedUserBookMeta(bookId),
          listCachedUserChapters(bookId),
        ])
        if (!meta) return
        bookTitleRef.current = meta.title || null
        setBookTitle(meta.title || null)
        // The original, if this device has it. When it does, an offline PDF
        // opens in the SAME Original layout as online — same coordinate space,
        // so nothing has to be suppressed and no images go missing. When it
        // does not, the old substitution still applies: extracted text, and the
        // server write held back because the two positions disagree.
        const localOriginal = meta.isPdf ? await getCachedOriginalUri(bookId, 'pdf') : null
        setLocalOriginalUri(localOriginal)
        setHasOriginalPdf(Boolean(localOriginal))
        offlineReflowOfPdfRef.current = meta.isPdf && !localOriginal
        const mapped: ReaderChapterMeta[] = cachedChapters.map((ch, idx) => ({
          slug: ch.chapterSlug,
          title: ch.title,
          chapterNumber: ch.chapterNumber ?? idx,
          wordCount: typeof ch.wordCount === 'number' && ch.wordCount > 0 ? ch.wordCount : 0,
          sourceStartPage: ch.sourceStartPage,
        }))
        setChapters(mapped)
        const summed = mapped.reduce((s, c) => s + (c.wordCount || 0), 0)
        totalWordCountRef.current = (meta.totalWordCount && meta.totalWordCount > 0) ? meta.totalWordCount : summed
      } catch (cacheErr) {
        console.warn('Offline user-book meta read failed:', cacheErr)
      }
    }).finally(() => { setChaptersLoading(false) })
  }, [bookId])

  const persist = useCallback((snap: ProgressSnapshot) => {
    if (!bookId) return
    const payload = buildUserBookProgressPayload({
      currentChapterSlug: snap.chapterSlug,
      fallbackChapterSlug: snap.chapterSlug,
      chapterProgress: snap.chapterPercent,
      scrollOffset: snap.scrollOffset,
      // Store book-wide % (canonical ProgressPercent) — same semantics the web
      // reader and library shelf use. computeBookProgress turns the within-chapter
      // scroll into a book-wide value using the chapter word counts.
      chapters,
      totalWordCount: totalWordCountRef.current || undefined,
      // Assigned, never carried forward — absent means the server clears the
      // stored one rather than leaving it beside a fresher pixel offset.
      positionJson: serializeTextPosition(snap.position) ?? undefined,
    })
    if (payload && !offlineReflowOfPdfRef.current) {
      userBooksApi.updateUserBookProgress(bookId, payload)
        .catch(e => { if (__DEV__) console.warn('[user-book-progress] PUT failed:', e) })
    }
    // Always written, not only when the server write succeeds — this record is
    // what reopens the book at the right place when the PUT above could not be
    // made at all. `bookPercent` is carried forward by the store when it is not
    // known yet (it never is offline: it needs the chapter list).
    saveUserBookLocalProgress(bookId, {
      bookPercent: snap.bookPercent,
      updatedAt: snap.updatedAt,
      chapterSlug: snap.chapterSlug,
      chapterPercent: snap.chapterPercent,
      scrollOffset: snap.scrollOffset,
      positionJson: serializeTextPosition(snap.position) ?? undefined,
    }).catch(() => {})
  }, [bookId, chapters])

  /**
   * Where to reopen this chapter.
   *
   * Server first — it is the only copy that knows about the other device. When
   * it cannot be reached, the local record written by `persist` answers instead,
   * in the same order of preference (anchor → offset → percent). Before this,
   * the `catch` swallowed the failure and returned "nowhere", so every offline
   * reopen landed at the top of the chapter.
   */
  const loadPosition = useCallback(async (slug: string): Promise<SavedPosition> => {
    try {
      const prog = await userBooksApi.getUserBookProgress(bookId)
      if (prog && prog.chapterSlug === slug) {
        // The anchor first: it is the only one of the three still true after the
        // text has reflowed, or been re-parsed, or been opened on another device.
        const position = parseTextPosition(prog.positionJson)
        if (position && position.chapterSlug === slug) return { position, offset: null, percent: null }
        const parsed = parseScrollLocator(prog.locator)
        if (parsed && parsed.slug === slug && parsed.offset > 0) return { position: null, offset: parsed.offset, percent: null }
        // Percent fallback — was missing on user-book reader (one half of the
        // "returns to top" bug); now shared with catalog so it can't drift.
        if (typeof prog.percent === 'number' && prog.percent > 0.005 && prog.percent < 0.999) {
          return { position: null, offset: null, percent: prog.percent }
        }
      }
      // The server answered and had nothing for this chapter. That is an answer:
      // do not overrule it with a local record it may have already superseded.
      return { position: null, offset: null, percent: null }
    } catch {
      // Fall through to the local copy — the request never reached the server.
    }

    try {
      const local = await getUserBookLocalProgress(bookId)
      if (local && local.chapterSlug === slug) {
        const position = parseTextPosition(local.positionJson)
        if (position && position.chapterSlug === slug) return { position, offset: null, percent: null }
        if (typeof local.scrollOffset === 'number' && local.scrollOffset > 0) {
          return { position: null, offset: local.scrollOffset, percent: null }
        }
        if (typeof local.chapterPercent === 'number' && local.chapterPercent > 0.005 && local.chapterPercent < 0.999) {
          return { position: null, offset: null, percent: local.chapterPercent }
        }
      }
    } catch {}
    return { position: null, offset: null, percent: null }
  }, [bookId])

  // Which reader owns this book's position. ONE expression, two consumers — the
  // persistence wiring below and `original` in the returned runtime. They used
  // to be computed separately, and only the renderer's copy existed: the writer
  // had no idea a PDF viewer was on screen, so its unmount flush overwrote
  // `page:16` with `scroll:<url-slug>:0`. See readerWriteMode.ts.
  const reflowWrites = reflowWritesEnabled({ hasOriginalPdf, forceReflow })

  // Stable: the persistence hook keys effects on the identity of what it is given,
  // and a rebuilt callback here would re-arm a restore.
  const navigateToChapter = useCallback((slug: string) => {
    router.replace(`/my-books/read/${bookId}/${slug}`)
  }, [router, bookId])

  const { saveProgress, bumpProgress, onWebViewLoaded, onRestoreLanded, onDocumentRebuild, beginReflow } = useReaderPersistence({
    bookKey: bookId || null,
    chapterSlug,
    chapterId: chapter?.id ?? null,
    injectJs,
    progressRef, scrollOffsetRef, currentChapterSlugRef, bookProgressRef, positionRef,
    persist, loadPosition, navigateToChapter,
    enabled: reflowWrites,
  })

  const loadNext = useCallback(async () => {
    const next = nextChapterRef.current
    if (!next || !bookId) return
    try {
      let html: string
      let title: string
      let slug: string
      let wordCount: number | null
      let following: { slug: string; title: string } | null
      try {
        const ch = await userBooksApi.getUserBookChapter(bookId, next.slug)
        ;({ html, title, slug, wordCount } = ch)
        following = ch.next
      } catch (onlineErr) {
        // Same cache fallback as the first chapter: without it, reading a
        // downloaded book offline stopped dead at the end of chapter one, which
        // is where infinite scroll takes over from the initial load.
        const cached = await getCachedUserChapter(bookId, next.slug)
        if (!cached) throw onlineErr
        html = cached.html
        title = cached.title
        slug = cached.chapterSlug
        wordCount = cached.wordCount
        following = cached.next
      }
      injectJs(`appendChapter(${JSON.stringify({ html, title, slug })})`)
      wordCountRef.current += wordCount || 0
      nextChapterRef.current = following
      if (!following) injectJs('disableInfiniteScroll()')
    } catch (e) {
      console.warn('Failed to load next user-book chapter:', e)
      injectJs('disableInfiniteScroll()')
    }
  }, [bookId, injectJs])

  // --- S4c: Original-layout PDF server resume page. Fetched once the book is
  // known to be a PDF; parsed from the `page:<N>` progress locator. ---
  useEffect(() => {
    if (!hasOriginalPdf || !bookId) { setPdfResumeReady(true); return }
    let cancelled = false
    setPdfResumeReady(false)
    setPdfResumePage(null)
    userBooksApi.getUserBookProgress(bookId)
      .then(p => { if (!cancelled) setPdfResumePage(parsePdfPageLocator(p?.locator)) })
      .catch(() => { /* offline → falls back to chapter page / page 1 */ })
      .finally(() => { if (!cancelled) setPdfResumeReady(true) })
    return () => { cancelled = true }
  }, [hasOriginalPdf, bookId])

  // --- S4c: page-based progress persistence for the Original view. A PDF page
  // fraction lands in the SAME ProgressPercent field the reflow reader writes
  // (buildPdfProgressPayload) so the library card shows one number and resume
  // works cross-device. Debounced (~2s) so we don't PUT on every page tick, and
  // NEVER fed into the word-based reading session. ---
  const pdfServerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pdfPendingRef = useRef<{ page: number; numPages: number } | null>(null)
  // When the CURRENT pending page first became pending — not when it was last
  // touched. The debounce used to be re-armed on every tick, so a reader turning
  // pages faster than once per 2s never reached a flush at all.
  const pdfPendingSinceRef = useRef<number | null>(null)
  const pdfLastWrittenRef = useRef<number | null>(null)
  const pdfAcceptedAnyRef = useRef(false)

  const writePdfProgress = useCallback((page: number, numPages: number) => {
    if (!bookId || numPages < 1) return
    pdfPendingRef.current = null
    pdfPendingSinceRef.current = null
    pdfLastWrittenRef.current = page
    const payload = buildPdfProgressPayload(page, numPages)
    userBooksApi.updateUserBookProgress(bookId, payload)
      .catch(e => { if (__DEV__) console.warn('[user-book-pdf-progress] PUT failed:', e) })
    // Local book-% cache so ContinueReadingCard renders the same "% of book" UX
    // as reflow books (page fraction === book fraction for a chapterless PDF).
    // `page` rides along and `chapterSlug` is explicitly null: an Original-layout
    // PDF has no chapter, and leaving a slug from an earlier reflow read beside a
    // fresh page number is exactly the self-contradicting record this store's
    // no-carry-forward rule exists to prevent.
    saveUserBookLocalProgress(bookId, {
      bookPercent: payload.percent,
      updatedAt: Date.now(),
      chapterSlug: null,
      page,
    }).catch(() => {})
  }, [bookId])

  const flushPdfProgress = useCallback(() => {
    if (pdfServerTimerRef.current) { clearTimeout(pdfServerTimerRef.current); pdfServerTimerRef.current = null }
    const pending = pdfPendingRef.current
    if (!pending) return
    if (pdfFlushDecision({
      pendingPage: pending.page,
      lastWrittenPage: pdfLastWrittenRef.current,
      pendingSince: pdfPendingSinceRef.current,
      now: Date.now(),
    }) === 'skip') {
      pdfPendingRef.current = null
      pdfPendingSinceRef.current = null
      return
    }
    writePdfProgress(pending.page, pending.numPages)
  }, [writePdfProgress])

  const persistPdfPage = useCallback((page: number, numPages: number) => {
    pdfAcceptedAnyRef.current = true
    if (pdfPendingSinceRef.current == null) pdfPendingSinceRef.current = Date.now()
    pdfPendingRef.current = { page, numPages }
    if (pdfServerTimerRef.current) clearTimeout(pdfServerTimerRef.current)
    // Keep re-arming the quiet period, but never let a position go unwritten for
    // longer than the max wait — that is the skimming case.
    const decision = pdfFlushDecision({
      pendingPage: page,
      lastWrittenPage: pdfLastWrittenRef.current,
      pendingSince: pdfPendingSinceRef.current,
      now: Date.now(),
    })
    if (decision === 'flush') { writePdfProgress(page, numPages); return }
    if (decision === 'skip') return
    pdfServerTimerRef.current = setTimeout(flushPdfProgress, PDF_FLUSH_DEBOUNCE_MS)
  }, [flushPdfProgress, writePdfProgress])

  // Final write on reader close — but only when this document ever accepted a
  // page. Closing during a jump means there is no position to record, and
  // writing one would save wherever the viewer happened to be passing through.
  useEffect(() => () => {
    if (pdfServerTimerRef.current) { clearTimeout(pdfServerTimerRef.current); pdfServerTimerRef.current = null }
    const pending = pdfPendingRef.current
    if (!pending) return
    if (!shouldFlushOnClose({
      pendingPage: pending.page,
      lastWrittenPage: pdfLastWrittenRef.current,
      acceptedAnyPage: pdfAcceptedAnyRef.current,
    })) return
    writePdfProgress(pending.page, pending.numPages)
  }, [writePdfProgress])

  // --- S4c: page bookmarks. A chapterless PDF has no chapter to key on, so the
  // bookmark anchors to a 1-based page via `locator: page:<N>` + `chapterId: null`
  // (backend supports the nullable FK). Optimistic add/remove with rollback. ---
  const togglePageBookmark = useCallback(async (page: number) => {
    if (!bookId || !Number.isFinite(page) || page < 1) return
    const existing = bookmarks.find(b => parsePdfPageLocator(b.locator) === page)
    if (existing) {
      setBookmarks(prev => prev.filter(b => b.id !== existing.id))
      try {
        await userBooksApi.deleteUserBookBookmark(bookId, existing.id)
      } catch (e) {
        console.warn('Delete user-book page bookmark failed:', e)
        setBookmarks(prev => (prev.some(b => b.id === existing.id) ? prev : [...prev, existing]))
        showToast({ message: 'Could not remove bookmark. Try again.', variant: 'error' })
      }
    } else {
      try {
        const bm = await userBooksApi.createUserBookBookmark(bookId, {
          chapterId: null,
          locator: `page:${page}`,
          title: `Page ${page}`,
        })
        setBookmarks(prev => [...prev, bm])
      } catch (e) {
        console.warn('Create user-book page bookmark failed:', e)
        showToast({ message: 'Could not add bookmark. Try again.', variant: 'error' })
      }
    }
  }, [bookId, bookmarks, showToast])

  const isPageBookmarked = useCallback(
    (page: number) => bookmarks.some(b => parsePdfPageLocator(b.locator) === page),
    [bookmarks],
  )

  const onForceReflow = useCallback(() => setForceReflow(true), [])

  const toggleBookmark = useCallback(async (slug: string) => {
    if (!bookId || !slug || !chapter) return
    const existing = bookmarks.find(b => bookmarkSlug(b) === slug)
    if (existing) {
      setBookmarks(prev => prev.filter(b => b.id !== existing.id))
      try {
        await userBooksApi.deleteUserBookBookmark(bookId, existing.id)
      } catch (e) {
        console.warn('Delete user-book bookmark failed:', e)
        setBookmarks(prev => (prev.some(b => b.id === existing.id) ? prev : [...prev, existing]))
        showToast({ message: 'Could not remove bookmark. Try again.', variant: 'error' })
      }
    } else {
      try {
        const bm = await userBooksApi.createUserBookBookmark(bookId, {
          chapterId: chapter.id,
          locator: `chapter:${slug}`,
          title: chapter.title,
        })
        setBookmarks(prev => [...prev, bm])
      } catch (e) {
        console.warn('Create user-book bookmark failed:', e)
        showToast({ message: 'Could not add bookmark. Try again.', variant: 'error' })
      }
    }
  }, [bookId, chapter, bookmarks, showToast])

  const deleteBookmark = useCallback(async (bmId: string) => {
    if (!bookId) return
    const snapshot = bookmarks.find(b => b.id === bmId) ?? null
    setBookmarks(prev => prev.filter(b => b.id !== bmId))
    try {
      await userBooksApi.deleteUserBookBookmark(bookId, bmId)
    } catch (e) {
      console.warn('Delete user-book bookmark (sheet) failed:', e)
      if (snapshot) setBookmarks(prev => (prev.some(b => b.id === bmId) ? prev : [...prev, snapshot]))
      showToast({ message: 'Could not remove bookmark. Try again.', variant: 'error' })
    }
  }, [bookId, bookmarks, showToast])

  return {
    source: { kind: 'userbook', id: bookId || null, idRef: userBookIdRef },
    webViewRef,
    injectJs,
    chapter: chapter
      ? { id: chapter.id, title: chapter.title, html: chapter.html, prev: chapter.prev, next: chapter.next }
      : null,
    loading,
    chapterError,
    chapterSlug,
    htmlChapterSlug: chapterSlug,
    bookTitle,
    bookTitleRef,
    chapters,
    chaptersLoading,
    wordCount: wordCountRef.current,
    progressRef, scrollOffsetRef, currentChapterSlugRef, bookProgressRef, positionRef, totalWordCountRef,
    saveProgress, bumpProgress, onWebViewLoaded, onRestoreLanded, onDocumentRebuild, beginReflow,
    onChapterLoaded: () => {
      if (chapter?.next) {
        nextChapterRef.current = chapter.next
        injectJs('enableInfiniteScroll()')
      }
    },
    onRequestNextChapter: loadNext,
    onNavigateChapter: navigateToChapter,
    bookmarks,
    onToggleCurrentBookmark: toggleBookmark,
    onDeleteBookmark: deleteBookmark,
    bookmarkChapterSlug: bookmarkSlug,
    // ADR-012 S4b/S4c — render the ORIGINAL PDF pixel-perfect when the upload
    // has one, unless a corrupt-PDF fallback dropped us into reflow.
    original: !reflowWrites,
    // The downloaded file when there is one, the streaming URL otherwise. The
    // shell tells them apart by scheme: a `file://` needs no Bearer.
    originalFileUrl: hasOriginalPdf && bookId
      ? (localOriginalUri ?? userBooksApi.getUserBookFileUrl(bookId, API_URL))
      : null,
    originalInitialPage: sourceStartPageBySlugRef.current[chapterSlug] ?? null,
    originalResumePage: pdfResumePage,
    originalResumeReady: pdfResumeReady,
    persistPdfPage,
    onTogglePageBookmark: togglePageBookmark,
    isPageBookmarked,
    // Only offer "read as text" when reflow chapters exist to fall back to.
    onForceReflow: chapters.length > 0 ? onForceReflow : undefined,
  }
}
