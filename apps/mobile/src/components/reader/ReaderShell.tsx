import { useEffect, useState, useRef } from 'react'
import { View, StyleSheet, Linking, BackHandler } from 'react-native'
import { WebView } from 'react-native-webview'
import { useRouter, Stack } from 'expo-router'
import { t, estimateTimeLeft, formatMinutesLeft, buildChapterDiscussBrief, isReviewableChapter, chapterSlugForPage } from '@textstack/shared'
import { API_URL } from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { useReaderSettings } from '../../hooks/useReaderSettings'
import { useReaderBars } from '../../hooks/useReaderBars'
import { useKeepReaderAwake } from '../../hooks/useKeepReaderAwake'
import { useReadingPace } from '../../hooks/useReadingPace'
import { useReaderExitSummary } from '../../hooks/useReaderExitSummary'
import { useAssistantLauncher } from '../../hooks/useAssistantLauncher'
import { ConnectAssistantSheet } from '../library/ReviewChapterButton'
import { useReadingSession } from '../../hooks/useReadingSession'
import { useTts } from '../../hooks/useTts'
import { useQuickStats } from '../../hooks/useQuickStats'
import { useHaptics } from '../../hooks/useHaptics'
import { useToast } from '../../context/ToastContext'
import { readerTextLanguage } from '../../lib/bookLanguage'
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
import { PdfReaderChrome, PdfErrorOverlay } from './PdfReaderChrome'
import { ReaderFooter } from './ReaderFooter'
import { ReaderExitPrompt } from './ReaderExitPrompt'
import { useReaderPdf } from './useReaderPdf'
import { useReaderDocument } from './useReaderDocument'
import { useReaderSessionFeed } from './useReaderSessionFeed'
import { useReaderWordActions } from './useReaderWordActions'
import { useReaderChapterNav } from './useReaderChapterNav'
import { useReaderMessages } from './useReaderMessages'
import type { ReaderShellProps } from './readerShellTypes'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { readerBackAction } from '../../lib/firstRun'
import { claimVisit } from '../../lib/readerVisit'
import { discussAfterSave } from '../../lib/chapterEnd'
import { vocabPaintJs } from '../../lib/vocabPaintJs'

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
    original, originalFileUrl, originalInitialPage, originalChapterPicked,
    originalResumePage, originalResumeReady, originalNewerPage, persistPdfPage,
    onTogglePageBookmark, isPageBookmarked, onForceReflow,
  } = props

  const router = useRouter()
  const { isAuthenticated, user } = useAuth()
  const { settings, update: updateSettings, resolvedFontFamily, resolvedTheme } = useReaderSettings()
  const { colors } = useTheme()
  // Translate's bookId: editionId or userBookId, the same id web sends — the server
  // resolves the genre from either (`ResolveGenreAsync`). Explain keeps `explainBookId`.
  const translateBookId = source.id || undefined
  const { language } = useLanguage()
  // The UI speaks `language`; the page is written in this one (M5).
  const textLanguage = readerTextLanguage(props.bookLanguage, language)
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
  const [tocOpen, setTocOpen] = useState(false)

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
  // A slow fetch can outlive the screen (the reader backs out while it hangs); navigating from a
  // reader that is gone would replace whatever screen they went to.
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

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
  const { progress, bookProgress, updateBookProgress, onMessage: onPositionMessage } = useReaderSessionFeed({
    chapters, chapterSlug, original, positionSettled, sessionJumpRef, onRestoreLanded, bumpProgress,
    progressRef, scrollOffsetRef, positionRef, currentChapterSlugRef, bookProgressRef, totalWordCountRef,
    finishedChapterRef, updateSessionProgress, recordSessionActivity,
  })

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

  const {
    vocabMapRef, vocabActions,
    selection, wordSaved, lookupState, openSelection, closeSelection,
    highlightsRef, editingHighlight, setEditingHighlight, createPdfHighlight, repaintPdf,
    saveHighlightNote, updateHighlightColor, removeHighlight, pendingPdfColorRef,
    handleSaveWord, handleMarkKnown, handleRemoveWord, handleHighlight,
  } = useReaderWordActions({
    source, injectJs, bookTitleRef, original, chapter, user, isAuthenticated, language, textLanguage,
    nativeLanguage, settings, updateSettings, haptics, showToast, router, sessionWordCountRef,
    setSessionWordCount, footerHeight, translateBookId,
  })

  const pdf = useReaderPdf({
    original, originalFileUrl, originalInitialPage, originalChapterPicked, originalResumePage, originalResumeReady,
    originalNewerPage, persistPdfPage, chapters, chapterSlug, injectJs,
    language, aliveRef, recordSessionActivity, repaintPdf,
  })
  const { pdfCurrentPage, pdfNumPages, pdfError, setPdfError, scrollPdfToPage, onMessage: onPdfMessage } = pdf

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

  const { openChapter, endModelJs, onChapterEndActionRef } = useReaderChapterNav({
    chapter, chapters, bookTitle, saveProgress, ensureChapter, isChapterOnDevice,
    onNavigateChapter, chapterNavigatorRef, original, injectJs,
    visitKey, handOffSession, sessionWordCount, sessionWordCountRef, finishedChapterRef, aliveRef,
    showToast, language, footerHeight, discussBrief, discuss, handleExitReview, router,
  })

  const handleMessage = useReaderMessages({
    original, toggleBars, showBars, hideBars, recordSessionActivity, haptics,
    onPositionMessage, onPdfMessage, onChapterEndActionRef,
    highlightsRef, setEditingHighlight, openSelection, createPdfHighlight, pendingPdfColorRef,
  })

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

  const { webViewKey, onRendererGone, webViewSource, docLoadedRef, applyTypography, applyChrome } = useReaderDocument({
    original, originalFileUrl, originalInitialPage, htmlChapterSlug, injectJs, reflow, onDocumentRebuild,
    chapter, settings, resolvedFontFamily, resolvedTheme, insets,
    ...pdf,
  })

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
              injectJs(vocabPaintJs(vocabMapRef.current))
            }
            injectJs(`setShowInlineTranslations(${settings.showInlineTranslations})`)
            injectJs(endModelJs)
            // Scroll-restore is owned by useReaderPersistence — it coordinates
            // this signal with the async saved-position fetch (no race).
            onWebViewLoaded()
            // Typography and theme that changed while this document loaded. After the restore is
            // asked, so the reflow knows a restore is in flight and re-asks its target (rule 8).
            docLoadedRef.current = true
            applyTypography()
            applyChrome()
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
            sentence={selection.sentence}
            bookId={translateBookId}
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
            onAddAnyway={lookupState ? () => { void vocabActions.addAnyway(lookupState, selection) } : undefined}
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
          <ReaderFooter
            barBg={barBg}
            barText={barText}
            trackColor={colors.border}
            barsAnim={barsAnim}
            footerTranslateY={footerTranslateY}
            barsVisible={barsVisible}
            bottomInset={insets.bottom}
            bookProgress={bookProgress}
            chapterTitle={activeChapter?.title ?? chapter.title ?? ''}
            currentChapterIndex={currentChapterIndex}
            totalChapters={totalChapters}
            timeLeftLabel={timeLeftLabel}
            hasPrev={!!chapter.prev}
            hasNext={!!chapter.next}
            onPrev={() => chapter.prev && void openChapter(chapter.prev.slug)}
            onNext={() => chapter.next && void openChapter(chapter.next.slug)}
            onHeight={h => { if (h > 0 && h !== measuredFooterHeight) setMeasuredFooterHeight(h) }}
          />
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
          sentence={selection?.sentence}
          bookId={translateBookId}
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
          <PdfErrorOverlay
            bg={resolvedTheme.backgroundColor}
            barText={barText}
            buttonColor={colors.primary}
            topInset={insets.top}
            bottomInset={insets.bottom}
            canReadAsText={!!onForceReflow}
            onPress={() => { if (onForceReflow) { setPdfError(false); onForceReflow() } else { handleExit() } }}
          />
        )}

        {/* "Discuss this chapter" lives in the end-of-chapter block; the words card below keeps a
            link to it when the chapter was finished. */}
        <ConnectAssistantSheet visible={launcher.connect} onClose={launcher.closeConnect} />

        <ReaderExitPrompt
          prompt={exitPrompt}
          barBg={barBg}
          barText={barText}
          language={language}
          sessionWordCount={sessionWordCount}
          onReview={handleExitReview}
          onUpload={handleExitUpload}
          onLater={handleExitLater}
          onDiscuss={finishedChapterRef.current && discussBrief ? discuss : null}
          discussBusy={launcher.busy}
        />
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
})
