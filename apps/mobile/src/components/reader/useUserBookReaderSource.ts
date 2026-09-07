import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { WebView } from 'react-native-webview'
import { userBooksApi, parseScrollLocator, buildUserBookProgressPayload, buildPdfProgressPayload, parsePdfPageLocator, parseTextPosition, serializeTextPosition } from '@textstack/shared'
import type { UserBookChapterDto, BookmarkDto, TextPosition } from '@textstack/shared'
import { API_URL } from '../../lib/api'
import { saveUserBookLocalProgress } from '../../lib/progressStorage'
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

  // Load the current chapter.
  useEffect(() => {
    if (!bookId || !chapterSlug) return
    let cancelled = false
    setLoading(true)
    setChapterError(null)
    userBooksApi.getUserBookChapter(bookId, chapterSlug)
      .then(ch => {
        if (cancelled) return
        setChapter(ch)
        wordCountRef.current = ch.wordCount || 0
      })
      .catch(e => {
        if (cancelled) return
        console.warn('Failed to load user book chapter:', e)
        setChapterError('notfound')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
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
      const pageBySlug: Record<string, number> = {}
      const mapped: ReaderChapterMeta[] = b.chapters.map(ch => {
        const slug = ch.slug || `chapter-${ch.chapterNumber}`
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
    }).catch(e => {
      console.warn('Failed to load user-book chapter list:', e)
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
    if (payload) {
      userBooksApi.updateUserBookProgress(bookId, payload)
        .catch(e => { if (__DEV__) console.warn('[user-book-progress] PUT failed:', e) })
    }
    if (typeof snap.bookPercent === 'number') {
      saveUserBookLocalProgress(bookId, { bookPercent: snap.bookPercent, updatedAt: snap.updatedAt }).catch(() => {})
    }
  }, [bookId, chapters])

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
      const ch = await userBooksApi.getUserBookChapter(bookId, next.slug)
      injectJs(`appendChapter(${JSON.stringify({ html: ch.html, title: ch.title, slug: ch.slug })})`)
      wordCountRef.current += ch.wordCount || 0
      nextChapterRef.current = ch.next || null
      if (!ch.next) injectJs('disableInfiniteScroll()')
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
    saveUserBookLocalProgress(bookId, { bookPercent: payload.percent, updatedAt: Date.now() }).catch(() => {})
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
    askTarget: bookId ? { kind: 'userbook', id: bookId } : undefined,
    // ADR-012 S4b/S4c — render the ORIGINAL PDF pixel-perfect when the upload
    // has one, unless a corrupt-PDF fallback dropped us into reflow.
    original: !reflowWrites,
    originalFileUrl: hasOriginalPdf && bookId ? userBooksApi.getUserBookFileUrl(bookId, API_URL) : null,
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
