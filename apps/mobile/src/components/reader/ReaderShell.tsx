import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import type { MutableRefObject, ReactNode, RefObject } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Animated, Linking, BackHandler, AppState } from 'react-native'
import { WebView } from 'react-native-webview'
import { useRouter, Stack } from 'expo-router'
import { t, computeBookProgress, estimateTimeLeft, formatMinutesLeft, plural, resolvePdfResumePage, chapterEndPage, buildChapterDiscussBrief, isReviewableChapter } from '@textstack/shared'
import type { Chapter, BookmarkDto, TextPosition } from '@textstack/shared'
import { buildReaderHtml, buildPdfViewerHtml } from '../../lib/readerHtml'
import {
  pdfDocumentKey, pdfChromeInjectionJs,
} from '../../lib/pdfViewerChrome'
import {
  readerDocumentKey, readerChromeInjectionJs, latchReaderChrome, readerChromeChanged, type ReaderChrome,
  readerTypographyInjectionJs, readerTypographyChanged, fontFaceKey, type ReaderTypography,
} from '../../lib/readerChrome'
import { pdfGateReduce, PDF_GATE_INITIAL, chapterSlugForPage, type PdfGateState } from '@textstack/shared'
import { getAccessToken, onUnauthorized, API_URL } from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { useReaderSettings } from '../../hooks/useReaderSettings'
import { useReaderBars } from '../../hooks/useReaderBars'
import { useKeepReaderAwake } from '../../hooks/useKeepReaderAwake'
import { useReadingPace } from '../../hooks/useReadingPace'
import { useReaderExitSummary } from '../../hooks/useReaderExitSummary'
import { useAssistantLauncher } from '../../hooks/useAssistantLauncher'
import { ConnectAssistantSheet } from '../library/ReviewChapterButton'
import { useReaderHighlights } from '../../hooks/useReaderHighlights'
import { useReaderVocabMap } from '../../hooks/useReaderVocabMap'
import { useReaderVocabActions } from '../../hooks/useReaderVocabActions'
import { useReaderSelection } from '../../hooks/useReaderSelection'
import { useReadingSession } from '../../hooks/useReadingSession'
import { useTts } from '../../hooks/useTts'
import { useQuickStats } from '../../hooks/useQuickStats'
import { useHaptics } from '../../hooks/useHaptics'
import { useToast } from '../../context/ToastContext'
import { useOnline } from '../../hooks/useOnline'
import type { PdfNewerOffer } from './readerSource'
import { returnedToForeground } from '../../lib/progressRestore'
import { saveWordIntent } from '../../lib/saveWordIntent'
import { readerTextLanguage } from '../../lib/bookLanguage'
import type { SessionJump } from '../../lib/sessionMath'
import { initialPdfJump } from '../../lib/pdfInitialJump'
import { capabilitiesFor } from '../../lib/capabilities'
import { claimGuestNudge } from '../../lib/guestNudge'
import { decideNewerPosition, readerMovedSince } from '../../lib/progressRestore'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useNativeLanguage } from '../../context/NativeLanguageContext'
import { ReaderSettingsDrawer } from '../ReaderSettingsDrawer'
import { BookmarksSheet } from '../BookmarksSheet'
import { HighlightsSheet } from '../HighlightsSheet'
import { SelectionActionBar } from '../SelectionActionBar'
import { TranslationSheet } from '../TranslationSheet'
import { ExplanationSheet } from '../ExplanationSheet'
import { HighlightNoteModal } from '../HighlightNoteModal'
import { TocSheet } from '../TocSheet'
import { ReaderStatsWidget } from '../ReaderStatsWidget'
import { ReaderTapCoachmark } from './ReaderTapCoachmark'
import { ReaderTopBar } from './ReaderTopBar'
import { PdfReaderChrome } from './PdfReaderChrome'
import { Ionicons } from '@expo/vector-icons'
import { fonts } from '../../theme/typography'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { latchChapterEnd, readerBackAction } from '../../lib/firstRun'
import { carryVisit, claimVisit } from '../../lib/readerVisit'
import { chapterEndModel, discussAfterSave, type ChapterEndLabels } from '../../lib/chapterEnd'

/** Lightweight {key} interpolation — shared `t()` returns raw keys, we fill them in here. */
function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
}

/** Which catalog the book belongs to. Drives the FK column used by highlights,
 *  vocab and reading-session — the ONLY thing that genuinely differs between the
 *  public-library reader and the user-uploaded-book reader. */
export type ReaderSource =
  | { kind: 'edition'; id: string | null; idRef: MutableRefObject<string | null>; slug: string }
  | { kind: 'userbook'; id: string | null; idRef: MutableRefObject<string | null> }

/** A loaded chapter, normalised across both data sources. */
export interface ReaderShellChapter {
  id: string
  title: string
  html: string
  prev?: { slug: string; title?: string } | null
  next?: { slug: string; title?: string } | null
}

export interface ReaderShellProps {
  source: ReaderSource
  /** Owned by the route (so its data hooks can inject too); attached to the WebView here. */
  webViewRef: RefObject<WebView | null>
  injectJs: (js: string) => void

  /** A loaded chapter — the route handles loading/error and only renders the shell once ready. */
  chapter: ReaderShellChapter
  /** URL slug of the current chapter. */
  chapterSlug: string
  /** 3rd arg to buildReaderHtml (chapter slug baked into 'progress' messages).
   *  Public passes its chapterSlug; user-book historically passed undefined. */
  htmlChapterSlug?: string
  bookTitle: string | null
  /** Language of the book's text. Absent → the app language. See bookLanguage.ts (M5). */
  bookLanguage?: string | null
  chapters: { slug: string; title: string; chapterNumber?: number; wordCount?: number | null; sourceStartPage?: number | null }[]
  chaptersLoading: boolean

  // Progress/session machinery — refs created by the route (its progress + session
  // hooks read them); mutated here from the WebView 'progress' message.
  progressRef: MutableRefObject<number>
  scrollOffsetRef: MutableRefObject<number>
  currentChapterSlugRef: MutableRefObject<string | null>
  bookProgressRef: MutableRefObject<number | null>
  positionRef: MutableRefObject<TextPosition | null>
  totalWordCountRef: MutableRefObject<number>
  bumpProgress: () => void
  /** Returns the server write when one went out (Discuss waits for it). */
  saveProgress: () => Promise<unknown> | void

  /** Signalled once the WebView finishes loading. The shared persistence
   *  layer gates scroll-restore on this + the async saved-position fetch, so
   *  restore can't race the load (the "always returns to top" bug). */
  onWebViewLoaded: () => void

  /** The WebView acknowledged a restore, carrying back the id it was issued with. */
  onRestoreLanded: (restoreId: number, scrollY?: number) => void
  /** The chapter's restore has landed (or there was nothing to restore). M8. */
  positionSettled: boolean
  /** Where a programmatic restore stands — its travel and its distance are not reading. */
  sessionJumpRef: MutableRefObject<SessionJump>
  onDocumentRebuild: () => void
  reflow: (buildJs: (restoreId: number) => string) => void

  /** Put a chapter on the device before opening it (end-of-chapter block). */
  ensureChapter: (slug: string) => Promise<void>
  /** The chapter is in SQLite — a local read, no network. */
  isChapterOnDevice: (slug: string) => Promise<boolean>

  /** Perform the actual router.replace to a chapter slug (path differs per source). */
  onNavigateChapter: (slug: string) => void
  /** Filled with `navigateChapter` below, for the persistence layer's prompt. */
  chapterNavigatorRef: MutableRefObject<((slug: string) => void) | null>

  // Bookmarks (state + mutations owned by the route; locator→slug mapping differs).
  // "is the ACTIVE chapter bookmarked" is computed here since activeSlug lives here.
  bookmarks: BookmarkDto[]
  onToggleCurrentBookmark: (slug: string) => void
  onDeleteBookmark: (id: string) => void
  bookmarkChapterSlug: (b: BookmarkDto) => string

  /** Book title ref (vocab-save payload). */
  bookTitleRef: MutableRefObject<string | null>
  /** Word count of the loaded chapter (reading-session input). */
  wordCount: number
  /** Explain sheet "bookId" — editionId for public, undefined for user-book. */
  explainBookId?: string
  /** ADR-012 S4b — render the ORIGINAL PDF (pdf.js viewer) instead of the reflow
   *  HTML. Same shell, one branch: the WebView source swaps and the reflow-only
   *  scroll/progress/chapter-end message branches go inert. */
  original?: boolean
  /** Range-enabled URL of the original PDF (Bearer injected into pdf.js, not the URL). */
  originalFileUrl?: string | null
  /** 1-based page to open the PDF at (chapter start page). Wins over the server
   *  resume page. Null → use the server resume page, else page 1. */
  originalInitialPage?: number | null
  /** Server-persisted resume page (parsed from the `page:<N>` locator). Used
   *  when the chapter carries no page. (ADR-012 S4c) */
  originalResumePage?: number | null
  /** False until the device's resume page has been read — the initial jump waits
   *  on this (ignored when `originalInitialPage` is set). Never waits on a network. */
  originalResumeReady?: boolean
  /** A page the server holds that is provably newer than the one the PDF opened
   *  at, found after the open. See the effect that consumes it. */
  originalNewerPage?: PdfNewerOffer | null
  /** Persist a PDF page position to server progress (debounced by the source).
   *  Never feeds the word-based reading session. */
  persistPdfPage?: (page: number, numPages: number) => void
  /** Toggle a page bookmark for the current PDF page (original mode). */
  onTogglePageBookmark?: (page: number) => void
  /** Whether a given 1-based page has a page bookmark. */
  isPageBookmarked?: (page: number) => boolean
  /** Drop into the reflow reader on a corrupt PDF. Undefined when no reflow
   *  chapters exist (→ hard error). */
  onForceReflow?: () => void
}

