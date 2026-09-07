import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Animated, Linking, BackHandler } from 'react-native'
import { WebView } from 'react-native-webview'
import { useRouter, Stack } from 'expo-router'
import { t, computeBookProgress, estimateTimeLeft, formatMinutesLeft, citationChapterSlug, makeSnippet, plural, resolvePdfResumePage, chapterEndPage } from '@textstack/shared'
import type { Chapter, BookmarkDto, AskCitation, AskTarget } from '@textstack/shared'
import { buildReaderHtml, buildPdfViewerHtml } from '../../lib/readerHtml'
import {
  pdfDocumentKey, pdfChromeInjectionJs, latchPdfChrome, pdfChromeChanged, type PdfChrome,
} from '../../lib/pdfViewerChrome'
import {
  readerDocumentKey, readerChromeInjectionJs, latchReaderChrome, readerChromeChanged, type ReaderChrome,
} from '../../lib/readerChrome'
import { pdfGateReduce, PDF_GATE_INITIAL, chapterSlugForPage, type PdfGateState } from '@textstack/shared'
import { getAccessToken, onUnauthorized, API_URL } from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { useReaderSettings } from '../../hooks/useReaderSettings'
import { useReaderBars } from '../../hooks/useReaderBars'
import { useKeepReaderAwake } from '../../hooks/useKeepReaderAwake'
import { useReadingPace } from '../../hooks/useReadingPace'
import { useReaderExitSummary } from '../../hooks/useReaderExitSummary'
import { useReaderHighlights } from '../../hooks/useReaderHighlights'
import { useReaderVocabMap } from '../../hooks/useReaderVocabMap'
import { useReaderVocabActions } from '../../hooks/useReaderVocabActions'
import { useReaderSelection } from '../../hooks/useReaderSelection'
import { useReaderOverlayV2Active } from '../../hooks/useReaderOverlayV2Active'
import { useReadingSession } from '../../hooks/useReadingSession'
import { useTts } from '../../hooks/useTts'
import { useQuickStats } from '../../hooks/useQuickStats'
import { useHaptics } from '../../hooks/useHaptics'
import { useToast } from '../../context/ToastContext'
import { saveWordIntent } from '../../lib/saveWordIntent'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useNativeLanguage } from '../../context/NativeLanguageContext'
import { ReaderSettingsDrawer } from '../ReaderSettingsDrawer'
import { BookmarksSheet } from '../BookmarksSheet'
import { HighlightsSheet } from '../HighlightsSheet'
import { SelectionActionBar } from '../SelectionActionBar'
import { TranslationSheet } from '../TranslationSheet'
import { ExplanationSheet } from '../ExplanationSheet'
import { AskSheet, type AskPrefill } from '../AskSheet'
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
import { capabilitiesFor } from '../../lib/capabilities'
import { latchChapterEnd, shouldInterceptReaderBack } from '../../lib/firstRun'

/** Lightweight {key} interpolation — shared `t()` returns raw keys, we fill them in here. */
function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
}

/** Which catalog the book belongs to. Drives the FK column used by highlights,
 *  vocab and reading-session — the ONLY thing that genuinely differs between the
 *  public-library reader and the user-uploaded-book reader. */
export type ReaderSource =
  | { kind: 'edition'; id: string | null; idRef: MutableRefObject<string | null> }
  | { kind: 'userbook'; id: string | null; idRef: MutableRefObject<string | null> }

/** A loaded chapter, normalised across both data sources. */
export interface ReaderShellChapter {
  id: string
  title: string
  html: string
  prev?: { slug: string } | null
  next?: { slug: string } | null
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
  chapters: { slug: string; title: string; chapterNumber?: number; wordCount?: number | null; sourceStartPage?: number | null }[]
  chaptersLoading: boolean

