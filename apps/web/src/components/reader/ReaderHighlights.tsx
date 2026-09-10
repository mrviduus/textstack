import { useRef, useCallback, useState, useEffect } from 'react'
import { useTextSelection } from '../../hooks/useTextSelection'
import { useHighlightEdit, type ScrollToHighlight } from '../../hooks/useHighlightEdit'
import { useTranslationPopup } from '../../hooks/useTranslationPopup'
import { useExplainPopup } from '../../hooks/useExplainPopup'
import { useNativeLanguage } from '../../context/NativeLanguageContext'
import { useTts } from '../../hooks/useTts'
import { useReaderVocabulary } from '../../hooks/useReaderVocabulary'
import { useDictionary } from '../../hooks/useDictionary'
import { useTranslation } from '../../hooks/useTranslation'
import { useBubbleTranslationSync } from '../../hooks/useBubbleTranslationSync'
import { updateWord, promoteLookup } from '../../api/vocabulary'
import { extractSentence } from '../../lib/sentenceExtractor'
import { tokenizeVocabWords, normalizeVocabKey, extractWordFromRange } from '../../lib/vocabKey'
import { fetchWordBubble } from '../../lib/wordBubbleFetch'
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
  /** Open the Study Buddy panel for a highlighted passage (AI-038b). Catalog editions only. */
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
  const { vocabMap, addWord, removeWord, updateTranslation, recordSavedWord, idbUnavailable, dismissIdbUnavailable } = useReaderVocabulary(bookLanguage, targetLang)
  const { openAuthModal } = useAuth()

  // Anti-spiral F2: toast when a save lands in the pending queue (daily cap hit).
  // Cleared on auto-dismiss; new pending saves overwrite the message.
  const [pendingToast, setPendingToast] = useState<string | null>(null)

  // Anti-spiral F1: rare-word state. When SaveWord returns lookup / lookup_pending
  // we keep the lookupId + kind so WordPopup can render RareWordNotice with an
  // "Add anyway" button. Keyed by word so re-tapping a different word resets.
  const [lookupState, setLookupState] = useState<{
    word: string
    id: string
    kind: 'lookup' | 'lookup_pending'
    tapsRemaining: number | null
  } | null>(null)
  const [addAnywayBusy, setAddAnywayBusy] = useState(false)
  // Word for which the auto-save POST is still in flight. WordPopup uses this
  // to suspend its 3-8s auto-dismiss until the save resolves — otherwise a slow
  // server response can close the popup before a lookup result arrives, and
  // the user never sees RareWordNotice.
  const [savingWord, setSavingWord] = useState<string | null>(null)

  // --- Dictionary (phonetic + definition) ---
  const { lookup: lookupWord } = useDictionary()

  // --- Single-word popup state ---
  const [bubble, setBubble] = useState<{
    word: string
    translation: string | null
    translationLoading: boolean
    phonetic: string | undefined
    definition: string | null
    definitionLoading: boolean
    rect: DOMRect | null
    range: Range | null
  } | null>(null)
  const bubbleAbortRef = useRef<AbortController | null>(null)
  // Stabilization delay before opening popup. Filters out transient single-word
  // selections fired by iOS tap-to-select / scroll-jitter / incidental taps.
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const STABILIZE_MS = 220

  // Backend translation patch + mid-popup lang-switch refetch + auto-save dedup.
  const { triggerAutoSave, clearAutoSave } = useBubbleTranslationSync({
    bubble,
    setBubble,
    vocabMap,
    updateTranslation,
    targetLang,
    bookLanguage,
    abortRef: bubbleAbortRef,
  })

  const closeBubble = useCallback(() => {
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null }
    bubbleAbortRef.current?.abort()
    setBubble(null)
    setLookupState(null)
    // Clear selection to break the effect loop: without this, selection persists,
    // isSingleWord stays true, bubble is null → effect re-fires → mercание.
    clearSelection()
  }, [clearSelection])

  // Auto-save: invoked from openBubble on every word tap (unless the word is
  // already saved or a save is in-flight). Captures sentence from the live range
  // at tap time. Translation may be null at this point — `fetchWordBubble` resolves
  // it async, and the translation-patch effect below forwards it to the backend.
  const handleSave = useCallback(async (word: string, range: Range | null) => {
    // Gate: never save vocab with an unconfirmed native. A guessed
    // `navigator.language` isn't a real user choice — persisting it poisons the
    // SRS enrichment pipeline (explanations generated in wrong language) and
    // can't be retroactively fixed once LLM fields are cached. Throw so
    // `triggerAutoSave`'s catch clears the dedup key, letting re-tap retry
    // after the user confirms via WordPopup's picker.
    if (!hasConfirmedLanguage) {
      throw new Error('native_language_not_confirmed')
    }
    const container = containerRef.current
    const sentence = range && container ? extractSentence(range, container) : undefined
    const currentTranslation = bubble?.word === word ? bubble?.translation : null
    setSavingWord(word)
    let resp: Awaited<ReturnType<typeof addWord>> | null = null
    try {
      resp = await addWord({
        word,
        language: bookLanguage,
        editionId: userBookId ? undefined : (editionId || undefined),
        chapterId: userBookId ? undefined : (chapterId || undefined),
        userBookId: userBookId || undefined,
        sentence: sentence || undefined,
        bookTitle: bookTitle || undefined,
        // Send the actual confirmed native language (not `targetLang`, which is
        // null in same-lang definition mode — but the user's explicit choice is
        // still a valid native we want the backend to record for SRS enrichment).
        nativeLanguage: nativeLanguage,
        translation: currentTranslation || null,
      }).catch(() => null)
    } finally {
      // Clear no matter what — keeps the popup's auto-dismiss from stalling
      // forever if the backend is down. Only clear for this word to avoid
      // stomping a newer in-flight save from a re-tap.
      setSavingWord((prev) => (prev === word ? null : prev))
    }
    if (resp?.outcome === 'pending') {
      setPendingToast(t('reader.vocab.queuedForTomorrow'))
    } else if (resp?.outcome === 'lookup' || resp?.outcome === 'lookup_pending') {
      // Keep lookupId so "Add anyway" can POST /lookups/{id}/promote. No toast:
      // the popup itself renders RareWordNotice which is louder than a transient
      // toast at the bottom of the screen.
      if (resp.lookupId) {
        setLookupState({
          word,
          id: resp.lookupId,
          kind: resp.outcome,
          tapsRemaining: resp.tapsRemaining ?? null,
        })
      }
    }
    const saved = resp?.word
    if (saved?.id && currentTranslation) {
      updateWord(saved.id, { translation: currentTranslation }).catch(() => {})
      updateTranslation(word, currentTranslation)
    }
  }, [
    addWord, bookLanguage, bookTitle, chapterId, containerRef,
    editionId, nativeLanguage, hasConfirmedLanguage, userBookId, updateTranslation,
    bubble?.word, bubble?.translation, t,
  ])

  // Popup creation, extracted so the scheduling effect has tight deps and doesn't
  // re-fire on translation/definition arrival. Also fires auto-save for the tapped
  // word (fire-and-forget) so the user doesn't need an explicit Save click.
  const openBubble = useCallback((word: string, rect: DOMRect, range: Range | null) => {
    bubbleAbortRef.current?.abort()
    const ctrl = new AbortController()
    bubbleAbortRef.current = ctrl
    // Reset rare-word state so prior word's notice doesn't leak across taps.
    setLookupState(null)
    setBubble({
      word,
      translation: null,
      translationLoading: !!targetLang,
      phonetic: undefined,
      definition: null,
      definitionLoading: true,
      rect,
      range,
    })
    // Pass book context so translation can pick the domain-aware reading
    // ("warehouse" in a CS book → data-warehouse, in a logistics book →
    // storage facility). Same sentence-extraction logic the save flow uses.
    const container = containerRef.current
    const sentence = range && container ? extractSentence(range, container) ?? undefined : undefined
    const bookId = userBookId || editionId || undefined
    fetchWordBubble({
      word, bookLanguage, targetLang,
      lookup: lookupWord, vocabMap, updateTranslation,
      signal: ctrl.signal,
      patch: (fields) => setBubble((prev) => (prev && prev.word === word ? { ...prev, ...fields } : prev)),
      bookId,
      sentence,
    })

    // Auto-save via shared dedup hook (sync ref seals race that vocabMap can't —
    // state commit is async, a second rapid tap would see has(key)===false).
    // Skip when native isn't confirmed: save is deferred until the user picks
    // a native language in WordPopup's picker (see catch-up effect below).
    if (hasConfirmedLanguage) {
      triggerAutoSave(word, () => handleSave(word, range))
    }
  }, [bookLanguage, targetLang, vocabMap, updateTranslation, lookupWord, handleSave, triggerAutoSave, hasConfirmedLanguage, containerRef, userBookId, editionId])

  // Catch-up auto-save: if the user taps a word BEFORE confirming native
  // language, openBubble opens the popup but skips the save. When they then
  // pick a language via the popup's picker, `hasConfirmedLanguage` flips true
  // while the same bubble is still on screen — fire the save now so they
  // don't have to re-tap. `triggerAutoSave`'s dedup prevents a duplicate if
  // the openBubble branch also fired (confirmed-first path).
  const prevConfirmedRef = useRef(hasConfirmedLanguage)
  useEffect(() => {
    if (!prevConfirmedRef.current && hasConfirmedLanguage && bubble) {
      triggerAutoSave(bubble.word, () => handleSave(bubble.word, bubble.range))
    }
    prevConfirmedRef.current = hasConfirmedLanguage
  }, [hasConfirmedLanguage, bubble, triggerAutoSave, handleSave])

  // Trigger popup when selection narrows to 1 word — with a short stabilization window
  // so transient selections (iOS auto-select, scroll-tap jitter) don't flash the popup.
  useEffect(() => {
    if (!isSingleWord || !selection.rect || !selection.text) {
      // Cancel any pending open.
      if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null }
      // Drop bubble ONLY when selection grew to multi-word (toolbar takes over).
      // Empty selection must NOT close the popup: clicking a button inside the
      // popup natively clears the document selection — we'd kill our own popup.
      // Click-outside-popup is handled by WordPopup's own listener.
      if (hasSelection && !isSingleWord) {
        bubbleAbortRef.current?.abort()
        setBubble(null)
      }
      return
    }
    // Extract word from selection. Prefer DOM-aware extraction (strips
    // .vocab-inline-translation text that Selection API concatenates with the word
    // when both are in the same <mark> — e.g. "amiableприветливый"). Fallback to
    // tokenizer on raw text to strip NBSP / zero-width chars. Preserves case.
    const word = extractWordFromRange(selection.range)
      ?? tokenizeVocabWords(selection.text)[0]?.word
      ?? selection.text.trim()
    if (!word) return
    // If same word already shown, don't re-fetch.
    if (bubble?.word === word) return

    // Debounce: schedule opening, cancel if selection changes again within the window.
    // Net effect: brief accidental word-selections never create a bubble.
    if (openTimerRef.current) clearTimeout(openTimerRef.current)
    const rect = selection.rect
    const range = selection.range
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null
      openBubble(word, rect, range)
    }, STABILIZE_MS)
    return () => {
      if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null }
    }
  }, [isSingleWord, hasSelection, selection.text, selection.rect, selection.range, bubble?.word, openBubble])

  // Clean abort + pending open timer on unmount
  useEffect(() => () => {
    bubbleAbortRef.current?.abort()
    if (openTimerRef.current) clearTimeout(openTimerRef.current)
  }, [])

  // "Add anyway" on RareWordNotice: bypasses the frequency filter by promoting
  // the WordLookup row server-side into a full VocabularyWord. Backend deletes
  // the lookup + applies Source='manual_add_anyway'. On success we merge the
  // returned DTO into vocabMap so the reader immediately reflects the saved
  // state (green highlight / check badge on re-tap). On failure we surface a
  // toast — silence leaves the user guessing why nothing happened.
  const handleAddAnyway = useCallback(async () => {
    if (!lookupState || addAnywayBusy) return
    setAddAnywayBusy(true)
    try {
      const saved = await promoteLookup(lookupState.id)
      recordSavedWord(saved)
      setLookupState(null)
      setPendingToast(t('reader.vocab.addedToSrs'))
      closeBubble()
    } catch {
      setPendingToast(t('reader.vocab.addAnywayFailed'))
    } finally {
      setAddAnywayBusy(false)
    }
  }, [lookupState, addAnywayBusy, t, closeBubble, recordSavedWord])

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
    scrollToHl,
    onNavigateToHighlight,
  })

  // --- TTS ---
  const { speak, stop: stopTts, isPlaying: ttsPlaying, timestamps: ttsTimestamps, currentWordIndex: ttsCurrentWord } = useTts()
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
    translationPopup.open(selection.text, selection.rect)
  }, [selection.text, selection.rect, translationPopup])

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

  // --- Study Buddy: hand the whole selected passage up to the reader's panel ---
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

      {/* Single-word selection → WordPopup (phonetic, translation, definition, Remove). Save is automatic. */}
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
            phonetic={bubble.phonetic}
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
