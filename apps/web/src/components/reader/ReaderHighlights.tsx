import { useRef, useCallback, useState, useEffect } from 'react'
import { useTextSelection } from '../../hooks/useTextSelection'
import { useHighlightEdit, type ScrollToHighlight } from '../../hooks/useHighlightEdit'
import { useTranslationPopup } from '../../hooks/useTranslationPopup'
import { extractSentence } from '../../lib/sentenceExtractor'
import { useExplainPopup } from '../../hooks/useExplainPopup'
import { useNativeLanguage } from '../../context/NativeLanguageContext'
import { useTts } from '../../hooks/useTts'
import { useReaderVocabulary } from '../../hooks/useReaderVocabulary'
import { useTranslation } from '../../hooks/useTranslation'
import { useWordBubble } from '../../hooks/useWordBubble'
import { normalizeVocabKey } from '../../lib/vocabKey'
import type { HighlightAnchor, HighlightColor, StoredHighlight } from '../../lib/offlineDb'
import type { PdfAnchor } from '@textstack/shared'
import { computePdfAnchorFromRange } from '../../lib/pdfHighlightAnchor'
import { SelectionToolbar } from './SelectionToolbar'
import { HighlightOverlayLayer } from './HighlightOverlayLayer'
import { VocabOverlayLayer } from './VocabOverlayLayer'
import { TranslationPopup } from './TranslationPopup'
import { ExplanationPopup } from './ExplanationPopup'
import { WordPopup } from './WordPopup'
import { NoteEditor } from './NoteEditor'
import { TtsHighlightOverlay } from './TtsHighlightOverlay'
import { ImageLightbox } from './ImageLightbox'
import { Toast } from '../Toast'
import { useAuth } from '../../context/AuthContext'

interface ReaderHighlightsProps {
  editionId: string
  chapterId: string
  containerRef: React.RefObject<HTMLElement | null>
  isAuthenticated?: boolean
  bookLanguage?: string
  bookTitle?: string
  userBookId?: string
  ttsSpeed?: number
  scrollToHighlightId?: string | null
  highlightLinkReady?: boolean
  onHighlightLinkDone?: (found: boolean) => void
  /** Nonce-driven jump from the TOC drawer's Highlights tab (reflow highlights). */
  scrollToHl?: ScrollToHighlight | null
  /** Route to a reflow highlight's chapter when a drawer jump lands off-screen. */
  onNavigateToHighlight?: (highlight: StoredHighlight) => void
  showInlineTranslations?: boolean
  // Highlights list + mutators are hoisted to ReaderPage (single useHighlights
  // instance, shared with the PDF paint path). Passed down instead of the old
  // internal useHighlights inside useHighlightEdit — kills the PDF-mode double load.
  highlights: StoredHighlight[]
  addHighlight: (anchor: HighlightAnchor, color: HighlightColor, selectedText: string) => Promise<StoredHighlight>
  updateHighlight: (id: string, updates: { color?: HighlightColor; noteText?: string | null }) => Promise<StoredHighlight | null>
  removeHighlight: (id: string) => Promise<void>
  /**
   * Original-layout PDF mode: keep the live selection actions (translate /
   * explain / TTS / copy / vocab-save) but drop persistent visual layers —
   * highlight-overlay + vocab-underline can't map ranges onto a pdf.js text
   * layer, so they're reflow-only. Also hides the Highlight button.
   */
  liveActionsOnly?: boolean
  /**
   * Original-layout PDF create seam. When set, the Highlight button is shown and
   * "Highlight" builds a quad-rect PdfAnchor from the live selection (over the
   * pdf.js text layer) and hands it up — the persistent paint/edit lives in the
   * PDF subtree, not the reflow overlay. Absent → the reflow highlight path.
   */
  onPdfHighlight?: (anchor: PdfAnchor, text: string, color: HighlightColor) => void | Promise<unknown>
  children: React.ReactNode
}