  // Progress/session machinery — refs created by the route (its progress + session
  // hooks read them); mutated here from the WebView 'progress' message.
  progressRef: MutableRefObject<number>
  scrollOffsetRef: MutableRefObject<number>
  currentChapterSlugRef: MutableRefObject<string | null>
  bookProgressRef: MutableRefObject<number | null>
  totalWordCountRef: MutableRefObject<number>
  bumpProgress: () => void
  saveProgress: () => void

  /** Signalled once the WebView finishes loading. The shared persistence
   *  layer gates scroll-restore on this + the async saved-position fetch, so
   *  restore can't race the load (the "always returns to top" bug). */
  onWebViewLoaded: () => void

  /** The WebView acknowledged a restore, carrying back the id it was issued with. */
  onRestoreLanded: (restoreId: number) => void

  // Infinite scroll — the per-source fetch lives in the route; these fire on the
  // WebView 'loaded' / 'requestNextChapter' messages.
  onChapterLoaded: () => void
  onRequestNextChapter: () => void

  /** Perform the actual router.replace to a chapter slug (path differs per source). */
  onNavigateChapter: (slug: string) => void

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
  /** "Ask this book" target — catalog edition OR user-uploaded book (AI-027 P2).
   *  Drives the Ask button visibility and which endpoint family the sheet hits. */
  askTarget?: AskTarget

  /** ADR-012 S4b — render the ORIGINAL PDF (pdf.js viewer) instead of the reflow
   *  HTML. Same shell, one branch: the WebView source swaps and the reflow-only
   *  scroll/progress/infinite-scroll message branches go inert. */
  original?: boolean
  /** Range-enabled URL of the original PDF (Bearer injected into pdf.js, not the URL). */
  originalFileUrl?: string | null
  /** 1-based page to open the PDF at (chapter start page). Wins over the server
   *  resume page. Null → use the server resume page, else page 1. */
  originalInitialPage?: number | null
  /** Server-persisted resume page (parsed from the `page:<N>` locator). Used
   *  when the chapter carries no page. (ADR-012 S4c) */
  originalResumePage?: number | null
  /** False while the server resume page is still loading — the initial jump waits
   *  on this (ignored when `originalInitialPage` is set). */
  originalResumeReady?: boolean
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
 * chapter list, bookmarks, progress, reading session, infinite scroll) and hand the
 * results + a `source` discriminator down here. This is the single place the reader
 * UX lives, so a fix lands in both catalogs at once (was: copy-pasted + drifted).
 */