/**
 * The shared reader body for BOTH the public-library reader and the user-uploaded
 * book reader. Owns the WebView and every WebView-coupled concern — vocab underline +
 * inline-translation gloss, highlights, text selection, immersive bars, top bar,
 * footer, sheets, scroll restore and the 'progress'/'selection'/'highlightTap' message
 * routing. The two routes stay thin: they load their source-specific data (chapter,
 * chapter list, bookmarks, progress, reading session) and hand the
 * results + a `source` discriminator down here. This is the single place the reader
 * UX lives, so a fix lands in both catalogs at once (was: copy-pasted + drifted).
 */
export function ReaderShell(props: ReaderShellProps) {
  const {
    source, webViewRef, injectJs, chapter, chapterSlug, htmlChapterSlug,
    bookTitle, chapters, chaptersLoading,
    progressRef, scrollOffsetRef, currentChapterSlugRef, bookProgressRef, positionRef, totalWordCountRef,
    bumpProgress, saveProgress,
    onWebViewLoaded, onRestoreLanded, positionSettled, sessionJumpRef, onDocumentRebuild, reflow,
    ensureChapter, isChapterOnDevice, onNavigateChapter, chapterNavigatorRef,
    bookmarks, onToggleCurrentBookmark, onDeleteBookmark, bookmarkChapterSlug,
    bookTitleRef, wordCount, explainBookId,
    original, originalFileUrl, originalInitialPage,
    originalResumePage, originalResumeReady, originalNewerPage, persistPdfPage,
    onTogglePageBookmark, isPageBookmarked, onForceReflow,
  } = props

  const router = useRouter()
  const { isAuthenticated, user } = useAuth()
  const { settings, update: updateSettings, resolvedFontFamily, resolvedTheme } = useReaderSettings()
  const { colors } = useTheme()
  const { language } = useLanguage()
  // The UI speaks `language`; the page is written in this one (M5).
  const textLanguage = readerTextLanguage(props.bookLanguage, language)
  const { nativeLanguage } = useNativeLanguage()
  const { toggle: toggleTts, isSpeaking, isLoading: isTtsLoading } = useTts()
  const quickStats = useQuickStats(isAuthenticated)
  const haptics = useHaptics()
  const { show: showToast, dismiss: hideToast } = useToast()
  // The PDF newer-page prompt, hidden when the reader closes (M1).
  const pdfNewerToastRef = useRef<number | null>(null)
  useEffect(() => () => hideToast(pdfNewerToastRef.current), [hideToast])
  const insets = useSafeAreaInsets()
  // Gated on a real chapter, so an error overlay or a failed load lets the
  // phone sleep as usual.
  useKeepReaderAwake(!!chapter)
  const wpm = useReadingPace(!!chapter && !original)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [highlightsOpen, setHighlightsOpen] = useState(false)
  const [translateOpen, setTranslateOpen] = useState(false)
  const [explainOpen, setExplainOpen] = useState(false)
  const [tocOpen, setTocOpen] = useState(false)
  const [progress, setProgress] = useState(0)
  const [bookProgress, setBookProgress] = useState<number | null>(null)
  const updateBookProgress = (slug: string | null, chapterProgress: number) => {
    const bp = computeBookProgress(chapters, slug, chapterProgress, totalWordCountRef.current)
    bookProgressRef.current = bp
    setBookProgress(bp)
    return bp
  }

  // A chapter change remounts this screen (router.replace mints a new route key), so what belongs
  // to the whole visit — the reading session, the saved-word count, "finished a chapter" — is
  // handed over by navigateChapter and claimed here, once. See readerVisit.ts.
  const visitKey = source.kind === 'edition' ? `edition:${source.slug}` : `userbook:${source.id}`
  const [visit] = useState(() => claimVisit(visitKey))

  const sessionWordCountRef = useRef(visit?.savedWords ?? 0)
  // "this visit got to the end of a chapter", latched from the WebView's
  // progress messages. A condition of the one-shot "bring your own book" ask —
  // see latchChapterEnd for why it is latched rather than sampled on exit.
  const finishedChapterRef = useRef(visit?.finishedChapter ?? false)

  // --- ADR-012 S4b: Original-layout PDF viewer state ------------------------
  // The Bearer token is fetched once and injected into pdf.js httpHeaders via
  // the viewer HTML. On a mid-read Range 401 the WebView posts `pdfAuthExpired`
  // → we refresh (shared single-flight) and rebuild the source (nonce bump)
  // restoring the current page — no visible banner (mobile UX).
  const [pdfToken, setPdfToken] = useState<string | null>(null)
  const [pdfTokenReady, setPdfTokenReady] = useState(false)
  const [pdfReloadNonce, setPdfReloadNonce] = useState(0)
  const currentPdfPageRef = useRef<number | null>(null)
  const pdfInitialPageRef = useRef<number | null>(originalInitialPage ?? null)
  // Safe-area padding + theme colours for whichever document is open (reflow or
  // PDF). A REF, not a memo dependency: these change while the document is open
  // (the status bar hides with the bars, the reader switches theme) and letting
  // them rebuild the template reloads the WebView (PDF: at page 1). Latched to
  // the largest insets seen, then pushed to the live DOM by the effect below.
  // See readerChrome.ts / pdfViewerChrome.ts.
  const chromeRef = useRef<ReaderChrome | null>(null)
  const appliedChromeRef = useRef<ReaderChrome | null>(null)
  const readerAppliedTypographyRef = useRef<ReaderTypography | null>(null)
  // The reflow document has loaded and can take injections. Reset by every rebuild (the html memo).
  const docLoadedRef = useRef(false)
  // S4c — top-visible page + page count for the PDF chrome + page-bookmark
  // state. Kept in React state (not just the ref) so the chrome + bookmark icon
  // re-render as the user scrolls.
  const [pdfCurrentPage, setPdfCurrentPage] = useState(originalInitialPage ?? 1)
  const [pdfNumPages, setPdfNumPages] = useState(0)
  // S4c — corrupt / unreadable PDF surfaced by the viewer (pdfLoadError).
  const [pdfError, setPdfError] = useState(false)
  const pdfReadyRef = useRef(false)
  // Replaces `pdfInitialJumpDoneRef`, a boolean that was set before the jump was
  // even computed and never reset — see pdfPersistGate.ts.
  const pdfGateRef = useRef<PdfGateState>(PDF_GATE_INITIAL)
  const pdfJumpIdRef = useRef(0)
  // Page the initial resolution sent the viewer to — "has the reader moved since?".
  const pdfResumedPageRef = useRef<number | null>(null)
  // True while the document being opened is a RELOAD of one already in progress
  // (the silent 401 recovery). The bootstrap carries the tracked page, so the
  // resume logic must not run again and pull the reader back to the chapter start.
  const pdfIsReloadRef = useRef(false)

  /** A downloaded original is read off the disk: no Bearer, no Range stream, no
   *  silent-401 recovery. Everything below branches on this one fact. */
  const isLocalOriginal = !!originalFileUrl && originalFileUrl.startsWith('file://')

  useEffect(() => {
    if (!original) return
    if (isLocalOriginal) {
      // Nothing to wait for. Without this the viewer would sit on the blank
      // placeholder until a token arrived for a request it never makes —
      // offline, that means until the refresh times out.
      setPdfToken(null)
      setPdfTokenReady(true)
      return
    }
    let cancelled = false
    getAccessToken().then(tok => {
      if (cancelled) return
      setPdfToken(tok)
      setPdfTokenReady(true)
    })
    return () => { cancelled = true }
  }, [original, isLocalOriginal])

  const topBarHeight = 56 + insets.top
  // Measured, not assumed. This was `60 + insets.bottom`, but the footer grows a
  // second line whenever "12 min left" renders, so the hide translation fell
  // short of the real height and left the bar's top edge — a hairline border
  // plus an Android elevation shadow — drawn across the last line of text. QA
  // reported it as a stripe through the paragraph.
  const [measuredFooterHeight, setMeasuredFooterHeight] = useState(0)
  const footerHeight = measuredFooterHeight || 60 + insets.bottom

  // Reading session — keyed by whichever catalog id the source carries. One per visit, not per
  // chapter (carried across the remount). Its percent is BOOK progress, so its word count is the
  // book's: wordsRead = Δbook% × words.
  const {
    updateProgress: updateSessionProgress, recordActivity: recordSessionActivity, handOff: handOffSession, sessionStartedAt,
  } = useReadingSession({
    editionId: source.kind === 'edition' ? source.id : null,
    userBookId: source.kind === 'userbook' ? source.id : null,
    wordCount: totalWordCountRef.current || wordCount,
    isAuthenticated,
    carried: visit?.session,
  })
  // M8: the session counts reading, not the restore. Until this chapter's position has settled,
  // a report is the load event's chapter top or the restore travelling — fed to the session, it
  // became the start percent and the jump to the saved place was counted as words read.
  // Set by the WebView's own `restored` ack (its message order puts it before the restore
  // scroll's report), or by the persistence gate when there was nothing to restore.
  const sessionSettledRef = useRef(false)
  useEffect(() => {
    if (!positionSettled || sessionSettledRef.current) return
    sessionSettledRef.current = true
    if (!original && bookProgressRef.current != null) updateSessionProgress(bookProgressRef.current)
  }, [positionSettled, original, bookProgressRef, updateSessionProgress])

  const { barsVisible, barsAnim, topBarTranslateY, footerTranslateY, showBars, hideBars, toggleBars } = useReaderBars({
    topBarHeight,
    footerHeight,
    autoHideTrigger: true,
  })
  // RN owns bar visibility; tell the WebView's scroll detector (both reflow and
  // PDF viewer embed it) so a tap toggle or the initial auto-hide doesn't leave
  // it measuring from a stale direction.
  useEffect(() => {
    injectJs(`window.__tsSetBars && window.__tsSetBars(${barsVisible})`)
  }, [barsVisible, injectJs])

  // "Discuss this chapter" — the open chapter, which is the one on screen (one chapter per document).
  // Same rules as the chapter-row button.
  const discussCh = chapters.find(c => c.slug === chapterSlug)
  const discussBrief = source.id && discussCh && isReviewableChapter(discussCh)
    ? () => buildChapterDiscussBrief({
        title: bookTitle ?? '',
        ...(source.kind === 'edition' ? { editionId: source.id!, slug: source.slug } : { bookId: source.id! }),
        chapterSlug: discussCh.slug, chapterTitle: discussCh.title,
      })
    : null
  const launcher = useAssistantLauncher({ eager: false })

  const {
    sessionWordCount,
    setSessionWordCount,
    prompt: exitPrompt,
    pendingPrompt,
    exit: handleExit,
    exitToReview: handleExitReview,
    exitToUpload: handleExitUpload,
    exitLater: handleExitLater,
    holdExit,
  } = useReaderExitSummary({
    router,
    saveProgress,
    sourceKind: source.kind,
    finishedChapterRef,
    initialWordCount: visit?.savedWords,
  })
  // Progress first: the server refuses a review of a chapter beyond the saved position, and the
  // debounced save may not have gone out yet at the end of the chapter (chapterEnd.ts).
  const discuss = () => {
    if (!discussBrief) return
    holdExit()
    void discussAfterSave(saveProgress, () => launcher.launch(discussBrief))
  }

  const { vocabMapRef, flushToCache: flushVocabMap, bumpVocab } = useReaderVocabMap({
    user,
    isAuthenticated,
    chapterId: chapter.id,
    injectJs,
    bookLanguage: textLanguage,
    nativeLanguage,
  })

  const {
    selection,
    setSelection,
    wordSaved,
    lookupState,
    setLookupState,
    setWordSaved,
    openSelection,
  } = useReaderSelection({ flushVocabMap })

  const {
    highlightsRef,
    editingHighlight,
    setEditingHighlight,
    create: createHighlight,
    createPdf: createPdfHighlight,
    repaintPdf,
    saveNote: saveHighlightNote,
    updateColor: updateHighlightColor,
    remove: removeHighlight,
  } = useReaderHighlights({
    ...(source.kind === 'edition'
      ? { editionId: source.id, editionIdRef: source.idRef }
      : { userBookId: source.id, userBookIdRef: source.idRef }),
    user,
    isAuthenticated,
    chapterId: chapter.id,
    injectJs,
    showToast,
    original,
  })

  // Original PDF: the color the user picked in the toolbar, held while the
  // bundled viewer resolves the anchor for the current selection and posts
  // `pdfHighlightCreate` back. Read by the message handler at persist time.
  const pendingPdfColorRef = useRef<string>(settings.lastHighlightColor)

  const isGuest = capabilitiesFor(user).isGuest
  const notifyWordSaved = useCallback(() => {
    sessionWordCountRef.current += 1
    const count = sessionWordCountRef.current
    haptics.play('complete')
    const savedToast = () => showToast({
      variant: 'success',
      message:
        count > 1
          ? interpolate(t(language, 'reader.toastWordAddedCount'), { count })
          : t(language, 'reader.toastWordAdded'),
      actionLabel: t(language, 'reader.toastTapToReview'),
      onPress: () => router.push('/vocabulary'),
      duration: 2400,
    })
    if (!isGuest) { savedToast(); return }
    // A guest's 3rd and 10th word: the "keep them" nudge replaces the saved
    // toast, once each per install (`guestNudge.ts`). The count is the reader's
    // whole vocabulary — `vocabMapRef` is loaded from `getReaderVocab()` (every
    // saved word) and `onWordSaved` has already added this one — not the
    // session's. Login opens as a modal over the reader; `then: 'back'` makes it
    // dismiss back here instead of landing on Library.
    void claimGuestNudge(true, Object.keys(vocabMapRef.current).length).then(nudge => {
      if (!nudge) { savedToast(); return }
      showToast({
        variant: 'success',
        message: t(language, nudge === 'ten' ? 'guest.nudgeTen' : 'guest.nudgeThree'),
        actionLabel: t(language, 'guest.nudgeCta'),
        onPress: () => router.push({ pathname: '/(auth)/login', params: { mode: 'register', then: 'back' } }),
        duration: 6000,
      })
    })
  }, [haptics, showToast, language, router, isGuest, vocabMapRef])

  const vocabActions = useReaderVocabActions({
    vocabMapRef,
    bookTitleRef,
    ...(source.kind === 'edition' ? { editionIdRef: source.idRef } : { userBookIdRef: source.idRef }),
    chapter: { id: chapter.id } as unknown as Chapter,
    language,
    textLanguage,
    nativeLanguage,
    isAuthenticated,
    injectJs,
    bumpVocab,
    notifyWordSaved,
    setSessionWordCount,
    setWordSaved,
    setSelection,
    setLookupState,
    showToast,
  })

  // The word toolbar's close — its X button and Android back (M3).
  const closeSelection = useCallback(() => {
    injectJs('try{window.getSelection&&window.getSelection().removeAllRanges()}catch(e){};try{window.__tsClearWordMark&&window.__tsClearWordMark()}catch(e){}')
    setSelection(null)
  }, [injectJs, setSelection])

  // Inbound bridge to the pdf.js viewer — TOC jumps, page-input jumps, and the
  // server-resume initial jump all route through `window.scrollToPage(n)`.
  //
  // It is also the ONLY place a jump is issued, which is what lets the persist
  // gate know that pages reported between here and the landing are the viewer
  // travelling, not the reader reading. Every caller — resume, table of contents,
  // page input, bookmarks, highlights — goes through it, so none of them can
  // forget to arm the gate.
  const scrollPdfToPage = useCallback((page: number) => {
    const target = Math.max(1, Math.floor(page))
    const jumpId = ++pdfJumpIdRef.current
    pdfGateRef.current = pdfGateReduce(pdfGateRef.current, {
      type: 'jumpIssued', page: target, jumpId, at: Date.now(),
    }).state
    injectJs(`window.scrollToPage && window.scrollToPage(${target}, ${jumpId})`)
  }, [injectJs])

  // Initial page resolution for the Original PDF.
  //
  // The chapter start page is applied by the viewer bootstrap (`initialPage`),
  // so this handles the SERVER resume page — once the doc is ready AND the
  // resume fetch has resolved.
  //
  // "Chapter always wins" used to be the rule, and it made resuming a PDF
  // impossible: the detail screen had no chapter slug to route by (a PDF's
  // position is a page locator), so it always opened chapter one, whose start
  // page is 1, which then discarded the saved page. The rule is now narrower —
  // a saved page INSIDE the chapter being opened wins. That separates the two
  // ways a reader arrives without needing a flag: picking chapter 7 from the
  // table of contents opens chapter 7, while Continue routes to the chapter
  // holding the saved page and lands on the page itself.
  const maybeInitialPdfJump = useCallback(() => {
    if (!original || !pdfReadyRef.current || pdfGateRef.current.phase !== 'awaitingTarget') return
    if (pdfIsReloadRef.current) {
      // A reload already opens at the tracked page via the bootstrap. Re-running
      // the resume resolution here would send the reader back to the chapter
      // start, which is the opposite of recovering their position.
      pdfIsReloadRef.current = false
      pdfGateRef.current = pdfGateReduce(pdfGateRef.current, { type: 'noJumpNeeded' }).state
      return
    }
    // Waits for the device's page even when the chapter's start page is known (R4 bug 2) — a local
    // read, never the network. A saved page inside this chapter wins over its start.
    const idx = chapters.findIndex(c => c.slug === chapterSlug)
    const first = initialPdfJump({
      resumeReady: !!originalResumeReady,
      chapterStartPage: originalInitialPage,
      chapterEndPage: idx >= 0 ? chapterEndPage(chapters, idx) : null,
      // A newer server page that arrived before the jump is simply the target ('adopt').
      resumePage: originalNewerPage?.page ?? originalResumePage,
    })
    if (first.kind === 'wait') return
    pdfResumedPageRef.current = first.page
    // The gate is armed by `scrollPdfToPage` itself, AFTER the target is known —
    // the old code set its flag first and then computed the target, so the
    // viewer's page-1 report sailed through the guard meant to catch it.
    if (first.kind === 'jump') scrollPdfToPage(first.page)
    else pdfGateRef.current = pdfGateReduce(pdfGateRef.current, { type: 'noJumpNeeded' }).state
  }, [original, originalInitialPage, originalResumeReady, originalResumePage, originalNewerPage, scrollPdfToPage, chapters, chapterSlug])

  // A newer page from the server, after the document already opened at the
  // device's one. Same rule as the reflow reader (decideNewerPosition): not
  // moved since → go there; moved, or outside the chapter opened → ask once.
  const pdfNewerHandledRef = useRef<number | null>(null)
  // The page on screen when the app last came back to the foreground — the "moved since?" baseline
  // for an offer found by the return check (H3), like the reflow reader's.
  const pdfReturnPageRef = useRef<number | null>(null)
  useEffect(() => {
    let prev: string = AppState.currentState
    const sub = AppState.addEventListener('change', next => {
      if (returnedToForeground(prev, next)) pdfReturnPageRef.current = currentPdfPageRef.current
      prev = next
    })
    return () => sub.remove()
  }, [])
  useEffect(() => {
    if (!original || originalNewerPage == null || pdfNewerHandledRef.current === originalNewerPage.at) return
    // Not jumped yet: maybeInitialPdfJump picks it up as the target.
    if (pdfGateRef.current.phase === 'awaitingTarget') return
    pdfNewerHandledRef.current = originalNewerPage.at
    const page = originalNewerPage.page
    const idx = chapters.findIndex(c => c.slug === chapterSlug)
    const inChapter = resolvePdfResumePage({
      chapterStartPage: originalInitialPage,
      chapterEndPage: idx >= 0 ? chapterEndPage(chapters, idx) : null,
      resumePage: page,
    }) === page
    const action = decideNewerPosition({
      sameChapter: inChapter,
      restoreApplied: true,
      readerMoved: readerMovedSince(originalNewerPage.onReturn ? pdfReturnPageRef.current : pdfResumedPageRef.current, currentPdfPageRef.current, 0),
    })
    if (action === 'move') { scrollPdfToPage(page); return }
    pdfNewerToastRef.current = showToast({
      variant: 'info',
      icon: 'phone-portrait-outline',
      message: t(language, 'reader.newerElsewhere.message')
        .replace('{target}', t(language, 'reader.newerElsewhere.page').replace('{page}', String(page))),
      actionLabel: t(language, 'reader.newerElsewhere.action'),
      onPress: () => scrollPdfToPage(page),
      duration: 8000,
    })
  }, [original, originalNewerPage, originalInitialPage, chapters, chapterSlug, scrollPdfToPage, showToast, language])

  // L4: the refresh behind a mid-read Range 401 can fail too (offline, captive portal, a session
  // that is gone). That was silent — the pages past the loaded ones just stayed blank. Now the
  // reader is told, with a Retry that runs the same recovery again.
  const pdfAuthToastRef = useRef<number | null>(null)
  useEffect(() => () => hideToast(pdfAuthToastRef.current), [hideToast])
  const recoverPdfAuthRef = useRef<() => void>(() => {})
  recoverPdfAuthRef.current = () => {
    onUnauthorized().then(tok => {
      if (tok) {
        setPdfToken(tok)
        setPdfReloadNonce(n => n + 1)
        return
      }
      if (!aliveRef.current) return
      pdfAuthToastRef.current = showToast({
        variant: 'info',
        icon: 'cloud-offline-outline',
        message: t(language, 'reader.pdfReconnect'),
        actionLabel: t(language, 'common.retry'),
        onPress: () => recoverPdfAuthRef.current(),
        duration: 8000,
      })
    })
  }

  // Run the deferred initial jump once the async server resume page arrives
  // after the viewer was already ready.
  useEffect(() => { maybeInitialPdfJump() }, [maybeInitialPdfJump])

  // Android's hardware back pops this screen without ever calling `exit()` —
  // the chevron in the top bar is the only thing wired to it. That is why the
  // one-shot "bring your own book" ask claims the press: on the primary
  // platform it would otherwise almost never be seen. The word toolbar (not a
  // Modal) is closed first (M3); otherwise `shouldInterceptReaderBack` refuses
  // whenever a sheet is open or a card is already up, so a second press always leaves.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const action = readerBackAction({
        selectionOpen: !!selection,
        promptVisible: exitPrompt !== null,
        otherOverlayOpen:
          settingsOpen || bookmarksOpen || highlightsOpen || translateOpen
          || explainOpen || tocOpen || pdfError
          || !!selection || !!editingHighlight,
        prompt: pendingPrompt(),
      })
      if (action === 'close-selection') { closeSelection(); return true }
      if (action === 'leave') return false
      handleExit()
      return true
    })
    return () => sub.remove()
  }, [
    exitPrompt, pendingPrompt, handleExit, settingsOpen, bookmarksOpen, highlightsOpen,
    translateOpen, explainOpen, tocOpen, pdfError, selection, editingHighlight, closeSelection,
  ])

  const handleMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data)
      if (data.type === 'log') {
        if (__DEV__) {
          const fn = data.level === 'error' ? console.error : data.level === 'warn' ? console.warn : console.log
          fn('[WV]', data.msg)
        }
        return
      }
      if (data.type === 'tap') {
        toggleBars()
      } else if (data.type === 'scrollDir') {
        // Original PDF has no word-based 'progress' message, so genuine scroll
        // is the session's activity signal (time-only — never a page percent).
        if (original) recordSessionActivity()
        if (data.dir === 'up') showBars()
        else if (data.dir === 'down') hideBars()
      } else if (data.type === 'progress') {
        progressRef.current = data.progress
        if (typeof data.scrollY === 'number') scrollOffsetRef.current = data.scrollY
        // Null when the reading line had no text under it — a margin, a gap
        // between paragraphs, an image. Keep the previous one rather than
        // blanking a good position for a scroll that passed over a picture;
        // saveProgress checks the chapter before it uses it.
        if (data.position) positionRef.current = data.position
        setProgress(data.progress)
        if (data.chapterSlug) currentChapterSlugRef.current = data.chapterSlug
        finishedChapterRef.current = latchChapterEnd(finishedChapterRef.current, data.progress)
        const bp = updateBookProgress(chapterSlug || null, data.progress)
        // The reading session wants BOOK progress. `ReadingSession.EndPercent >= 0.99`
        // is how the server decides a book was finished, so a chapter fraction here —
        // which is 1.0 at the end of every chapter — minted a book-completion per
        // chapter. Until the chapter list lands there is no book progress, and the
        // session is only told the reader is active.
        // A programmatic restore in flight is travel; the report after it lands is a jump whose
        // distance is not reading (newer position elsewhere, rebuild, reflow). The WebView reports
        // every landing right after its ack, so this is always the landing, never the next scroll.
        const jump = sessionJumpRef.current
        if (bp != null && sessionSettledRef.current && jump !== 'pending') {
          if (jump === 'landed') sessionJumpRef.current = 'idle'
          updateSessionProgress(bp, { jump: jump === 'landed' })
        } else recordSessionActivity()
        bumpProgress()
      } else if (data.type === 'restored') {
        // A restore we injected has actually been applied. Until this arrives the newest position
        // we hold is the load event's zero, and writing it wipes the reader's place — so this
        // message, not the injection, is what opens the write gate.
        sessionSettledRef.current = true
        onRestoreLanded(data.restoreId, data.scrollY)
      } else if (data.type === 'chapterEnd') {
        onChapterEndActionRef.current(data.action)
      } else if (data.type === 'highlightTap') {
        const hl = highlightsRef.current.find(h => h.id === data.highlightId)
        if (hl) setEditingHighlight(hl)
      } else if (data.type === 'wordEngage') {
        // Word resolved via deliberate long-press (Item A). Light selection
        // impact confirms the hold registered before the WordCard opens.
        haptics.play('flip')
      } else if (data.type === 'selection') {
        // No speech here. A single-word selection used to auto-speak, but the
        // message carrying it arrives from the 450ms long-press — which is also
        // the first frame of a drag that is on its way to selecting a sentence.
        // The word started playing under a gesture that had not finished saying
        // what it wanted, and then owned the player the toolbar's Listen button
        // needed. Speech is now only ever started by pressing a button.
        const mode: 'tap' | 'drag' = data.mode === 'tap' ? 'tap' : 'drag'
        openSelection(data.text ? { ...data, mode } : null)
      } else if (data.type === 'pdfHighlightCreate') {
        // Original PDF: the viewer resolved a quad-rect anchor for the current
        // selection. Persist it (chapterless userbook highlight) with the color
        // the user picked in the toolbar; the hook re-pushes the set to repaint.
        const anchor = data.anchor
        if (anchor && Array.isArray(anchor.rects) && anchor.rects.length > 0) {
          void createPdfHighlight({ color: pendingPdfColorRef.current, anchor, selectedText: anchor.exact || '' })
        }
      } else if (data.type === 'pdfReady') {
        // Document opened — record page count, clear any prior error, and run
        // the deferred server-resume initial jump if the fetch already resolved.
        if (typeof data.numPages === 'number') setPdfNumPages(data.numPages)
        pdfReadyRef.current = true
        setPdfError(false)
        // Close the persist gate for this document. Without it, a reload (bar
        // toggle, token refresh) left the gate from the PREVIOUS document open,
        // and the fresh document's page-1 report was saved as the position.
        pdfGateRef.current = pdfGateReduce(pdfGateRef.current, { type: 'documentLoaded' }).state
        maybeInitialPdfJump()
        // Viewer is up — (re)push any highlights loaded before it was ready.
        repaintPdf()
      } else if (data.type === 'pdfPage') {
        // Top-visible page (throttled). Track it (auth-expired reload restore +
        // chrome + page-bookmark state), persist page-based progress (debounced,
        // NOT word-based), and keep the reading session alive on time.
        if (typeof data.page === 'number') {
          currentPdfPageRef.current = data.page
          setPdfCurrentPage(data.page)
          recordSessionActivity()
          if (typeof data.numPages === 'number') {
            setPdfNumPages(data.numPages)
            // Provenance, not ordering: only pages the reader chose to be on are
            // saved. See pdfPersistGate.ts for why a monotonic guard would be the
            // wrong shape here.
            const decision = pdfGateReduce(pdfGateRef.current, {
              type: 'pageReported', page: data.page, ackJumpId: data.jumpId, at: Date.now(),
            })
            pdfGateRef.current = decision.state
            if (decision.persist) persistPdfPage?.(data.page, data.numPages)
          }
        }
      } else if (data.type === 'pdfAuthExpired') {
        // Silent recovery: remember the page, refresh the token (shared
        // single-flight), then rebuild the viewer source with the fresh token.
        pdfInitialPageRef.current = currentPdfPageRef.current ?? pdfInitialPageRef.current
        pdfIsReloadRef.current = true
        recoverPdfAuthRef.current()
      } else if (data.type === 'pdfLoadError') {
        // Corrupt / unreadable PDF (NOT the 401 reload path). Surface the reader
        // error state → "open as text" (if reflow chapters exist) or hard error.
        if (__DEV__) console.warn('[reader] pdf load error:', data.message)
        setPdfError(true)
      }
    } catch (err) {
      if (__DEV__) console.warn('[reader] postMessage handler threw', err, event?.nativeEvent?.data)
    }
  }, [chapters, chapterSlug, toggleBars, showBars, hideBars,
      setEditingHighlight, updateSessionProgress, onRestoreLanded, openSelection, bumpProgress, haptics,
      original, recordSessionActivity, maybeInitialPdfJump, persistPdfPage, createPdfHighlight, repaintPdf])

  // "12 min left in chapter" — the estimate Kindle readers reach for, using the
  // per-user pace the server already derives from real sessions. Rendered only
  // when the book carries word counts; a fabricated number is worse than none.
  // Reflow only: the PDF path has pages, not words.
  const timeLeftLabel = (() => {
    if (original || !settings.showReaderStats) return null
    const est = estimateTimeLeft(chapters, chapterSlug, progress, wpm)
    if (!est) return null
    return formatMinutesLeft(est.chapterMinutes, {
      under: t(language, 'reader.timeLeft.under'),
      minutes: t(language, 'reader.timeLeft.minutes'),
      hours: t(language, 'reader.timeLeft.hours'),
      hoursMinutes: t(language, 'reader.timeLeft.hoursMinutes'),
    })
  })()

  // Every chapter change in the reader goes through here (block, chevrons, TOC, bookmarks,
  // highlights). The route change remounts this screen, so the visit is handed to the next one.
  const navigateChapter = (slug: string) => {
    saveProgress()
    const { snapshot, flush } = handOffSession()
    carryVisit({
      key: visitKey,
      session: snapshot,
      savedWords: Math.max(sessionWordCount, sessionWordCountRef.current),
      finishedChapter: finishedChapterRef.current,
    }, flush)
    onNavigateChapter(slug)
  }
  chapterNavigatorRef.current = navigateChapter
  useEffect(() => () => { chapterNavigatorRef.current = null }, [chapterNavigatorRef])

  // --- End of chapter (inline block, drawn by readerHtml's __tsSetChapterEnd) ---
  const [endState, setEndState] = useState({ busy: false, error: false })
  const lastEndTargetRef = useRef<string | null>(null)
  // A slow fetch can outlive the screen (the reader backs out while it hangs); navigating from a
  // reader that is gone would replace whatever screen they went to.
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])
  const openFromBlock = async (slug: string) => {
    lastEndTargetRef.current = slug
    setEndState({ busy: true, error: false })
    try {
      await ensureChapter(slug)
    } catch {
      // Offline and not on the device: say so in the block, with Retry — not a dead-end screen.
      if (aliveRef.current) setEndState({ busy: false, error: true })
      return
    }
    if (aliveRef.current) navigateChapter(slug)
  }
  // Chevrons, TOC, bookmarks, highlights (M9). A tap never waits on a network: online, or with the
  // chapter in SQLite, it navigates at once (the next mount's loader is device-first, then network).
  // Only offline AND not on the device does it stay put, with a toast — navigating there meant an
  // error screen whose "Go back" left the book. `openingRef` makes a double tap navigate once; it is
  // never reset after a navigation, because the route change remounts this screen.
  const online = useOnline()
  const openingRef = useRef(false)
  const openChapter = async (slug: string) => {
    if (openingRef.current) return
    openingRef.current = true
    if (online || await isChapterOnDevice(slug).catch(() => false)) {
      if (aliveRef.current) navigateChapter(slug)
      return
    }
    openingRef.current = false
    if (aliveRef.current) showToast({ variant: 'info', icon: 'cloud-offline-outline', message: t(language, 'reader.chapterEnd.unavailable'), bottomOffset: footerHeight })
  }
  const endLabels = useMemo<ChapterEndLabels>(() => ({
    next: t(language, 'reader.chapterEnd.next'),
    nextUntitled: t(language, 'reader.chapterEnd.nextUntitled'),
    prevUntitled: t(language, 'reader.chapterEnd.prevUntitled'),
    finished: t(language, 'reader.chapterEnd.finished'),
    finishedGeneric: t(language, 'reader.chapterEnd.finishedGeneric'),
    discuss: t(language, 'chapterReview.discussChapter'),
    reviewWords: n => plural(n, 'word', 'words', t(language, 'reader.chapterEnd.reviewWords')),
    library: t(language, 'reader.chapterEnd.library'),
    unavailable: t(language, 'reader.chapterEnd.unavailable'),
    retry: t(language, 'common.retry'),
  }), [language])
  const endModel = useMemo(() => chapterEndModel({
    chapters,
    chapterTitle: chapter.title,
    prev: chapter.prev ?? null,
    next: chapter.next ?? null,
    bookTitle,
    canDiscuss: !!discussBrief,
    savedWords: sessionWordCount,
    error: endState.error,
    busy: endState.busy,
  }, endLabels), [chapters, chapter.title, chapter.prev, chapter.next, bookTitle, discussBrief, sessionWordCount, endState, endLabels])
  const endModelJs = `window.__tsSetChapterEnd && window.__tsSetChapterEnd(${JSON.stringify(endModel)})`
  useEffect(() => { if (!original) injectJs(endModelJs) }, [original, endModelJs, injectJs])
  // Read through a ref by handleMessage, whose dependency list would otherwise have to name it all.
  const onChapterEndActionRef = useRef<(action: string) => void>(() => {})
  onChapterEndActionRef.current = (action: string) => {
    if (action === 'visible') {
      // Fetch the next chapter onto the device while they read the block: Next is then instant,
      // and works if the signal drops in between.
      if (chapter.next) void ensureChapter(chapter.next.slug).catch(() => {})
    } else if (action === 'next' && chapter.next) void openFromBlock(chapter.next.slug)
    else if (action === 'prev' && chapter.prev) void openFromBlock(chapter.prev.slug)
    else if (action === 'retry' && lastEndTargetRef.current) void openFromBlock(lastEndTargetRef.current)
    else if (action === 'discuss') discuss()
    else if (action === 'review') { saveProgress(); handleExitReview() }
    else if (action === 'library') { saveProgress(); router.dismissTo('/(tabs)/library') }
  }


  // M2: scroll the reflow WebView to a saved highlight (no chapter navigation →
  // reading position preserved). The Highlights sheet's list is always the
  // current chapter, so the anchor resolves in the live DOM.
  const scrollToHighlight = (anchorJson: string) =>
    injectJs(`window.__textstackScrollToHighlight && window.__textstackScrollToHighlight(${JSON.stringify(anchorJson)})`)

  // Which chapter the reader is in: the open one for reflow (one chapter per document); for the
  // Original PDF layout, the chapter holding the current page.
  const activeSlug = (original ? chapterSlugForPage(chapters, pdfCurrentPage) : null) ?? chapterSlug
  const activeChapter = chapters.find(c => c.slug === activeSlug)
  // Original PDF: the "current" bookmark is the top-visible PAGE, not a chapter.
  const isCurrentBookmarked = original
    ? (isPageBookmarked?.(pdfCurrentPage) ?? false)
    : bookmarks.some(b => bookmarkChapterSlug(b) === activeSlug)

  // TOC selection: original mode scrolls the PDF to the chapter's start page
  // instead of routing to a chapter (mirrors web ReaderPage onChapterSelect).
  const handleTocSelect = (slug: string) => {
    if (original) {
      const ch = chapters.find(c => c.slug === slug)
      scrollPdfToPage(ch?.sourceStartPage ?? 1)
      return
    }
    void openChapter(slug)
  }

  // Bookmark toggle target differs by mode: current PDF page vs active chapter.
  const toggleCurrentBookmark = () => {
    if (original) onTogglePageBookmark?.(pdfCurrentPage)
    else onToggleCurrentBookmark(activeSlug)
  }
  const isMultiWord = !!(selection && selection.mode === 'drag' && selection.text.includes(' '))
  const currentChapterIndex = chapters.findIndex(c => c.slug === activeSlug)
  const totalChapters = chapters.length

  // Save is now on screen for guests too (SelectionActionBar), so this handler owns
  // the answer for them — and the answer stays in the book. No action, no router:
  // the toast says what happened and dismisses.
  //
  // It used to carry a "Sign in" CTA that pushed `/(auth)/login`, and that was the
  // worse of the two bugs the dead button had. `ToastContext` makes the WHOLE toast
  // pressable (`onPress={current.onPress ?? hide}`), so a guest who merely swatted
  // the toast away was ejected too; and sign-in ends in `router.replace('/(tabs)/library')`
  // (deliberate, see the comment block in `app/(auth)/login.tsx`), which tears the
  // reader stack down — the guest did not come back to their page, they landed on
  // the Library tab. Nothing here may take a reader out of their book.
  //
  // The word itself is not rescued: web queues it (`useReaderVocabulary`'s pending
  // list) and mobile has no such store, so the copy admits the word was not kept
  // rather than promising otherwise. Deliberately no pending queue and no sheet on
  // top of this — the next PR mints guest sessions, a guest saves for real, and this
  // whole branch goes away.
  //
  // `bottomOffset: footerHeight` clears the reader footer. `notifyWordSaved` above
  // passes no offset and so takes the provider's tab-bar-sized default; these two
  // toasts do NOT have the same shape, and this one is not trying to.
  //
  // Decided by `saveWordIntent` rather than inline, so the rule is covered by the
  // only test lane this app has; the `!isAuthenticated` early return still inside
  // useReaderVocabActions stays as defence in depth.
  const handleSaveWord = () => {
    const intent = saveWordIntent({ isAuthenticated, hasSelection: !!selection })
    if (intent === 'prompt') {
      haptics.play('flip')
      showToast({
        variant: 'info',
        message: t(language, 'reader.vocab.saveNeedsAccount'),
        // Longer than the success toasts: it is two clauses, and a reader who is
        // mid-sentence is not looking straight at it.
        duration: 3600,
        bottomOffset: footerHeight,
      })
      return
    }
    if (intent === 'ignore') return
    return vocabActions.saveWord(selection!)
  }
  const handleMarkKnown = () => selection ? vocabActions.markKnown(selection) : undefined
  const handleRemoveWord = () => selection ? vocabActions.removeWord(selection) : undefined

  const handleHighlight = useCallback(async (color: string) => {
    if (!selection) return
    if (color === 'yellow' || color === 'green' || color === 'pink' || color === 'blue') {
      updateSettings({ lastHighlightColor: color })
    }
    // Original PDF: RN can't reach the WebView's DOM Range, so the bundled
    // viewer resolves the quad-rect anchor from the live selection and posts
    // `pdfHighlightCreate` back (mirrors web computePdfAnchorFromRange at commit
    // time). Stash the color; the message handler persists with it.
    if (original) {
      pendingPdfColorRef.current = color
      injectJs('window.__pdfCreateHighlight && window.__pdfCreateHighlight()')
      setSelection(null)
      return
    }
    await createHighlight({ color, selection, chapter: { id: chapter.id } })
    setSelection(null)
  }, [selection, chapter.id, createHighlight, updateSettings, original, injectJs])

  // Sync inline translations setting to the WebView — was missing on the
  // user-book reader, so the gloss never showed there (now shared). Skipped in
  // the PDF viewer (no reflow vocab layer to toggle — S5 paints over the PDF).
  useEffect(() => {
    if (original) return
    injectJs(`setShowInlineTranslations(${settings.showInlineTranslations})`)
  }, [settings.showInlineTranslations, injectJs, original])

  // Recompute book-wide progress once chapters/wordCount land — early
  // 'progress' messages fire before the chapter list resolves.
  useEffect(() => {
    if (chapters.length === 0) return
    updateBookProgress(currentChapterSlugRef.current || chapterSlug || null, progressRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters, chapterSlug])

  // M6: the OS killed the WebView's renderer (memory pressure, a long PDF). The view is dead —
  // Android needs a NEW one, not a reload — so it is remounted under a new key, at the saved
  // place: the reflow document through the rebuild restore (text anchor, rebuildRestore.ts), the
  // PDF through the same tracked-page bootstrap the silent 401 recovery uses.
  const [webViewKey, setWebViewKey] = useState(0)
  const onRendererGone = useCallback(() => {
    if (original) {
      pdfInitialPageRef.current = currentPdfPageRef.current ?? pdfInitialPageRef.current
      pdfIsReloadRef.current = true
      pdfReadyRef.current = false
    } else {
      onDocumentRebuild()
    }
    setWebViewKey(k => k + 1)
  }, [original, onDocumentRebuild])

  const documentKey = readerDocumentKey({
    chapterSlug: htmlChapterSlug ?? '',
    fontFaceKey: fontFaceKey(resolvedFontFamily),
    htmlLength: chapter.html.length,
  })

  const html = useMemo(
    () => {
      // Chrome and typography are read from refs, deliberately outside the
      // dependency list — see readerChrome.ts for what a rebuild costs here.
      const chrome = chromeRef.current ?? {
        safeArea: { top: insets.top, bottom: insets.bottom },
        backgroundColor: resolvedTheme.backgroundColor,
        textColor: resolvedTheme.textColor,
      }
      chromeRef.current = chrome
      appliedChromeRef.current = chrome  // a fresh document already has it
      const typography = {
        fontFamily: resolvedFontFamily,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        textAlign: settings.textAlign,
      }
      readerAppliedTypographyRef.current = typography
      docLoadedRef.current = false  // a new document; onLoadEnd says when it can take injections
      return buildReaderHtml(chapter.html, {
        fontSize: typography.fontSize,
        lineHeight: typography.lineHeight,
        fontFamily: typography.fontFamily,
        textAlign: typography.textAlign,
        backgroundColor: chrome.backgroundColor,
        textColor: chrome.textColor,
      }, htmlChapterSlug, chrome.safeArea)
    },
    // Keyed on document identity ONLY. Insets, colours and typography are absent
    // on purpose; readerChrome.test.ts asserts that absence. A remount after a dead
    // renderer (M6) IS a new document, built with today's typography.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentKey, webViewKey],
  )

  // A rebuild is starting. Told to the persistence hook BEFORE the new document
  // loads, because the fresh document's load event overwrites the one fact that
  // decides what to do about it: which chapter the reader was actually in.
  const lastDocumentKeyRef = useRef(documentKey)
  useEffect(() => {
    if (lastDocumentKeyRef.current === documentKey) return
    lastDocumentKeyRef.current = documentKey
    onDocumentRebuild()
  }, [documentKey, onDocumentRebuild])

  // Typography changes reach the OPEN document instead of rebuilding it. The
  // injection measures, restyles and re-anchors as one operation and acks the
  // restoreId, so the write gate is shut across the reflow.
  //
  // Only into a LOADED document: settings arrive from AsyncStorage while the
  // first one is still loading, and an injection then finds no script to run
  // and is lost — the reader kept the default size for the whole visit. So
  // onLoadEnd applies whatever changed in the meantime (R4).
  const applyTypography = useCallback(() => {
    if (original || !docLoadedRef.current) return
    const next = {
      fontFamily: resolvedFontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      textAlign: settings.textAlign,
    }
    if (!readerTypographyChanged(readerAppliedTypographyRef.current, next)) return
    readerAppliedTypographyRef.current = next
    reflow(id => readerTypographyInjectionJs(next, id))
  }, [original, resolvedFontFamily, settings.fontSize, settings.lineHeight, settings.textAlign, reflow])
  useEffect(() => { applyTypography() }, [applyTypography])

  // ADR-012 S4b — the Original-layout PDF document. Rebuilt when the token
  // refreshes (nonce) so a silent 401 recovery reloads at the tracked page.
  const pdfHtml = useMemo(() => {
    if (!original || !originalFileUrl) return ''
    // Chrome is read from the ref, deliberately outside the dependency list.
    const chrome = chromeRef.current ?? {
      safeArea: { top: insets.top, bottom: insets.bottom },
      backgroundColor: resolvedTheme.backgroundColor,
      textColor: resolvedTheme.textColor,
    }
    chromeRef.current = chrome
    appliedChromeRef.current = chrome  // a fresh document already has it
    // Same-origin, both ways. Streaming: an absolute API URL with `baseUrl` set
    // to the API origin. Local: the bare filename with `baseUrl` set to the
    // file's own directory — a `file://` document may read a sibling file, but
    // not one reached from an http(s) base, and the alternative
    // (allowUniversalAccessFromFileURLs) opens the whole disk to the page.
    const documentUrl = isLocalOriginal
      ? originalFileUrl.slice(originalFileUrl.lastIndexOf('/') + 1)
      : originalFileUrl
    return buildPdfViewerHtml(documentUrl, pdfToken, {
      theme: {
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        fontFamily: resolvedFontFamily,
        textAlign: settings.textAlign,
        backgroundColor: chrome.backgroundColor,
        textColor: chrome.textColor,
      },
      initialPage: pdfInitialPageRef.current ?? originalInitialPage ?? null,
      safeArea: chrome.safeArea,
    })
    // Keyed on document identity ONLY. Insets and theme are absent on purpose —
    // that absence is the fix, and pdfViewerChrome.test.ts asserts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, pdfDocumentKey({
    fileUrl: originalFileUrl ?? '',
    token: pdfToken,
    nonce: pdfReloadNonce + webViewKey,
    initialPage: pdfInitialPageRef.current ?? originalInitialPage ?? null,
  })])

  // baseUrl = API origin so pdf.js lazy Range requests are same-origin (the
  // Bearer travels in httpHeaders, no CORS preflight). Reflow uses inline html.
  const webViewSource = useMemo(() => {
    if (original) {
      if (!pdfTokenReady) {
        return { html: `<!DOCTYPE html><html><body style="background:${resolvedTheme.backgroundColor};margin:0"></body></html>` }
      }
      return {
        html: pdfHtml,
        baseUrl: isLocalOriginal
          ? originalFileUrl.slice(0, originalFileUrl.lastIndexOf('/') + 1)
          : API_URL,
      }
    }
    return { html }
    // `resolvedTheme.backgroundColor` only paints the pre-token placeholder, and
    // is intentionally NOT a dependency: once the token is ready this object must
    // change only when `pdfHtml` does, or a theme switch reloads the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, pdfTokenReady, pdfHtml, html, isLocalOriginal, originalFileUrl])

  // Chrome changes reach the OPEN document instead of rebuilding it. This is the
  // other half of the fix: the memo above stopped depending on insets and theme,
  // so something still has to apply them when they change mid-read — the status
  // bar hiding with the bars, or the reader switching to dark mode.
  useEffect(() => {
    const next = latchReaderChrome(chromeRef.current, {
      safeArea: { top: insets.top, bottom: insets.bottom },
      backgroundColor: resolvedTheme.backgroundColor,
      textColor: resolvedTheme.textColor,
    })
    chromeRef.current = next
    if (!readerChromeChanged(appliedChromeRef.current, next)) return
    appliedChromeRef.current = next
    injectJs(original ? pdfChromeInjectionJs(next) : readerChromeInjectionJs(next))
  }, [original, insets.top, insets.bottom, resolvedTheme.backgroundColor, resolvedTheme.textColor, injectJs])

  const barBg = resolvedTheme.backgroundColor
  const barText = resolvedTheme.textColor

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar hidden={!barsVisible} style={settings.theme === 'dark' ? 'light' : 'dark'} />
      <View style={[styles.container, { backgroundColor: barBg }]}>
        <WebView
          key={webViewKey}
          ref={webViewRef}
          onRenderProcessGone={onRendererGone}
          onContentProcessDidTerminate={onRendererGone}
          source={webViewSource}
          style={[styles.webview, { backgroundColor: resolvedTheme.backgroundColor }]}
          onMessage={handleMessage}
          onLoadEnd={() => {
            // PDF viewer: reflow injections (vocab marks / inline-translation
            // toggle / scroll-restore) don't apply — the pdf.js controller owns
            // render + initial page. Persistent highlights DO paint over the
            // PDF text layer: re-push the set now that the (possibly reloaded)
            // document is up. pdfReady also re-pushes once pdf.js opens the doc.
            if (original) { repaintPdf(); return }
            for (const h of highlightsRef.current) {
              injectJs(`renderHighlight(${JSON.stringify(h.id)}, ${JSON.stringify(h.anchorJson)}, ${JSON.stringify(h.color)}, ${JSON.stringify(h.selectedText)})`)
            }
            if (Object.keys(vocabMapRef.current).length > 0) {
              injectJs(`markVocabWords(${JSON.stringify(vocabMapRef.current)})`)
            }
            injectJs(`setShowInlineTranslations(${settings.showInlineTranslations})`)
            injectJs(endModelJs)
            // Scroll-restore is owned by useReaderPersistence — it coordinates
            // this signal with the async saved-position fetch (no race).
            onWebViewLoaded()
            // Typography that changed while this document loaded. After the restore is asked,
            // so the reflow knows a restore is in flight and re-asks its target (rule 8).
            docLoadedRef.current = true
            applyTypography()
          }}
          originWhitelist={['*']}
          // Android denies a WebView any file access by default, and denies a
          // file:// document XHR to a sibling file even when it can load one.
          // pdf.js needs both to open a downloaded book.
          //
          // These are WebView-wide, not per-document: they apply to the reflow
          // reader in this same component, which renders user-supplied EPUB and
          // clip HTML. What keeps that safe is the base URL, not these flags —
          // the reflow document is mounted with no baseUrl, so it has no file
          // origin to read from, and giving it one later would hand user
          // content the app's own files. Still narrower than
          // allowUniversalAccessFromFileURLs, which grants a file page every
          // origin including http(s).
          allowFileAccess
          allowFileAccessFromFileURLs
          // Android's WebView ignores the viewport's user-scalable unless the
          // built-in zoom is enabled; the on-screen +/- controls are suppressed
          // so only the pinch gesture is exposed. PDF only — see the viewport
          // comment in buildPdfViewerHtml.
          setBuiltInZoomControls={original}
          setDisplayZoomControls={false}
          scrollEnabled
          showsVerticalScrollIndicator={false}
          androidLayerType="hardware"
          overScrollMode="never"
          bounces={false}
          menuItems={[]}
          cacheEnabled={false}
          onShouldStartLoadWithRequest={(req) => {
            const { url, navigationType } = req
            if (url === 'about:blank' || url.startsWith('data:') || url.startsWith('file:')) return true
            // PDF viewer: permit the same-origin base document load (baseUrl =
            // API origin) so pdf.js can stream lazy Range requests. Not a click.
            if (original && navigationType !== 'click' && url.startsWith(API_URL)) return true
            if (navigationType === 'click' && (url.startsWith('http://') || url.startsWith('https://'))) {
              Linking.openURL(url).catch(() => {})
              return false
            }
            return false
          }}
        />

        <ReaderTopBar
          barBg={barBg}
          barText={barText}
          barsAnim={barsAnim}
          topBarTranslateY={topBarTranslateY}
          barsVisible={barsVisible}
          topInset={insets.top}
          bookTitle={bookTitle ?? ''}
          chapterTitle={activeChapter?.title ?? chapter.title}
          sessionWordCount={sessionWordCount}
          isAuthenticated={isAuthenticated}
          hasChapters={chapters.length > 0}
          isCurrentBookmarked={isCurrentBookmarked}
          onExit={handleExit}
          onBookmarksPress={() => setBookmarksOpen(true)}
          onHighlightsPress={() => setHighlightsOpen(true)}
          onTocPress={() => setTocOpen(true)}
          onSettingsPress={() => setSettingsOpen(true)}
        />

        {selection && (
          <SelectionActionBar
            selectedText={selection.text}
            isMultiWord={isMultiWord}
            language={textLanguage}
            onTranslate={() => setTranslateOpen(true)}
            onExplain={() => setExplainOpen(true)}
            onSpeak={() => toggleTts(selection.text, { rate: settings.ttsSpeed, lang: textLanguage })}
            onSaveWord={handleSaveWord}
            onHighlight={handleHighlight}
            highlightColor={settings.lastHighlightColor}
            onMarkKnown={handleMarkKnown}
            onRemove={handleRemoveWord}
            tooLong={selection.tooLong}
            isSpeaking={isSpeaking}
            isTtsLoading={isTtsLoading}
            wordSaved={wordSaved}
            vocabStage={vocabMapRef.current[selection.text.toLowerCase()]?.stage ?? null}
            isAuthenticated={isAuthenticated}
            bottomOffset={footerHeight}
            onClose={closeSelection}
            lookup={lookupState}
            onAddAnyway={lookupState ? () => { void vocabActions.addAnyway(lookupState) } : undefined}
          />
        )}

        {original ? (
          <PdfReaderChrome
            barBg={barBg}
            barText={barText}
            borderColor={barText + '15'}
            barsAnim={barsAnim}
            footerTranslateY={footerTranslateY}
            barsVisible={barsVisible}
            bottomInset={insets.bottom}
            currentPage={pdfCurrentPage}
            numPages={pdfNumPages}
            onJumpToPage={scrollPdfToPage}
          />
        ) : (
        <Animated.View
          onLayout={e => {
            const h = Math.round(e.nativeEvent.layout.height)
            if (h > 0 && h !== measuredFooterHeight) setMeasuredFooterHeight(h)
          }}
          style={[
            styles.footer,
            {
              backgroundColor: barBg,
              borderTopColor: barText + '15',
              paddingBottom: insets.bottom,
              opacity: barsAnim,
              transform: [{ translateY: footerTranslateY }],
              // Android draws elevation from the native outline provider, which
              // does not follow an animated opacity — so the shadow survived the
              // fade and sat on the text as a dark line. Drop it while hidden.
              elevation: barsVisible ? 2 : 0,
              borderTopWidth: barsVisible ? StyleSheet.hairlineWidth : 0,
            },
          ]}
          pointerEvents={barsVisible ? 'auto' : 'none'}
        >
          <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
            <View style={[styles.progressFill, { width: `${bookProgress != null ? Math.round(bookProgress * 100) : 0}%`, backgroundColor: barText + '40' }]} />
          </View>
          <View style={styles.footerRow}>
            <TouchableOpacity
              onPress={() => chapter.prev && void openChapter(chapter.prev.slug)}
              disabled={!chapter.prev}
              style={styles.chevronBtn}
              accessibilityLabel="Previous chapter"
              accessibilityRole="button"
            >
              <Text style={[styles.chevron, { color: barText + (chapter.prev ? 'CC' : '40') }]}>‹</Text>
            </TouchableOpacity>

            <View style={styles.footerInfo}>
              <Text style={[styles.footerChapter, { color: barText }]} numberOfLines={1}>
                {activeChapter?.title ?? chapter.title ?? ''}
              </Text>
              <View style={styles.footerMeta}>
                {totalChapters > 1 && currentChapterIndex >= 0 && (
                  <Text style={[styles.footerCounter, { color: barText + '99' }]}>
                    {currentChapterIndex + 1} / {totalChapters}
                  </Text>
                )}
                <Text style={[styles.footerPercent, { color: barText + '99' }]}>
                  {bookProgress != null ? `${Math.round(bookProgress * 100)}%` : '—'}
                </Text>
              </View>
              {timeLeftLabel ? (
                <Text style={[styles.footerTimeLeft, { color: barText + '99' }]} numberOfLines={1}>
                  {timeLeftLabel}
                </Text>
              ) : null}
            </View>

            <TouchableOpacity
              onPress={() => chapter.next && void openChapter(chapter.next.slug)}
              disabled={!chapter.next}
              style={styles.chevronBtn}
              accessibilityLabel="Next chapter"
              accessibilityRole="button"
            >
              <Text style={[styles.chevron, { color: barText + (chapter.next ? 'CC' : '40') }]}>›</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
        )}

        <ReaderTapCoachmark />

        {settings.showReaderStats && isAuthenticated && quickStats && barsVisible && (
          <ReaderStatsWidget
            sessionStartedAt={sessionStartedAt}
            todaySeconds={quickStats.todaySeconds}
            dailyGoalMinutes={quickStats.dailyGoalMinutes}
          />
        )}

        <ReaderSettingsDrawer
          visible={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onUpdate={updateSettings}
        />

        <BookmarksSheet
          visible={bookmarksOpen}
          onClose={() => setBookmarksOpen(false)}
          bookmarks={bookmarks}
          currentChapterSlug={activeSlug || ''}
          onNavigate={slug => void openChapter(slug)}
          onNavigatePage={scrollPdfToPage}
          onDelete={onDeleteBookmark}
          onToggleCurrent={toggleCurrentBookmark}
          isCurrentBookmarked={isCurrentBookmarked}
          original={original}
        />

        <HighlightsSheet
          visible={highlightsOpen}
          onClose={() => setHighlightsOpen(false)}
          highlights={highlightsRef.current}
          currentChapterSlug={activeSlug || ''}
          onNavigate={slug => void openChapter(slug)}
          onScrollToHighlight={scrollToHighlight}
          onNavigatePage={scrollPdfToPage}
        />

        <TranslationSheet
          visible={translateOpen}
          text={selection?.text || ''}
          onClose={() => setTranslateOpen(false)}
          onSpeak={(txt) => toggleTts(txt, { rate: settings.ttsSpeed, lang: textLanguage })}
          fromLang={textLanguage}
        />

        <ExplanationSheet
          visible={explainOpen}
          word={selection?.text || ''}
          sentence={selection?.sentence || selection?.text || ''}
          bookId={explainBookId}
          fromLang={textLanguage}
          onClose={() => setExplainOpen(false)}
        />

        <TocSheet
          visible={tocOpen}
          chapters={chapters.map(c => ({ slug: c.slug, title: c.title, chapterNumber: c.chapterNumber }))}
          currentChapterSlug={activeSlug || ''}
          bookmarks={bookmarks.map(b => ({ chapterSlug: bookmarkChapterSlug(b), title: b.title || undefined }))}
          onNavigate={handleTocSelect}
          onClose={() => setTocOpen(false)}
          loading={chaptersLoading}
        />

        <HighlightNoteModal
          visible={!!editingHighlight}
          snippet={editingHighlight
            ? editingHighlight.selectedText.substring(0, 120) + (editingHighlight.selectedText.length > 120 ? '…' : '')
            : ''}
          initialNote={editingHighlight?.noteText || ''}
          initialColor={(editingHighlight?.color ?? settings.lastHighlightColor) as 'yellow' | 'green' | 'pink' | 'blue'}
          onCancel={() => setEditingHighlight(null)}
          onSave={async (note) => {
            const hl = editingHighlight
            setEditingHighlight(null)
            if (hl) await saveHighlightNote(hl.id, note)
          }}
          onColorChange={async (color) => {
            const hl = editingHighlight
            if (!hl) return
            updateSettings({ lastHighlightColor: color })
            await updateHighlightColor(hl.id, color)
          }}
          onDelete={async () => {
            const hl = editingHighlight
            setEditingHighlight(null)
            if (hl) await removeHighlight(hl.id)
          }}
        />

        {original && pdfError && (
          <View style={[styles.pdfErrorOverlay, { backgroundColor: resolvedTheme.backgroundColor, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            <Ionicons name="alert-circle-outline" size={48} color={barText + '99'} />
            <Text style={[styles.pdfErrorTitle, { color: barText }]}>Couldn't open this PDF</Text>
            <Text style={[styles.pdfErrorBody, { color: barText + '99' }]}>
              {onForceReflow
                ? 'The original file could not be displayed. You can read the extracted text version instead.'
                : 'The original file could not be displayed, and there is no text version to fall back to.'}
            </Text>
            <TouchableOpacity
              style={[styles.pdfErrorBtn, { backgroundColor: colors.primary }]}
              onPress={() => { if (onForceReflow) { setPdfError(false); onForceReflow() } else { handleExit() } }}
              accessibilityRole="button"
              accessibilityLabel={onForceReflow ? 'Read as text' : 'Go back'}
            >
              <Text style={styles.pdfErrorBtnText}>{onForceReflow ? 'Read as text' : 'Go back'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* "Discuss this chapter" lives in the end-of-chapter block; the words card below keeps a
            link to it when the chapter was finished. */}
        <ConnectAssistantSheet visible={launcher.connect} onClose={launcher.closeConnect} />

        {exitPrompt === 'review-words' && (
          <ExitCard
            bg={barBg} fg={barText}
            title={plural(sessionWordCount, 'word', 'words', '{n} {noun} saved')}
            primary={{ label: t(language, 'reader.exitSummary.reviewNow'), onPress: handleExitReview }}
            secondary={{ label: t(language, 'reader.exitSummary.later'), onPress: handleExitLater }}
            footer={finishedChapterRef.current && discussBrief ? (
              <TouchableOpacity onPress={discuss} disabled={launcher.busy} accessibilityRole="button" hitSlop={8}>
                <Text style={[styles.exitSummaryBtnText, { color: colors.primary }]}>✦ {t(language, 'chapterReview.discussChapter')}</Text>
              </TouchableOpacity>
            ) : null}
          />
        )}

        {/* The ask, once per install: they have just finished a chapter and saved
            words in it, so the mechanic has proved itself and the product's real
            proposition — read the books you already care about — is finally
            something they can judge. Not gated on `canUpload` here on purpose:
            the upload screen owns that policy and states it in its own words. */}
        {exitPrompt === 'own-book' && (
          <ExitCard
            bg={barBg} fg={barText} stacked
            title={plural(sessionWordCount, 'word', 'words', '{n} {noun} saved')}
            primary={{ label: t(language, 'reader.ownBookAsk.cta'), onPress: handleExitUpload }}
            secondary={{ label: t(language, 'reader.ownBookAsk.dismiss'), onPress: handleExitLater }}
          >
            <Text style={[styles.askTitle, { color: barText }]}>{t(language, 'reader.ownBookAsk.title')}</Text>
            <Text style={[styles.askBody, { color: barText + 'B3' }]}>{t(language, 'reader.ownBookAsk.body')}</Text>
          </ExitCard>
        )}
      </View>
    </>
  )
}

interface ExitAction { label: string; onPress: () => void; disabled?: boolean }

/** The exit prompts' shared card. Follows the READER theme (bg/fg), not the app
 *  theme — it sits over the page just read, and a white card over a dark chapter
 *  is a flashbang. `stacked`: sentence-length labels, full-width buttons, since a
 *  row squeezes them on a narrow phone. */
function ExitCard({ bg, fg, title, titleLines, stacked, primary, secondary, children, footer }: {
  bg: string
  fg: string
  title: string
  titleLines?: number
  stacked?: boolean
  primary: ExitAction
  secondary: ExitAction
  children?: ReactNode
  footer?: ReactNode
}) {
  const { colors } = useTheme()
  const button = (a: ExitAction, fill: string, color: string) => (
    <TouchableOpacity
      style={[styles.exitSummaryBtn, stacked && styles.askBtn, { backgroundColor: fill }]}
      onPress={a.onPress}
      disabled={a.disabled}
      accessibilityRole="button"
    >
      <Text style={[styles.exitSummaryBtnText, stacked && styles.askBtnText, { color }]}>{a.label}</Text>
    </TouchableOpacity>
  )
  return (
    <View style={styles.exitSummaryOverlay}>
      <View style={[styles.exitSummaryCard, stacked && styles.askCard, { backgroundColor: bg }]}>
        <Ionicons name="checkmark-circle" size={40} color={colors.success} />
        <Text style={[styles.exitSummaryText, { color: fg, textAlign: 'center' }]} numberOfLines={titleLines}>{title}</Text>
        {children}
        <View style={stacked ? styles.askButtons : styles.exitSummaryButtons}>
          {button(primary, colors.primary, '#fff')}
          {button(secondary, fg + '15', fg)}
        </View>
        {footer}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    // borderTopWidth and elevation are applied inline — both have to disappear
    // when the bar hides, and neither follows an animated opacity on Android.
  },
  footerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 4, minHeight: 48 },
  chevronBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  chevron: { fontSize: 28, fontFamily: fonts.sans, lineHeight: 28 },
  footerInfo: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  footerChapter: { fontSize: 13, fontFamily: fonts.sansMedium, fontWeight: '500' as const, textAlign: 'center' },
  footerMeta: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 },
  footerCounter: { fontSize: 11, fontFamily: fonts.sans, fontVariant: ['tabular-nums'] },
  footerTimeLeft: { fontFamily: fonts.sans, fontSize: 11, marginTop: 2 },
  footerPercent: { fontSize: 11, fontFamily: fonts.sans, fontVariant: ['tabular-nums'] },
  progressBar: { height: 4, borderRadius: 0 },
  progressFill: { height: 4, borderRadius: 0 },
  pdfErrorOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 150,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  pdfErrorTitle: { fontFamily: fonts.serifBold, fontSize: 20, marginTop: 12, textAlign: 'center' },
  pdfErrorBody: { fontFamily: fonts.sans, fontSize: 14, textAlign: 'center', maxWidth: 320, lineHeight: 20 },
  pdfErrorBtn: { marginTop: 16, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 20 },
  pdfErrorBtnText: { fontFamily: fonts.sansMedium, fontSize: 15, color: '#fff' },
  exitSummaryOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 200,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  exitSummaryCard: {
    borderRadius: 16,
    paddingHorizontal: 32,
    paddingVertical: 24,
    alignItems: 'center',
    gap: 8,
  },
  exitSummaryText: {
    fontFamily: fonts.sansMedium,
    fontSize: 18,
  },
  exitSummaryButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  exitSummaryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  // The summary card sizes to its content; the ask has two sentences in it and
  // would otherwise run edge to edge.
  askCard: { maxWidth: 340, marginHorizontal: 24 },
  askTitle: { fontFamily: fonts.sansMedium, fontSize: 17, textAlign: 'center', marginTop: 4 },
  askBody: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  askButtons: { alignSelf: 'stretch', gap: 8, marginTop: 12 },
  askBtn: { alignItems: 'center' },
  askBtnText: { fontSize: 15 },
  exitSummaryBtnText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
})