// Returns null (= definition mode) when native equals book language.
// We deliberately do NOT gate on hasConfirmedLanguage here: onboarding
// wow factor requires a translation on first tap. Save-path has its own
// confirmation gate (handleSave throws 'native_language_not_confirmed'),
// so translating here cannot poison the SRS pipeline.
function resolveTargetLang(nativeLang: string, bookLang: string): string | null {
  return nativeLang !== bookLang ? nativeLang : null
}

/** Count words in a trimmed selection string. */
function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

export function ReaderHighlights({
  editionId,
  chapterId,
  containerRef,
  bookLanguage = 'en',
  bookTitle,
  userBookId,
  ttsSpeed = 1.0,
  scrollToHighlightId,
  highlightLinkReady,
  onHighlightLinkDone,
  scrollToHl,
  onNavigateToHighlight,
  showInlineTranslations = false,
  highlights,
  addHighlight,
  updateHighlight,
  removeHighlight,
  liveActionsOnly = false,
  onPdfHighlight,
  children,
}: ReaderHighlightsProps) {
  const { nativeLanguage, setNativeLanguage, hasConfirmedLanguage } = useNativeLanguage()
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const targetLang = resolveTargetLang(nativeLanguage, bookLanguage)

  // --- Text selection ---
  const { selection, clearSelection, hasSelection } = useTextSelection(containerRef)

  const selectionWordCount = countWords(selection.text)
  const isSingleWord = hasSelection && selectionWordCount === 1

  // --- Vocab map + save/update (guest = real User via cookie session, same API path) ---
  const { vocabMap, addWord, removeWord, updateTranslation, recordSavedWord, idbUnavailable, dismissIdbUnavailable, guestNudge, dismissGuestNudge } = useReaderVocabulary(bookLanguage, targetLang, userBookId || editionId)
  const { openAuthModal } = useAuth()

  const {
    bubble, closeBubble, clearAutoSave, lookupState, addAnywayBusy, savingWord, handleAddAnyway, pendingToast, setPendingToast,
  } = useWordBubble({
    selection, clearSelection, hasSelection, isSingleWord, containerRef, bookLanguage, targetLang,
    editionId, chapterId, userBookId, bookTitle, nativeLanguage, hasConfirmedLanguage,
    vocab: { vocabMap, addWord, updateTranslation, recordSavedWord }, t,
  })

  // --- Highlights (note editor + scroll-to deep link) — list + mutators hoisted
  // to ReaderPage and passed in; this hook owns only the editing/scroll UI state. ---
  const {
    editingHighlight,
    editingRect,
    handleHighlightClick,
    closeNoteEditor,
    handleNoteSave,
    handleHighlightDelete,
    createHighlightFromSelection,
  } = useHighlightEdit({
    highlights,
    addHighlight,
    updateHighlight,
    removeHighlight,
    chapterId,
    containerRef,
    scrollToHighlightId,
    highlightLinkReady,
    onHighlightLinkDone,
    pdfLinkJumps: liveActionsOnly,
    scrollToHl,
    onNavigateToHighlight,
  })

  // --- TTS ---
  const { speak, stop: stopTts, isPlaying: ttsPlaying, timestamps: ttsTimestamps, currentWordIndex: ttsCurrentWord } = useTts(chapterId)
  // Captured at speak() time so the overlay has text to split + highlight even
  // after the selection is cleared. Cleared explicitly on stop() — relying on
  // `isPlaying` alone would leave the last text flashing between playbacks.
  const [ttsSpokenText, setTtsSpokenText] = useState<string | null>(null)
  const handleSpeak = useCallback((text: string, lang?: string) => {
    setTtsSpokenText(text)
    speak(text, lang || bookLanguage, undefined, ttsSpeed)
  }, [speak, bookLanguage, ttsSpeed])
  const handleStopTts = useCallback(() => {
    stopTts()
    setTtsSpokenText(null)
  }, [stopTts])

  // Auto-play TTS when popup opens on a new word (not on every translation/definition update).
  useEffect(() => {
    if (bubble?.word) handleSpeak(bubble.word)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubble?.word])

  // --- Multi-word translation popup ---
  const translationPopup = useTranslationPopup({
    bookLanguage,
    targetLang,
    onClose: clearSelection,
  })

  const handleTranslate = useCallback(() => {
    if (!selection.text || !selection.rect) return
    const container = containerRef.current
    const sentence = selection.range && container ? extractSentence(selection.range, container) : undefined
    translationPopup.open(selection.text, selection.rect, { sentence, bookId: userBookId || editionId })
  }, [selection.text, selection.rect, selection.range, containerRef, userBookId, editionId, translationPopup])

  // --- Explain popup ---
  const explainPopup = useExplainPopup({
    containerRef,
    editionId,
    nativeLanguage,
    onClose: clearSelection,
  })

  const handleExplain = useCallback(() => {
    explainPopup.openFromSelection(selection.text, selection.range, selection.rect)
  }, [explainPopup, selection.text, selection.range, selection.rect])

  // --- Selection toolbar ---
  const handleHighlight = useCallback(
    async (color: HighlightColor) => {
      // Original-layout PDF: build a quad-rect anchor from the selection over the
      // pdf.js text layer and hand it up; the PDF subtree paints + persists it.
      if (onPdfHighlight) {
        if (selection.range) {
          const anchor = computePdfAnchorFromRange(selection.range, containerRef.current)
          if (anchor) await onPdfHighlight(anchor, selection.text, color)
        }
        clearSelection()
        translationPopup.close()
        return
      }
      await createHighlightFromSelection(selection.range, selection.text, color)
      clearSelection()
      translationPopup.close()
    },
    [selection.range, selection.text, createHighlightFromSelection, clearSelection, translationPopup, onPdfHighlight, containerRef],
  )

  const handleCopy = useCallback(() => {
    clearSelection()
    translationPopup.close()
  }, [clearSelection, translationPopup])

  // --- Image lightbox (tap chapter <img> → fullscreen viewer w/ zoom+pan) ---
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const handleContentClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t.tagName !== 'IMG') return
    // Skip overlay images (translation tags, vocab underlines etc render no <img>,
    // but be defensive against future overlay layers).
    if (t.closest('[data-vocab-overlay]') || t.closest('[data-reader-overlay]')) return
    // If wrapped in <a>, prevent navigation in favor of the lightbox.
    if (t.closest('a')) e.preventDefault()
    const img = t as HTMLImageElement
    setLightbox({ src: img.currentSrc || img.src, alt: img.alt || '' })
  }, [])

  // --- Render ---
  return (
    <div
      ref={wrapperRef}
      className="reader-highlights-wrapper"
      onContextMenu={(e) => e.preventDefault()}
      onClick={handleContentClick}
    >
      {children}

      {/* Persistent visual layers are reflow-only — they can't project ranges
          onto a pdf.js text layer, so skip them in Original-layout mode. */}
      {!liveActionsOnly && (
        <>
          <HighlightOverlayLayer
            highlights={highlights}
            containerRef={containerRef}
            chapterId={chapterId}
            onHighlightClick={handleHighlightClick}
          />

          <VocabOverlayLayer
            containerRef={containerRef}
            vocabMap={vocabMap}
            showInlineTranslations={showInlineTranslations}
            activeBubble={bubble ? { word: bubble.word, translation: bubble.translation } : null}
          />
        </>
      )}

      {/* Multi-word selection → full highlights toolbar */}
      {hasSelection && !isSingleWord && !translationPopup.show && !explainPopup.show && (
        <SelectionToolbar
          rect={selection.rect}
          text={selection.text}
          containerRef={containerRef}
          // Un-hide the Highlight button in Original mode: PDF highlights persist
          // via the onPdfHighlight seam. Only truly reflow-less/live surfaces
          // (liveActionsOnly without a PDF create seam) still hide it.
          hideHighlight={liveActionsOnly && !onPdfHighlight}
          onHighlight={handleHighlight}
          onTranslate={handleTranslate}
          onExplain={handleExplain}
          onSpeak={() => handleSpeak(selection.text)}
          onCopy={handleCopy}
        />
      )}

      {/* Single-word selection → WordPopup (translation, or Explain in definition mode, Remove). Save is automatic. */}
      {/* NOT gated on isSingleWord: clicking buttons inside the popup natively
          clears the document selection — keeping the popup mounted lets the user
          interact with it (lang picker, etc). Close paths: WordPopup's own
          click-outside / Escape / × / auto-dismiss, or selection growing to multi-word. */}
      {bubble && !translationPopup.show && (() => {
        const entry = vocabMap.get(normalizeVocabKey(bubble.word))
        const isSaved = !!entry
        return (
          <WordPopup
            word={bubble.word}
            translation={bubble.translation}
            translationLoading={bubble.translationLoading}
            definition={bubble.definition}
            definitionLoading={bubble.definitionLoading}
            rect={bubble.rect}
            containerRef={containerRef}
            onSpeak={() => handleSpeak(bubble.word)}
            onRemove={entry?.id ? () => {
              removeWord(entry.id!, bubble.word)
              // Clear dedup so a subsequent tap on the same word re-auto-saves.
              clearAutoSave(bubble.word)
              closeBubble()
            } : undefined}
            onClose={closeBubble}
            isSaved={isSaved}
            nativeLanguage={nativeLanguage}
            onChangeNativeLanguage={setNativeLanguage}
            hasConfirmedLanguage={hasConfirmedLanguage}
            bookLanguage={bookLanguage}
            t={t}
            lookupInfo={lookupState && lookupState.word === bubble.word
              ? { kind: lookupState.kind, tapsRemaining: lookupState.tapsRemaining }
              : null}
            onAddAnyway={lookupState && lookupState.word === bubble.word ? handleAddAnyway : undefined}
            addAnywayBusy={addAnywayBusy}
            saveInFlight={savingWord === bubble.word}
          />
        )
      })()}

      {translationPopup.show && (
        <TranslationPopup
          text={translationPopup.text}
          translatedText={translationPopup.translatedText}
          isLoading={translationPopup.isTranslating}
          error={translationPopup.error}
          sourceLang={translationPopup.sourceLang}
          targetLang={translationPopup.targetLang}
          languages={translationPopup.languages}
          rect={translationPopup.rect}
          containerRef={containerRef}
          onSourceLangChange={translationPopup.setSourceLang}
          onTargetLangChange={translationPopup.setTargetLang}
          onSpeak={handleSpeak}
          onClose={translationPopup.close}
        />
      )}

      {explainPopup.show && (
        <ExplanationPopup
          word={explainPopup.word}
          explanation={explainPopup.explanation}
          isLoading={explainPopup.isExplaining}
          error={explainPopup.error}
          rect={explainPopup.rect}
          containerRef={containerRef}
          onClose={explainPopup.close}
        />
      )}

      {editingHighlight && (
        <NoteEditor
          highlight={editingHighlight}
          rect={editingRect}
          containerRef={containerRef}
          onSave={handleNoteSave}
          onDelete={handleHighlightDelete}
          onClose={closeNoteEditor}
        />
      )}

      {idbUnavailable && (
        <Toast
          message={t('reader.idbUnavailable')}
          duration={5000}
          onClose={dismissIdbUnavailable}
          onClick={() => { dismissIdbUnavailable(); openAuthModal() }}
        />
      )}

      {guestNudge && (
        <Toast
          message={t(guestNudge === 'ten' ? 'guest.nudgeTen' : 'guest.nudgeThree')}
          duration={6000}
          onClose={dismissGuestNudge}
          action={{ label: t('guest.nudgeCta'), onClick: () => openAuthModal('register') }}
        />
      )}

      {pendingToast && (
        <Toast
          message={pendingToast}
          duration={3500}
          onClose={() => setPendingToast(null)}
        />
      )}

      {/* Floating overlay with per-word highlighting during multi-word TTS.
          Skip single-word playback (handled by WordPopup's own speaker icon)
          so a word tap doesn't pop a redundant bar at the bottom. */}
      <TtsHighlightOverlay
        text={ttsSpokenText ?? ''}
        timestamps={ttsTimestamps}
        currentWordIndex={ttsCurrentWord}
        visible={ttsPlaying && !!ttsSpokenText && countWords(ttsSpokenText) > 1}
        onStop={handleStopTts}
      />

      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}
