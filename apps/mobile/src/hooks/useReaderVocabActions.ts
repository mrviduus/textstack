import { useCallback, useEffect, useRef, MutableRefObject } from 'react'
import { vocabularyApi, t } from '@textstack/shared'
import { cachedTranslate } from '../lib/translateCache'
import type { Chapter, VocabularyWordDto, Language } from '@textstack/shared'
import type { VocabMap } from './useReaderVocabMap'
import { vocabPaintJs } from '../lib/vocabPaintJs'

type ToastFn = (t: { message: string; variant: 'error' | 'success' | 'info' }) => void
type Selection = { text: string; sentence: string; anchor?: any; selectionId: number }
type LookupState = { kind: 'lookup' | 'lookup_pending'; id: string; tapsRemaining: number | null; busy: boolean }

type Options = {
  vocabMapRef: MutableRefObject<VocabMap>
  bookTitleRef: MutableRefObject<string | null>
  /** Either editionIdRef (public reader) or userBookIdRef (user-book reader)
   *  must be supplied. Both pass-through to vocabularyApi.saveWord — the
   *  backend stores either FK depending on which is provided. */
  editionIdRef?: MutableRefObject<string | null>
  userBookIdRef?: MutableRefObject<string | null>
  chapter: Chapter | null
  /** UI language — toasts only. */
  language: Language
  /** Language of the book's text — what a saved word is filed and translated as (M5). */
  textLanguage: string
  nativeLanguage: string
  isAuthenticated: boolean
  injectJs: (js: string) => void
  /** Trigger reactive re-paint of vocab underlines after a mutation.
   *  Inline injectJs calls below still fire for instant feedback; bumpVocab
   *  is a defense-in-depth re-injection in case any path falls through.
   *  Lives in useReaderVocabMap. */
  bumpVocab: () => void
  notifyWordSaved: () => void
  setSessionWordCount: React.Dispatch<React.SetStateAction<number>>
  setWordSaved: (saved: boolean) => void
  setSelection: (s: null) => void
  setLookupState: (s: LookupState | null) => void
  showToast: ToastFn
}

/**
 * Manual vocab actions invoked from the WordCard / SelectionActionBar:
 * Save (manual button), Add-anyway (rare-word notice), Mark known, Remove.
 *
 * The auto-save path inside `handleMessage` still lives in the reader
 * screen — it shares state plumbing with selection lifecycle that's hard
 * to lift cleanly. This hook covers the four user-initiated handlers.
 */
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Save with up to 3 attempts + backoff. Absorbs transient network/5xx blips
 *  that previously dropped a tapped word silently (no underline, no retry).
 *  Deterministic 4xx just exhausts the 3 attempts quickly, then rethrows. */
async function saveWordWithRetry(body: Parameters<typeof vocabularyApi.saveWord>[0]) {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await vocabularyApi.saveWord(body)
    } catch (e) {
      lastErr = e
      if (attempt < 2) await delay(350 * (attempt + 1))
    }
  }
  throw lastErr
}

