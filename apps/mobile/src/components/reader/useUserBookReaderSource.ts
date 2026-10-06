import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useRouter } from 'expo-router'
import { WebView } from 'react-native-webview'
import { userBooksApi, isOfflineError, parseScrollLocator, buildUserBookProgressPayload, buildPdfProgressPayload, parsePdfPageLocator, parseTextPosition, serializeTextPosition } from '@textstack/shared'
import type { UserBookChapterDto, BookmarkDto, TextPosition } from '@textstack/shared'
import { API_URL } from '../../lib/api'
import { getUserBookLocalProgress, markUserBookLocalProgressSynced, saveUserBookLocalProgress, getUserBookIsPdf, setUserBookIsPdf, type UserBookLocalProgress } from '../../lib/progressStorage'
import { returnedToForeground, serverProvablyNewer } from '../../lib/progressRestore'
import { getCachedUserChapter, refreshCachedUserChapter, cacheUserChapter, getCachedUserBookMeta, listCachedUserChapters } from '../../lib/offlineDb'
import { userBookChapterSlug } from '../../lib/userBookChapters'
import { getCachedOriginalUri, touchOriginal } from '../../lib/originalFileCache'
import { deviceLayout, reflowWritesEnabled } from '../../lib/readerWriteMode'
import {
  pdfFlushDecision, shouldFlushOnClose, PDF_FLUSH_DEBOUNCE_MS,
} from '../../lib/pdfWritePolicy'
import { useReaderPersistence } from '../../hooks/useReaderPersistence'
import type { NewerPosition, PdfNewerOffer, ProgressSnapshot, ReaderChapterMeta, ReaderRuntime, SavedPosition } from './readerSource'

type ToastFn = (t: { message: string; variant: 'error' | 'success' | 'info' }) => void

type Params = {
  bookId: string
  chapterSlug: string
  showToast: ToastFn
}