export function ReaderShell(props: ReaderShellProps) {
  const {
    source, webViewRef, injectJs, chapter, chapterSlug, htmlChapterSlug,
    bookTitle, chapters, chaptersLoading,
    progressRef, scrollOffsetRef, currentChapterSlugRef, bookProgressRef, totalWordCountRef,
    bumpProgress, saveProgress,
    onWebViewLoaded, onRestoreLanded,
    onChapterLoaded, onRequestNextChapter, onNavigateChapter,
    bookmarks, onToggleCurrentBookmark, onDeleteBookmark, bookmarkChapterSlug,
    bookTitleRef, wordCount, explainBookId, askTarget,
    original, originalFileUrl, originalInitialPage,
    originalResumePage, originalResumeReady, persistPdfPage,
    onTogglePageBookmark, isPageBookmarked, onForceReflow,
  } = props

  const router = useRouter()
  const { isAuthenticated, user } = useAuth()
  const { settings, update: updateSettings, resolvedFontFamily, resolvedTheme } = useReaderSettings()
  const overlayV2 = useReaderOverlayV2Active()
  const { colors } = useTheme()
  const { language } = useLanguage()
  const { nativeLanguage } = useNativeLanguage()
  const { toggle: toggleTts, isSpeaking, isLoading: isTtsLoading } = useTts()
  const quickStats = useQuickStats(isAuthenticated)
  const haptics = useHaptics()
  const { show: showToast } = useToast()
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
  const [askOpen, setAskOpen] = useState(false)
  /** Passage attached to the Ask sheet via the selection toolbar's "Ask about this" action. */
  const [askPrefill, setAskPrefill] = useState<AskPrefill | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  const [progress, setProgress] = useState(0)
  const [bookProgress, setBookProgress] = useState<number | null>(null)
  const [visibleChapterSlug, setVisibleChapterSlug] = useState<string | null>(null)

  const sessionWordCountRef = useRef(0)
  // "this session got to the end of a chapter", latched from the WebView's
  // progress messages. A condition of the one-shot "bring your own book" ask —
  // see latchChapterEnd for why it is latched rather than sampled on exit.
  const finishedChapterRef = useRef(false)

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
  // Safe-area padding + theme colours for the PDF document. A REF, not a memo
  // dependency: these change while the document is open (the status bar hides
  // with the bars, the reader switches theme) and letting them rebuild the
  // template reloads the WebView at page 1. Latched to the largest insets seen,
  // then pushed to the live DOM by the effect below. See pdfViewerChrome.ts.
  const readerChromeRef = useRef<ReaderChrome | null>(null)
  const readerAppliedChromeRef = useRef<ReaderChrome | null>(null)
  const pdfChromeRef = useRef<PdfChrome | null>(null)
  const pdfAppliedChromeRef = useRef<PdfChrome | null>(null)
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
  // True while the document being opened is a RELOAD of one already in progress
  // (the silent 401 recovery). The bootstrap carries the tracked page, so the
  // resume logic must not run again and pull the reader back to the chapter start.
  const pdfIsReloadRef = useRef(false)

  useEffect(() => {
    if (!original) return
    let cancelled = false
    getAccessToken().then(tok => {
      if (cancelled) return
      setPdfToken(tok)
      setPdfTokenReady(true)
    })
    return () => { cancelled = true }
  }, [original])

  const topBarHeight = 56 + insets.top
  // Measured, not assumed. This was `60 + insets.bottom`, but the footer grows a
  // second line whenever "12 min left" renders, so the hide translation fell
  // short of the real height and left the bar's top edge — a hairline border
  // plus an Android elevation shadow — drawn across the last line of text. QA
  // reported it as a stripe through the paragraph.
  const [measuredFooterHeight, setMeasuredFooterHeight] = useState(0)
  const footerHeight = measuredFooterHeight || 60 + insets.bottom

  // Reading session — keyed by whichever catalog id the source carries.
  const { updateProgress: updateSessionProgress, recordActivity: recordSessionActivity, sessionStartedAt } = useReadingSession({
    editionId: source.kind === 'edition' ? source.id : null,
    userBookId: source.kind === 'userbook' ? source.id : null,
    wordCount,
    isAuthenticated,
  })

  const { barsVisible, barsAnim, topBarTranslateY, footerTranslateY, showBars, hideBars, toggleBars } = useReaderBars({
    topBarHeight,
    footerHeight,
    autoHideTrigger: true,
  })

  const {
    sessionWordCount,
    setSessionWordCount,
    prompt: exitPrompt,
    pendingPrompt,
    exit: handleExit,
    exitToReview: handleExitReview,
    exitToUpload: handleExitUpload,
    exitLater: handleExitLater,
  } = useReaderExitSummary({
    router,
    saveProgress,
    sourceKind: source.kind,
    finishedChapterRef,
  })

  const { vocabMapRef, flushToCache: flushVocabMap, bumpVocab } = useReaderVocabMap({
    user,
    isAuthenticated,
    chapterId: chapter.id,
    injectJs,
    bookLanguage: language,
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

  const notifyWordSaved = useCallback(() => {
    sessionWordCountRef.current += 1
    const count = sessionWordCountRef.current
    haptics.play('complete')
    showToast({
      variant: 'success',
      message:
        count > 1
          ? interpolate(t(language, 'reader.toastWordAddedCount'), { count })
          : t(language, 'reader.toastWordAdded'),
      actionLabel: t(language, 'reader.toastTapToReview'),
      onPress: () => router.push('/vocabulary'),
      duration: 2400,
    })
  }, [haptics, showToast, language, router])

  const vocabActions = useReaderVocabActions({
    vocabMapRef,
    bookTitleRef,
    ...(source.kind === 'edition' ? { editionIdRef: source.idRef } : { userBookIdRef: source.idRef }),
    chapter: { id: chapter.id } as unknown as Chapter,
    language,
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
    if (!originalResumeReady && originalInitialPage == null) return
    if (originalInitialPage != null && !originalResumeReady) {
      // The chapter's start page came from the bootstrap; the document already
      // opens where it should. Nothing to wait for, so saving can begin.
      pdfGateRef.current = pdfGateReduce(pdfGateRef.current, { type: 'noJumpNeeded' }).state
      return
    }
    const idx = chapters.findIndex(c => c.slug === chapterSlug)
    const target = resolvePdfResumePage({
      chapterStartPage: originalInitialPage,
      chapterEndPage: idx >= 0 ? chapterEndPage(chapters, idx) : null,
      resumePage: originalResumePage,
    })
    // The gate is armed by `scrollPdfToPage` itself, AFTER the target is known —
    // the old code set its flag first and then computed the target, so the
    // viewer's page-1 report sailed through the guard meant to catch it.
    if (target > 1 && target !== originalInitialPage) scrollPdfToPage(target)
    else pdfGateRef.current = pdfGateReduce(pdfGateRef.current, { type: 'noJumpNeeded' }).state
  }, [original, originalInitialPage, originalResumeReady, originalResumePage, scrollPdfToPage, chapters, chapterSlug])

  // Run the deferred initial jump once the async server resume page arrives
  // after the viewer was already ready.
  useEffect(() => { maybeInitialPdfJump() }, [maybeInitialPdfJump])

  // Android's hardware back pops this screen without ever calling `exit()` —
  // the chevron in the top bar is the only thing wired to it. That is why the
  // one-shot "bring your own book" ask claims the press: on the primary
  // platform it would otherwise almost never be seen. Nothing else is
  // intercepted, and `shouldInterceptReaderBack` refuses whenever a sheet is
  // open or a card is already up, so a second press always leaves.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const intercept = shouldInterceptReaderBack({
        promptVisible: exitPrompt !== null,
        otherOverlayOpen:
          settingsOpen || bookmarksOpen || highlightsOpen || translateOpen
          || explainOpen || askOpen || tocOpen || pdfError
          || !!selection || !!editingHighlight,
        prompt: pendingPrompt(),
      })
      if (!intercept) return false
      handleExit()
      return true
    })
    return () => sub.remove()
  }, [
    exitPrompt, pendingPrompt, handleExit, settingsOpen, bookmarksOpen, highlightsOpen,
    translateOpen, explainOpen, askOpen, tocOpen, pdfError, selection, editingHighlight,
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
        setProgress(data.progress)
        if (data.chapterSlug) {
          currentChapterSlugRef.current = data.chapterSlug
          setVisibleChapterSlug(data.chapterSlug)
        }
        finishedChapterRef.current = latchChapterEnd(finishedChapterRef.current, {
          chapterProgress: data.progress,
          visibleChapterSlug: data.chapterSlug ?? currentChapterSlugRef.current,
          openedChapterSlug: chapterSlug,
        })
        const activeSlugForCalc = data.chapterSlug || currentChapterSlugRef.current || chapterSlug || null
        const bp = computeBookProgress(chapters, activeSlugForCalc, data.progress, totalWordCountRef.current)
        bookProgressRef.current = bp
        setBookProgress(bp)
        // The reading session wants BOOK progress, and it must be computed
        // before we report it — this used to pass the chapter fraction from two
        // lines above. `ReadingSession.EndPercent >= 0.99` is how the server
        // decides a book was finished, so every chapter a mobile reader
        // completed minted a book-completion and unlocked reading achievements
        // early. `wordsRead` is derived from the same delta against the
        // whole-book word count, so it was inflated by the same mistake.
        updateSessionProgress(bp ?? data.progress)
        bumpProgress()
      } else if (data.type === 'restored') {
        // A restore we injected has actually been applied. Until this arrives the newest position
        // we hold is the load event's zero, and writing it wipes the reader's place — so this
        // message, not the injection, is what opens the write gate.
        onRestoreLanded(data.restoreId)
      } else if (data.type === 'loaded') {
        onChapterLoaded()
      } else if (data.type === 'requestNextChapter') {
        onRequestNextChapter()
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
        onUnauthorized().then(tok => {
          if (tok) {
            setPdfToken(tok)
            setPdfReloadNonce(n => n + 1)
          }
        })
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
      setEditingHighlight, updateSessionProgress, onChapterLoaded, onRequestNextChapter, onRestoreLanded, openSelection, bumpProgress, haptics,
      original, recordSessionActivity, maybeInitialPdfJump, persistPdfPage, createPdfHighlight, repaintPdf])

  // "12 min left in chapter" — the estimate Kindle readers reach for, using the
  // per-user pace the server already derives from real sessions. Rendered only
  // when the book carries word counts; a fabricated number is worse than none.
  // Reflow only: the PDF path has pages, not words.
  const timeLeftLabel = (() => {
    if (original || !settings.showReaderStats) return null
    const est = estimateTimeLeft(chapters, visibleChapterSlug || chapterSlug, progress, wpm)
    if (!est) return null
    return formatMinutesLeft(est.chapterMinutes, {
      under: t(language, 'reader.timeLeft.under'),
      minutes: t(language, 'reader.timeLeft.minutes'),
      hours: t(language, 'reader.timeLeft.hours'),
      hoursMinutes: t(language, 'reader.timeLeft.hoursMinutes'),
    })
  })()

  const navigateChapter = (slug: string) => {
    saveProgress()
    progressRef.current = 0
    scrollOffsetRef.current = 0
    setProgress(0)
    if (chapters.length > 0) {
      const bp = computeBookProgress(chapters, slug, 0, totalWordCountRef.current)
      bookProgressRef.current = bp
      setBookProgress(bp)
    }
    onNavigateChapter(slug)
  }

  // RAG citation (AI-026d): scroll the WebView to the cited passage.
  const pendingCitationRef = useRef<{ slug: string; snippet: string; charStart: number } | null>(null)
  const scrollToCitation = (snippet: string, charStart: number) =>
    injectJs(`window.__textstackScrollToCitation && window.__textstackScrollToCitation(${JSON.stringify(snippet)}, ${charStart})`)

  // M2: scroll the reflow WebView to a saved highlight (no chapter navigation →
  // reading position preserved). The Highlights sheet's list is always the
  // current chapter, so the anchor resolves in the live DOM.
  const scrollToHighlight = (anchorJson: string) =>
    injectJs(`window.__textstackScrollToHighlight && window.__textstackScrollToHighlight(${JSON.stringify(anchorJson)})`)

  // Which chapter the reader is actually in.
  //
  // `visibleChapterSlug` is only ever set from the reflow reader's `progress`
  // message, and the PDF path does not send one — so on the Original layout this
  // was frozen at the route's chapter for the whole session and the top bar still
  // read "Introduction" on page 17. Pages are what a PDF has, and the mapping
  // from page to chapter already existed, unused by the reader.
  const activeSlug = (original
    ? chapterSlugForPage(chapters, pdfCurrentPage)
    : visibleChapterSlug) ?? chapterSlug
  // Same chapter → scroll now; other chapter → navigate, then onLoadEnd injects once it renders.
  const handleCitation = (c: AskCitation) => {
    const slug = citationChapterSlug(chapters, c.chapterOrd)
    if (!slug) return
    const snippet = makeSnippet(c.preview)
    if (slug === activeSlug) {
      scrollToCitation(snippet, c.charStart)
    } else {
      pendingCitationRef.current = { slug, snippet, charStart: c.charStart }
      navigateChapter(slug)
    }
  }
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
    navigateChapter(slug)
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
    const slug = currentChapterSlugRef.current || chapterSlug || null
    const bp = computeBookProgress(chapters, slug, progressRef.current, totalWordCountRef.current)
    bookProgressRef.current = bp
    setBookProgress(bp)
  }, [chapters, chapterSlug])

  const html = useMemo(
    () => {
      // Chrome is read from the ref, deliberately outside the dependency list —
      // see readerChrome.ts for what a rebuild costs here.
      const chrome = readerChromeRef.current ?? {
        safeArea: { top: insets.top, bottom: insets.bottom },
        backgroundColor: resolvedTheme.backgroundColor,
        textColor: resolvedTheme.textColor,
      }
      readerChromeRef.current = chrome
      readerAppliedChromeRef.current = chrome  // a fresh document already has it
      return buildReaderHtml(chapter.html, {
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        fontFamily: resolvedFontFamily,
        textAlign: settings.textAlign,
        backgroundColor: chrome.backgroundColor,
        textColor: chrome.textColor,
      }, htmlChapterSlug, chrome.safeArea, { overlayV2 })
    },
    // Keyed on document identity ONLY. Insets and colours are absent on purpose;
    // readerChrome.test.ts asserts that absence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readerDocumentKey({
      chapterSlug: htmlChapterSlug ?? '',
      fontFamily: resolvedFontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      textAlign: settings.textAlign,
      overlayV2,
      htmlLength: chapter.html.length,
    })],
  )

  // ADR-012 S4b — the Original-layout PDF document. Rebuilt when the token
  // refreshes (nonce) so a silent 401 recovery reloads at the tracked page.
  const pdfHtml = useMemo(() => {
    if (!original || !originalFileUrl) return ''
    // Chrome is read from the ref, deliberately outside the dependency list.
    const chrome = pdfChromeRef.current ?? {
      safeArea: { top: insets.top, bottom: insets.bottom },
      backgroundColor: resolvedTheme.backgroundColor,
      textColor: resolvedTheme.textColor,
    }
    pdfChromeRef.current = chrome
    pdfAppliedChromeRef.current = chrome  // a fresh document already has it
    return buildPdfViewerHtml(originalFileUrl, pdfToken, {
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
    nonce: pdfReloadNonce,
    initialPage: pdfInitialPageRef.current ?? originalInitialPage ?? null,
  })])

  // baseUrl = API origin so pdf.js lazy Range requests are same-origin (the
  // Bearer travels in httpHeaders, no CORS preflight). Reflow uses inline html.
  const webViewSource = useMemo(() => {
    if (original) {
      if (!pdfTokenReady) {
        return { html: `<!DOCTYPE html><html><body style="background:${resolvedTheme.backgroundColor};margin:0"></body></html>` }
      }
      return { html: pdfHtml, baseUrl: API_URL }
    }
    return { html }
    // `resolvedTheme.backgroundColor` only paints the pre-token placeholder, and
    // is intentionally NOT a dependency: once the token is ready this object must
    // change only when `pdfHtml` does, or a theme switch reloads the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, pdfTokenReady, pdfHtml, html])

  // Chrome changes reach the OPEN document instead of rebuilding it. This is the
  // other half of the fix: the memo above stopped depending on insets and theme,
  // so something still has to apply them when they change mid-read — the status
  // bar hiding with the bars, or the reader switching to dark mode.
  // The reflow twin of the PDF chrome effect below.
  useEffect(() => {
    if (original) return
    const next = latchReaderChrome(readerChromeRef.current, {
      safeArea: { top: insets.top, bottom: insets.bottom },
      backgroundColor: resolvedTheme.backgroundColor,
      textColor: resolvedTheme.textColor,
    })
    readerChromeRef.current = next
    if (!readerChromeChanged(readerAppliedChromeRef.current, next)) return
    readerAppliedChromeRef.current = next
    injectJs(readerChromeInjectionJs(next))
  }, [original, insets.top, insets.bottom, resolvedTheme.backgroundColor, resolvedTheme.textColor, injectJs])

  useEffect(() => {
    if (!original) return
    const next = latchPdfChrome(pdfChromeRef.current, {
      safeArea: { top: insets.top, bottom: insets.bottom },
      backgroundColor: resolvedTheme.backgroundColor,
      textColor: resolvedTheme.textColor,
    })
    pdfChromeRef.current = next
    if (!pdfChromeChanged(pdfAppliedChromeRef.current, next)) return
    pdfAppliedChromeRef.current = next
    injectJs(pdfChromeInjectionJs(next))
  }, [original, insets.top, insets.bottom, resolvedTheme.backgroundColor, resolvedTheme.textColor, injectJs])

  const barBg = resolvedTheme.backgroundColor
  const barText = resolvedTheme.textColor

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar hidden={!barsVisible} style={settings.theme === 'dark' ? 'light' : 'dark'} />
      <View style={[styles.container, { backgroundColor: barBg }]}>
        <WebView
          ref={webViewRef}
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
            // Scroll-restore is owned by useReaderPersistence — it coordinates
            // this signal with the async saved-position fetch (no race).
            onWebViewLoaded()
            // A cross-chapter citation jump (AI-026d): once the cited chapter has rendered, scroll
            // to the passage — after restore (delay) so the explicit jump wins.
            const pc = pendingCitationRef.current
            if (pc && pc.slug === activeSlug) {
              pendingCitationRef.current = null
              setTimeout(() => scrollToCitation(pc.snippet, pc.charStart), 120)
            }
          }}
          originWhitelist={['*']}
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
          showAsk={!!askTarget}
          isCurrentBookmarked={isCurrentBookmarked}
          onExit={handleExit}
          onAskPress={() => setAskOpen(true)}
          onBookmarksPress={() => setBookmarksOpen(true)}
          onHighlightsPress={() => setHighlightsOpen(true)}
          onTocPress={() => setTocOpen(true)}
          onSettingsPress={() => setSettingsOpen(true)}
        />

        {selection && (
          <SelectionActionBar
            selectedText={selection.text}
            isMultiWord={isMultiWord}
            language={language}
            onTranslate={() => setTranslateOpen(true)}
            onExplain={() => setExplainOpen(true)}
            onSpeak={() => toggleTts(selection.text, { rate: settings.ttsSpeed, lang: language })}
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
            onAskAbout={askTarget && selection.text.trim() ? () => {
              setAskPrefill({ text: selection.text.trim(), nonce: Date.now() })
              setAskOpen(true)
              injectJs('try{window.getSelection&&window.getSelection().removeAllRanges()}catch(e){};try{window.__tsClearWordMark&&window.__tsClearWordMark()}catch(e){}')
              setSelection(null)
            } : undefined}
            onClose={() => {
              injectJs('try{window.getSelection&&window.getSelection().removeAllRanges()}catch(e){};try{window.__tsClearWordMark&&window.__tsClearWordMark()}catch(e){}')
              setSelection(null)
            }}
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
              onPress={() => chapter.prev && navigateChapter(chapter.prev.slug)}
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
              onPress={() => chapter.next && navigateChapter(chapter.next.slug)}
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
          onNavigate={navigateChapter}
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
          onNavigate={navigateChapter}
          onScrollToHighlight={scrollToHighlight}
          onNavigatePage={scrollPdfToPage}
        />

        <TranslationSheet
          visible={translateOpen}
          text={selection?.text || ''}
          onClose={() => setTranslateOpen(false)}
          onSpeak={(txt) => toggleTts(txt, { rate: settings.ttsSpeed, lang: language })}
          fromLang={language}
        />

        <ExplanationSheet
          visible={explainOpen}
          word={selection?.text || ''}
          sentence={selection?.sentence || selection?.text || ''}
          bookId={explainBookId}
          fromLang={language}
          onClose={() => setExplainOpen(false)}
        />

        {askTarget && (
          <AskSheet
            visible={askOpen}
            target={askTarget}
            currentChapterId={chapter.id}
            chapters={chapters}
            prefill={askPrefill}
            // Account predicate, not a session one: Ask calls paid inference and
            // every rate-limit bucket partitions on IP alone, so a guest reaching
            // it would be an unmetered path to the LLM. The other `isAuthenticated`
            // props in this file are session predicates and stay as they are — a
            // guest is a real row that syncs.
            canUseAi={capabilitiesFor(user).canUseAi}
            onCitation={handleCitation}
            onSignIn={() => { setAskOpen(false); router.push('/(auth)/login') }}
            onClose={() => { setAskOpen(false); setAskPrefill(null) }}
          />
        )}

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

        {exitPrompt === 'review-words' && (
          <View style={styles.exitSummaryOverlay}>
            {/* Follows the READER theme (barBg/barText), not the app theme — this
                card sits over the page the user was just reading, and a white card
                over a dark chapter is a flashbang. The "Later" button used to be
                white-on-white here: rgba(255,255,255,0.15) fill under #fff text. */}
            <View style={[styles.exitSummaryCard, { backgroundColor: barBg }]}>
              <Ionicons name="checkmark-circle" size={40} color={colors.success} />
              <Text style={[styles.exitSummaryText, { color: barText }]}>
                {plural(sessionWordCount, 'word', 'words', '{n} {noun} saved')}
              </Text>
              <View style={styles.exitSummaryButtons}>
                <TouchableOpacity
                  style={[styles.exitSummaryBtn, { backgroundColor: colors.primary }]}
                  onPress={handleExitReview}
                >
                  <Text style={[styles.exitSummaryBtnText, { color: '#fff' }]}>Review Now</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.exitSummaryBtn, { backgroundColor: barText + '15' }]}
                  onPress={handleExitLater}
                >
                  <Text style={[styles.exitSummaryBtnText, { color: barText }]}>Later</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* The ask, once per install: they have just finished a chapter and saved
            words in it, so the mechanic has proved itself and the product's real
            proposition — read the books you already care about — is finally
            something they can judge. Not gated on `canUpload` here on purpose:
            the upload screen owns that policy and states it in its own words. */}
        {exitPrompt === 'own-book' && (
          <View style={styles.exitSummaryOverlay}>
            <View style={[styles.exitSummaryCard, styles.askCard, { backgroundColor: barBg }]}>
              <Ionicons name="checkmark-circle" size={40} color={colors.success} />
              <Text style={[styles.exitSummaryText, { color: barText }]}>
                {plural(sessionWordCount, 'word', 'words', '{n} {noun} saved')}
              </Text>
              <Text style={[styles.askTitle, { color: barText }]}>
                {t(language, 'reader.ownBookAsk.title')}
              </Text>
              <Text style={[styles.askBody, { color: barText + 'B3' }]}>
                {t(language, 'reader.ownBookAsk.body')}
              </Text>
              {/* Stacked, not side by side: these two labels are sentences, and
                  the row layout the summary uses squeezes them onto a narrow
                  phone. */}
              <View style={styles.askButtons}>
                <TouchableOpacity
                  style={[styles.exitSummaryBtn, styles.askBtn, { backgroundColor: colors.primary }]}
                  onPress={handleExitUpload}
                  accessibilityRole="button"
                >
                  <Text style={[styles.exitSummaryBtnText, styles.askBtnText, { color: '#fff' }]}>
                    {t(language, 'reader.ownBookAsk.cta')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.exitSummaryBtn, styles.askBtn, { backgroundColor: barText + '15' }]}
                  onPress={handleExitLater}
                  accessibilityRole="button"
                >
                  <Text style={[styles.exitSummaryBtnText, styles.askBtnText, { color: barText }]}>
                    {t(language, 'reader.ownBookAsk.dismiss')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </View>
    </>
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
    ...StyleSheet.absoluteFillObject,
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
    ...StyleSheet.absoluteFillObject,
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
