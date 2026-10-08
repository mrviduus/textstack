import { useRef, useCallback, useState, useEffect } from 'react'
import type { TextSelectionState } from './useTextSelection'
import type { useReaderVocabulary } from './useReaderVocabulary'
import { useBubbleTranslationSync } from './useBubbleTranslationSync'
import { updateWord, promoteLookup } from '../api/vocabulary'
import { extractSentence } from '../lib/sentenceExtractor'
import { tokenizeVocabWords, extractWordFromRange } from '../lib/vocabKey'
import { fetchWordBubble } from '../lib/wordBubbleFetch'
import { vocabChapterId } from '../lib/textAnchor'

type ReaderVocabulary = ReturnType<typeof useReaderVocabulary>

interface Params {
  selection: TextSelectionState
  clearSelection: () => void
  hasSelection: boolean
  /** The selection is exactly one word: the popup's trigger. */
  isSingleWord: boolean
  containerRef: React.RefObject<HTMLElement | null>
  bookLanguage: string
  /** Null = definition mode (native equals the book's language). */
  targetLang: string | null
  editionId: string
  chapterId: string
  userBookId?: string
  bookTitle?: string
  nativeLanguage: string
  hasConfirmedLanguage: boolean
  vocab: Pick<ReaderVocabulary, 'vocabMap' | 'addWord' | 'updateTranslation' | 'recordSavedWord'>
  t: (key: string) => string
}

/**
 * The single-word popup (ReaderHighlights): opens on a one-word selection after a short
 * stabilisation, fetches translation / Explain, auto-saves the word, and owns the
 * rare-word "Add anyway" flow and its toast.
 */
export function useWordBubble({
  selection,
  clearSelection,
  hasSelection,
  isSingleWord,
  containerRef,
  bookLanguage,
  targetLang,
  editionId,
  chapterId,
  userBookId,
  bookTitle,
  nativeLanguage,
  hasConfirmedLanguage,
  vocab,
  t,
}: Params) {
  const { vocabMap, addWord, updateTranslation, recordSavedWord } = vocab

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

  // --- Single-word popup state ---
  const [bubble, setBubble] = useState<{
    word: string
    translation: string | null
    translationLoading: boolean
    definition: string | null
    definitionLoading: boolean
    rect: DOMRect | null
    range: Range | null
    sentence?: string
    bookId?: string
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
        chapterId: vocabChapterId(chapterId, userBookId),
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
    // Definition mode (confirmed native == book language): Explain fills `definition`.
    const explainInContext = !targetLang && hasConfirmedLanguage
    // Pass book context so translation can pick the domain-aware reading
    // ("warehouse" in a CS book → data-warehouse, in a logistics book →
    // storage facility). Same sentence-extraction logic the save flow uses.
    // Stored in the bubble so a lang-switch refetch sends the same context.
    const container = containerRef.current
    const sentence = range && container ? extractSentence(range, container) || undefined : undefined
    const bookId = userBookId || editionId || undefined
    setBubble({
      word,
      translation: null,
      translationLoading: !!targetLang,
      definition: null,
      definitionLoading: explainInContext,
      rect,
      range,
      sentence,
      bookId,
    })
    fetchWordBubble({
      word, bookLanguage, targetLang,
      explainInContext,
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
  }, [bookLanguage, targetLang, handleSave, triggerAutoSave, hasConfirmedLanguage, containerRef, userBookId, editionId])

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

  return {
    bubble,
    closeBubble,
    clearAutoSave,
    lookupState,
    addAnywayBusy,
    savingWord,
    handleAddAnyway,
    pendingToast,
    setPendingToast,
  }
}