/** Chapter → source start page, from the chapters cached on the device. */
const startPagesBySlug = (rows: { chapterSlug: string; sourceStartPage: number | null }[]) =>
  Object.fromEntries(rows.flatMap(r => (typeof r.sourceStartPage === 'number' && r.sourceStartPage >= 1 ? [[r.chapterSlug, r.sourceStartPage]] : [])))

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

  const [chapter, setChapter] = useState<UserBookChapterDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [chapterError, setChapterError] = useState<'offline' | 'notfound' | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkDto[]>([])
  const [chapters, setChapters] = useState<ReaderChapterMeta[]>([])
  const [chaptersLoading, setChaptersLoading] = useState(true)
  const [bookTitle, setBookTitle] = useState<string | null>(null)
  // The upload's own language — what TTS, translate and saves read the page as (M5).
  const [bookLanguage, setBookLanguage] = useState<string | null>(null)
  // ADR-012 S4b — Original-layout PDF. `hasOriginalPdf` gates the pdf.js viewer;
  // sourceStartPage per chapter drives the open page when a chapter is chosen.
  const [hasOriginalPdf, setHasOriginalPdf] = useState(false)
  /**
   * Whether `hasOriginalPdf` is an answer yet — from the device or the server (H1).
   *
   * Until it is, the reader shows its loading state and the reflow writer is off. Rendering the
   * reflow WebView on the default `false` let a reader scroll a PDF as text on a slow network,
   * and the save that followed wrote `scroll:` over `page:N`, locally and on the server.
   */
  const [layoutKnown, setLayoutKnown] = useState(false)
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
  const [pdfNewerPage, setPdfNewerPage] = useState<PdfNewerOffer | null>(null)

  useEffect(() => { userBookIdRef.current = bookId || null }, [bookId])

  /**
   * Load the current chapter — **device first**, network second.
   *
   * The order was the other way round, with the cache as the fallback for a
   * failed request. That works on a plane, where `fetch` rejects immediately,
   * and fails on every network that is present but useless: a captive portal, a
   * tunnel, a hotel Wi-Fi that opens the socket and never answers. There the
   * reader waited out the whole timeout in front of a book the app had already
   * downloaded in full — which is the opposite of the promise the automatic
   * download makes.
   *
   * When the cache answers, the request still goes out, and its only job is to
   * refresh the stored copy for the next open. Replacing the document under
   * someone mid-chapter would re-run position restoration on a page they are
   * already reading.
   *
   * The error when there is neither: `isOfflineError` separates "never reached
   * the server" from "the server says there is no such chapter", which are
   * different screens. Saying `notfound` unconditionally once told readers with
   * no signal that their book did not exist.
   */
  useEffect(() => {
    if (!bookId || !chapterSlug) return
    let cancelled = false
    setLoading(true)
    setChapterError(null)
    ;(async () => {
      let served = false
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
          served = true
        }
      } catch (cacheErr) {
        if (!cancelled) console.warn('Offline user-book chapter read failed:', cacheErr)
      }

      try {
        const ch = await userBooksApi.getUserBookChapter(bookId, chapterSlug)
        if (cancelled) return
        if (served) {
          void refreshCachedUserChapter(bookId, ch).catch(() => {})
          return
        }
        setChapter(ch)
        wordCountRef.current = ch.wordCount || 0
        setLoading(false)
      } catch (e) {
        // Already reading from the device: a failed refresh is not the reader's
        // problem and must not paint an error over a chapter they can see.
        if (cancelled || served) return
        console.warn('Failed to load user book chapter:', e)
        setChapterError(isOfflineError(e) ? 'offline' : 'notfound')
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [bookId, chapterSlug])

  // Which viewer, from the DEVICE first (H1) — never waits on the network when the phone knows:
  // the original file (and the opened chapter, for its start page) is here, or the book is known
  // not to be a PDF. Otherwise the book fetch below decides, success or failure.
  const routeSlugRef = useRef(chapterSlug)
  routeSlugRef.current = chapterSlug
  useEffect(() => {
    if (!bookId) return
    let cancelled = false
    setLayoutKnown(false)
    ;(async () => {
      const [uri, meta, flag, cachedChapters] = await Promise.all([
        getCachedOriginalUri(bookId, 'pdf').catch(() => null),
        getCachedUserBookMeta(bookId).catch(() => null),
        getUserBookIsPdf(bookId),
        listCachedUserChapters(bookId).catch(() => []),
      ])
      if (cancelled) return
      const layout = deviceLayout({
        hasLocalOriginal: !!uri,
        routeChapterOnDevice: cachedChapters.some(c => c.chapterSlug === routeSlugRef.current),
        knownPdf: meta?.isPdf ?? flag,
      })
      if (layout === 'original') {
        // Before the layout is published: the shell reads the chapter's start page once, at mount.
        sourceStartPageBySlugRef.current = startPagesBySlug(cachedChapters)
        void touchOriginal(bookId)
        setLocalOriginalUri(uri)
        setHasOriginalPdf(true)
        setLayoutKnown(true)
      } else if (layout === 'reflow') {
        setLayoutKnown(true)
      }
    })()
    return () => { cancelled = true }
  }, [bookId])

  // Load bookmarks + chapter list (TOC + book-wide word count).
  useEffect(() => {
    if (!bookId) return
    userBooksApi.getUserBookBookmarks(bookId).then(setBookmarks).catch(e => {
      console.warn('Failed to load user-book bookmarks:', e)
    })
    setChaptersLoading(true)
    let cancelled = false
    userBooksApi.getUserBook(bookId).then(async b => {
      bookTitleRef.current = b.title || null
      setBookTitle(b.title || null)
      setBookLanguage(b.language || null)
      offlineReflowOfPdfRef.current = false
      // Online, but read from disk if the reader downloaded it: faster to open
      // than a Range stream, and it keeps this path in daily use.
      //
      // Awaited BEFORE `hasOriginalPdf` is published, not resolved alongside
      // it. Publishing first and filling the URI in afterwards builds the
      // viewer twice — once against the streaming URL (a token fetch and a
      // Range stream, both wasted) and again when the file arrives, with the
      // resume path running a second time.
      const localOriginal = b.hasOriginalPdf === true
        ? await getCachedOriginalUri(bookId, 'pdf').catch(() => null)
        : null
      if (cancelled) return
      // Reading is what makes a file worth keeping. Without this the eviction
      // order would be download time, which throws away the book someone opens
      // daily in favour of one grabbed yesterday and never read.
      if (localOriginal) void touchOriginal(bookId)
      setLocalOriginalUri(localOriginal)
      setHasOriginalPdf(b.hasOriginalPdf === true)
      void setUserBookIsPdf(bookId, b.hasOriginalPdf === true)
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
        setBookLanguage(meta.language || null)
        // The original, if this device has it. When it does, an offline PDF
        // opens in the SAME Original layout as online — same coordinate space,
        // so nothing has to be suppressed and no images go missing. When it
        // does not, the old substitution still applies: extracted text, and the
        // server write held back because the two positions disagree.
        const localOriginal = meta.isPdf ? await getCachedOriginalUri(bookId, 'pdf') : null
        if (localOriginal) void touchOriginal(bookId)
        setLocalOriginalUri(localOriginal)
        sourceStartPageBySlugRef.current = startPagesBySlug(cachedChapters)
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
    }).finally(() => {
      if (cancelled) return
      setChaptersLoading(false)
      // Answered either way: the server said, or it could not be reached and the offline
      // branch above chose (Original from the file, or text).
      setLayoutKnown(true)
    })
    return () => { cancelled = true }
  }, [bookId])

  // Read by `persist`, whose identity is keyed on [bookId, chapters] only.
  const hasOriginalPdfRef = useRef(hasOriginalPdf)
  hasOriginalPdfRef.current = hasOriginalPdf
  const originalOwnsRef = useRef(false)
  originalOwnsRef.current = !reflowWritesEnabled({ hasOriginalPdf, forceReflow })

  const persist = useCallback((snap: ProgressSnapshot) => {
    if (!bookId) return
    // The Original viewer owns this book's position: a reflow snapshot here is fiction, and would
    // write `scroll:` over `page:N` (H1). `enabled` stops it upstream; this is the last word.
    if (originalOwnsRef.current) return
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
      // The device stamp the server orders writes by (ProgressClock), and the
      // one the local record below carries — so the two can be compared.
      recordedAt: snap.updatedAt,
    })
    const written = payload && !offlineReflowOfPdfRef.current
      ? userBooksApi.updateUserBookProgress(bookId, payload)
        .then(() => markUserBookLocalProgressSynced(bookId, snap.updatedAt))
        .catch(e => { if (__DEV__) console.warn('[user-book-progress] PUT failed:', e) })
      : undefined
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
      // A PDF read as text (offline, or "read as text"): keep the page the Original viewer resumes from.
    }, { keepPage: hasOriginalPdfRef.current || offlineReflowOfPdfRef.current }).catch(() => {})
    return written
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
  // The local record this chapter opened from — what a server answer has to be
  // newer than. Kept rather than re-read: the reader's own first save would
  // otherwise "beat" a server position that was newer when the book opened.
  const openedFromRef = useRef<UserBookLocalProgress | null>(null)

  /**
   * Where to reopen this chapter — from the DEVICE only, in the order of
   * preference anchor → offset → percent. This used to ask the server first and
   * wait for it, so a captive portal held the reader in front of a book already
   * on the phone, and a chapter read offline reopened at the server's older place.
   * The server is now asked in the background (loadNewerPosition).
   */
  const loadPosition = useCallback(async (slug: string): Promise<SavedPosition> => {
    const none: SavedPosition = { position: null, offset: null, percent: null }
    let local: UserBookLocalProgress | null = null
    try { local = await getUserBookLocalProgress(bookId) } catch {}
    openedFromRef.current = local
    if (!local || local.chapterSlug !== slug) return none
    // The anchor first: it is the only one of the three still true after the
    // text has reflowed, or been re-parsed, or been opened on another device.
    const position = parseTextPosition(local.positionJson)
    if (position && position.chapterSlug === slug) return { position, offset: null, percent: null }
    if (typeof local.scrollOffset === 'number' && local.scrollOffset > 0) {
      return { position: null, offset: local.scrollOffset, percent: null }
    }
    if (typeof local.chapterPercent === 'number' && local.chapterPercent > 0.005 && local.chapterPercent < 0.999) {
      return { position: null, offset: null, percent: local.chapterPercent }
    }
    return none
  }, [bookId])

  /** Background, after the open: the server's position, when provably newer than
   *  the local record the chapter opened from (another device, or a new phone). */
  const loadNewerPosition = useCallback(async (slug: string, opts?: { latest?: boolean }): Promise<NewerPosition | null> => {
    // Foreground return (H3): the record as it is at the return — see useEditionReaderSource.
    const base = opts?.latest ? await getUserBookLocalProgress(bookId) : openedFromRef.current
    const prog = await userBooksApi.getUserBookProgress(bookId)
    if (!serverProvablyNewer(base, prog)) return null
    const parsed = parseScrollLocator(prog.locator)
    // A `page:<N>` row belongs to the Original-layout viewer, not this one.
    const target = parsed?.slug ?? prog.chapterSlug
    if (!target) return null
    const p = parseTextPosition(prog.positionJson)
    const saved: SavedPosition = {
      position: p && p.chapterSlug === target ? p : null,
      offset: parsed && parsed.slug === target && parsed.offset > 0 ? parsed.offset : null,
      percent: null,
    }
    if (target === slug && !saved.position && saved.offset == null) return null
    const label = chapters.find(c => c.slug === target)?.title ?? target
    return { chapterSlug: target, saved, label }
  }, [bookId, chapters])

  // Which reader owns this book's position. ONE expression, two consumers — the
  // persistence wiring below and `original` in the returned runtime. They used
  // to be computed separately, and only the renderer's copy existed: the writer
  // had no idea a PDF viewer was on screen, so its unmount flush overwrote
  // `page:16` with `scroll:<url-slug>:0`. See readerWriteMode.ts.
  const reflowWrites = reflowWritesEnabled({ hasOriginalPdf, forceReflow })

  const navigateToChapter = useCallback((slug: string) => {
    router.replace(`/my-books/read/${bookId}/${slug}`)
  }, [router, bookId])

  const { saveProgress, bumpProgress, onWebViewLoaded, onRestoreLanded, onDocumentRebuild, beginReflow, chapterNavigatorRef, positionSettled } = useReaderPersistence({
    bookKey: bookId || null,
    chapterSlug,
    chapterId: chapter?.id ?? null,
    injectJs,
    progressRef, scrollOffsetRef, currentChapterSlugRef, bookProgressRef, positionRef,
    persist, loadPosition, loadNewerPosition, navigateToChapter,
    enabled: reflowWrites && layoutKnown,
  })

  // Puts a chapter on the device before the reader opens it (end-of-chapter
  // block), so the open is instant and works offline. Device first, like the
  // initial load (chapterLoadOrder.test.ts). Throws when neither has it.
  const ensureChapter = useCallback(async (slug: string) => {
    if (await getCachedUserChapter(bookId, slug)) return
    const ch = await userBooksApi.getUserBookChapter(bookId, slug)
    await cacheUserChapter(bookId, ch, chapters.find(c => c.slug === slug)?.chapterNumber ?? null)
  }, [bookId, chapters])

  const isChapterOnDevice = useCallback(async (slug: string) => !!(await getCachedUserChapter(bookId, slug)), [bookId])

  // --- S4c: Original-layout PDF resume page. The DEVICE's page opens the
  // document (`setPdfResumeReady(true)` before any request); the server is asked
  // after, and only a page provably newer than that one is handed on as
  // `pdfNewerPage` — the shell adopts it, moves there, or asks. This used to
  // await the server first, so a dead network held a downloaded PDF closed. ---
  useEffect(() => {
    setPdfNewerPage(null)
    if (!hasOriginalPdf || !bookId) { setPdfResumeReady(true); return }
    let cancelled = false
    setPdfResumeReady(false)
    setPdfResumePage(null)
    ;(async () => {
      let local: UserBookLocalProgress | null = null
      try { local = await getUserBookLocalProgress(bookId) } catch { /* no record → page 1 */ }
      if (cancelled) return
      const localPage = typeof local?.page === 'number' && local.page >= 1 ? local.page : null
      setPdfResumePage(localPage)
      setPdfResumeReady(true)
      try {
        const p = await userBooksApi.getUserBookProgress(bookId)
        if (cancelled) return
        const serverPage = parsePdfPageLocator(p?.locator)
        if (serverPage != null && serverPage !== localPage && serverProvablyNewer(local, p)) setPdfNewerPage({ page: serverPage, at: Date.now() })
      } catch { /* offline / no row: the device's page stands */ }
    })()
    return () => { cancelled = true }
  }, [hasOriginalPdf, bookId])

  // Back in the foreground (H3): the same background check for the Original viewer, against the
  // device's record as it is now. The shell adopts / moves / asks exactly as on open.
  useEffect(() => {
    if (!hasOriginalPdf || !bookId) return
    let alive = true
    let prev: string = AppState.currentState
    const sub = AppState.addEventListener('change', next => {
      const back = returnedToForeground(prev, next)
      prev = next
      if (!back) return
      ;(async () => {
        try {
          const local = await getUserBookLocalProgress(bookId)
          const p = await userBooksApi.getUserBookProgress(bookId)
          if (!alive) return
          const serverPage = parsePdfPageLocator(p?.locator)
          if (serverPage != null && serverPage !== local?.page && serverProvablyNewer(local, p)) setPdfNewerPage({ page: serverPage, at: Date.now(), onReturn: true })
        } catch { /* offline: this device's page stands */ }
      })()
    })
    return () => { alive = false; sub.remove() }
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
    // One stamp for the PUT and the local record, so the ack can mark exactly this write.
    const recordedAt = Date.now()
    const payload = buildPdfProgressPayload(page, numPages, recordedAt)
    userBooksApi.updateUserBookProgress(bookId, payload)
      .then(() => markUserBookLocalProgressSynced(bookId, recordedAt))
      .catch(e => { if (__DEV__) console.warn('[user-book-pdf-progress] PUT failed:', e) })
    // Local book-% cache so ContinueReadingCard renders the same "% of book" UX
    // as reflow books (page fraction === book fraction for a chapterless PDF).
    // `page` rides along and `chapterSlug` is explicitly null: an Original-layout
    // PDF has no chapter, and leaving a slug from an earlier reflow read beside a
    // fresh page number is exactly the self-contradicting record this store's
    // no-carry-forward rule exists to prevent.
    saveUserBookLocalProgress(bookId, {
      bookPercent: payload.percent,
      updatedAt: recordedAt,
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
    loading: loading || !layoutKnown,
    chapterError,
    chapterSlug,
    htmlChapterSlug: chapterSlug,
    bookTitle,
    bookTitleRef,
    bookLanguage,
    chapters,
    chaptersLoading,
    wordCount: wordCountRef.current,
    progressRef, scrollOffsetRef, currentChapterSlugRef, bookProgressRef, positionRef, totalWordCountRef,
    saveProgress, bumpProgress, onWebViewLoaded, onRestoreLanded, onDocumentRebuild, beginReflow, positionSettled,
    ensureChapter,
    isChapterOnDevice,
    onNavigateChapter: navigateToChapter,
    chapterNavigatorRef,
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
    originalNewerPage: pdfNewerPage,
    persistPdfPage,
    onTogglePageBookmark: togglePageBookmark,
    isPageBookmarked,
    // Only offer "read as text" when reflow chapters exist to fall back to.
    onForceReflow: chapters.length > 0 ? onForceReflow : undefined,
  }
}