export function useReaderVocabActions({
  vocabMapRef,
  bookTitleRef,
  editionIdRef,
  userBookIdRef,
  chapter,
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
}: Options) {
  /** Build the per-book identification fields for vocabularyApi.saveWord.
   *  Edition mode → editionId + chapterId, user-book → userBookId + userChapterId. */
  const bookFields = () => {
    if (userBookIdRef?.current) {
      return {
        userBookId: userBookIdRef.current,
        userChapterId: chapter?.id || null,
      } as const
    }
    return {
      editionId: editionIdRef?.current || null,
      chapterId: chapter?.id || null,
    } as const
  }
  /** Shared post-save sequence: mark + count + notify + persist translation. */
  /** `sentence`: the one the word was tapped in (TR-1) — the toolbar's cache key too. */
  const onWordSaved = useCallback((saved: VocabularyWordDto, sourceText: string, sentence: string | null | undefined) => {
    const key = saved.word.toLowerCase()
    vocabMapRef.current[key] = { stage: saved.stage, id: saved.id }
    injectJs(`addVocabWord(${JSON.stringify(key)}, ${saved.stage})`)
    bumpVocab()
    setWordSaved(true)
    setSessionWordCount(c => c + 1)
    notifyWordSaved()

    // A word saved with nothing to translate into is saved as it is. The old
    // line here was `nativeLanguage !== language ? nativeLanguage : 'en'` — the
    // exact 'en' fallback `useTargetLanguage` was rewritten to delete, because
    // it turns "there is no translation to make" into "translate English into
    // English". QA read the result off a real card: `lucius → Lucius`. The
    // reader is still learning the word; the app just has no second language to
    // show it in yet, and saying so by omission is honest.
    const targetLang = nativeLanguage !== textLanguage ? nativeLanguage : null
    if (!targetLang) return

    // cachedTranslate (not translationApi) so this reuses the gloss the
    // selection toolbar just fetched for the same word — no 2nd round-trip.
    const bookId = (editionIdRef ?? userBookIdRef)?.current || undefined
    cachedTranslate(sourceText, textLanguage, targetLang, { sentence, bookId })
      .then(({ translation }) => {
        if (translation && saved.id) {
          vocabularyApi.updateWord(saved.id, { translation }).catch(() => {})
          vocabMapRef.current[key] = { ...vocabMapRef.current[key], translation }
          // Push full map so the inline-translation span renders above the underline.
          // addVocabWord alone only carries {stage}, wiping any prior translation.
          injectJs(vocabPaintJs(vocabMapRef.current))
        }
      })
      .catch(() => {})
  }, [vocabMapRef, injectJs, bumpVocab, setWordSaved, setSessionWordCount, notifyWordSaved, textLanguage, nativeLanguage, editionIdRef, userBookIdRef])

  // In-flight guard for manual saves. Mirrors autoSavedRef but persists
  // across calls within the hook so a rapid double-tap on the toolbar's
  // Save button can't fire two POSTs. Each entry is removed in finally();
  // the chapter-change effect below also clears the whole Set as a safety
  // net so a stuck entry (e.g. abandoned tab on cellular drop) can't
  // permanently block re-saving that word in a later chapter.
  const savingRef = useRef<Set<string>>(new Set())
  // TR-1: the selection behind the open lookup notice — "Add anyway" glosses with ITS text
  // and sentence, so it hits the toolbar's translate cache entry instead of a 2nd call.
  const lookupSelectionRef = useRef<Selection | null>(null)
  useEffect(() => {
    savingRef.current.clear()
  }, [chapter?.id])

  const saveWord = useCallback(async (selection: Selection) => {
    if (!isAuthenticated) return
    const keyLc = selection.text.toLowerCase()
    // Race guard — wordSaved flag flips only after the response lands, so
    // taps during the round-trip would otherwise re-POST.
    if (savingRef.current.has(keyLc)) return
    savingRef.current.add(keyLc)
    try {
      const resp = await saveWordWithRetry({
        word: selection.text,
        language: textLanguage,
        nativeLanguage,
        sentence: selection.sentence || null,
        bookTitle: bookTitleRef.current || null,
        ...bookFields(),
      })
      if (resp.outcome === 'pending') {
        showToast({ message: t(language, 'reader.vocab.queuedForTomorrow'), variant: 'info' })
        // Close the toolbar so the user knows the action landed even
        // though nothing visible changed in the text.
        setSelection(null)
        return
      }
      if (resp.outcome === 'lookup' || resp.outcome === 'lookup_pending') {
        if (resp.lookupId) {
          lookupSelectionRef.current = selection
          setLookupState({ kind: resp.outcome, id: resp.lookupId, tapsRemaining: resp.tapsRemaining, busy: false })
        }
        return
      }
      if (resp.outcome === 'already_saved') {
        // Toolbar would otherwise stay open forever after a re-tap on an
        // already-saved word — user perceives this as "save broken".
        setSelection(null)
        return
      }
      const saved = resp.word
      if (!saved) return
      onWordSaved(saved, selection.text, selection.sentence)
      // Keep the toolbar OPEN after a manual save: in the peek-on-tap model the
      // save is explicit, so the user should see the saved state (stage badge)
      // and be able to immediately undo an accidental save via Remove. The ✕
      // closes it. (Auto-close made the new Remove affordance unreachable.)
    } catch (e) {
      console.warn('Save word failed:', e)
      showToast({ message: 'Could not save word. Try again.', variant: 'error' })
    } finally {
      savingRef.current.delete(keyLc)
    }
  }, [isAuthenticated, language, textLanguage, bookTitleRef, editionIdRef, userBookIdRef, chapter, showToast, setLookupState, setSelection, onWordSaved])

  /**
   * "Add to SRS anyway" on the rare-word notice: promotes the WordLookup row
   * into a VocabularyWord (bypasses the frequency filter) and runs the normal
   * post-save flow so the word is underlined + translated. Web parity:
   * ReaderHighlights.handleAddAnyway.
   */
  const addAnyway = useCallback(async (lookup: LookupState) => {
    if (lookup.busy) return
    setLookupState({ ...lookup, busy: true })
    try {
      const saved = await vocabularyApi.promoteLookup(lookup.id)
      setLookupState(null)
      const sel = lookupSelectionRef.current
      onWordSaved(saved, sel?.text ?? saved.word, sel ? sel.sentence : saved.sentence)
      setSelection(null)
      showToast({ message: t(language, 'reader.vocab.addedToSrs'), variant: 'success' })
    } catch (e) {
      console.warn('Promote lookup failed:', e)
      setLookupState({ ...lookup, busy: false })
      showToast({ message: t(language, 'reader.vocab.addAnywayFailed'), variant: 'error' })
    }
  }, [setLookupState, setSelection, onWordSaved, showToast, language])

  const markKnown = useCallback(async (selection: Selection) => {
    if (!isAuthenticated) return
    const key = selection.text.toLowerCase()
    const entry = vocabMapRef.current[key]
    if (!entry) return
    try {
      await vocabularyApi.markAsKnown(entry.id)
      vocabMapRef.current[key] = { ...entry, stage: 4 }
      injectJs(`addVocabWord(${JSON.stringify(key)}, 4)`)
      bumpVocab()
      setSelection(null)
    } catch (e) {
      console.warn('Mark as known failed:', e)
      showToast({ message: 'Could not mark as known. Try again.', variant: 'error' })
    }
  }, [isAuthenticated, vocabMapRef, injectJs, bumpVocab, setSelection, showToast])

  /**
   * B-79 web-parity: optimistic remove. We drop the word locally and re-mark
   * the WebView map immediately. On network failure the snapshot is restored.
   * markVocabWords re-renders from scratch — no dedicated removeVocabWord.
   */
  const removeWord = useCallback(async (selection: Selection) => {
    if (!isAuthenticated) return
    const key = selection.text.toLowerCase()
    const entry = vocabMapRef.current[key]
    if (!entry) return
    const snapshot = { ...entry }
    delete vocabMapRef.current[key]
    injectJs(vocabPaintJs(vocabMapRef.current))
    bumpVocab()
    setWordSaved(false)
    try {
      await vocabularyApi.deleteWord(entry.id)
      setSelection(null)
    } catch (e) {
      console.warn('Remove word failed:', e)
      vocabMapRef.current[key] = snapshot
      injectJs(vocabPaintJs(vocabMapRef.current))
      bumpVocab()
      setWordSaved(true)
      showToast({ message: 'Could not remove word. Try again.', variant: 'error' })
    }
  }, [isAuthenticated, vocabMapRef, injectJs, bumpVocab, setWordSaved, setSelection, showToast])

  return { saveWord, addAnyway, markKnown, removeWord }
}
