import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { translate as translateApi } from '../api/translation'
import { normalizeVocabKey } from '../lib/vocabKey'
import type { VocabMap } from './useReaderVocabulary'

// Shared bubble shape. Callers extend this with their own extras (rect, range,
// definition, …).
export interface BubbleLike {
  word: string
  translation: string | null
  translationLoading: boolean
  /** TR-1: the tapped sentence + book, resent on a language-switch refetch. */
  sentence?: string
  bookId?: string
  /** TR-3: the language `translation` was fetched in, and whether it came from a mid-popup switch
   *  (display-only) — "Use this translation" is offered for neither a foreign nor a switched one. */
  translationLang?: string | null
  langSwitched?: boolean
}

interface Options<B extends BubbleLike> {
  bubble: B | null
  setBubble: Dispatch<SetStateAction<B | null>>
  vocabMap: VocabMap
  updateTranslation: (word: string, translation: string) => void
  targetLang: string | null
  bookLanguage: string
  abortRef: MutableRefObject<AbortController | null>
}

/**
 * Two concerns shared by both readers:
 *
 * 1. **Backend translation patch** — the ONE caller for the bubble's translation
 *    (fetch, language switch, auto-save landing). Watches `bubble.translation` +
 *    current `vocabMap` and hands the translation to `updateTranslation`, which fills an
 *    untranslated saved word and never changes an existing translation (TR-2).
 *
 * 2. **Mid-popup lang switch**: when the user opens the popup's language picker
 *    and chooses a different native language, `targetLang` changes while the
 *    same word is visible. Refetch translation in place instead of forcing the
 *    user to re-open the popup. Definition stays (always in book language).
 *
 * Returns `autoSavedRef` so consumers can dedup their own auto-save triggers
 * synchronously (vocabMap state commit lags a render; a ref Set seals rapid
 * re-tap races).
 */
export function useBubbleTranslationSync<B extends BubbleLike>({
  bubble,
  setBubble,
  vocabMap,
  updateTranslation,
  targetLang,
  bookLanguage,
  abortRef,
}: Options<B>) {
  const autoSavedRef = useRef<Set<string>>(new Set())

  // The (word, sentence) whose language was switched mid-popup: that translation is display-only
  // (TR-2). Tied to the sentence so a re-opened bubble / new sentence is a fresh tap again.
  const langSwitchedRef = useRef<{ word: string; sentence?: string } | null>(null)

  // (1) Backend translation patch.
  useEffect(() => {
    const word = bubble?.word
    const translation = bubble?.translation
    if (!word || !translation) return
    // TR-2: a language-switched translation is display-only, even for an untranslated word.
    const sw = langSwitchedRef.current
    if (sw?.word === word && sw.sentence === bubble?.sentence) return
    updateTranslation(word, translation)
  }, [bubble?.word, bubble?.translation, bubble?.sentence, vocabMap, updateTranslation])

  // (2) Lang-picker mid-popup refetch. Track (word, lang) pair — word changes
  // are owned by the openBubble path, this effect only fires on lang flips for
  // the same word. Stored as a tuple ref instead of a `word::lang` string so
  // words containing `::` don't break the parse.
  const lastPairRef = useRef<{ word: string; lang: string | null } | null>(null)

  useEffect(() => {
    const word = bubble?.word
    if (!word) {
      lastPairRef.current = null
      langSwitchedRef.current = null
      return
    }

    const prev = lastPairRef.current
    if (prev === null) {
      // Initial open — openBubble already kicked off the fetch. Just record.
      lastPairRef.current = { word, lang: targetLang }
      return
    }
    if (prev.word === word && prev.lang === targetLang) return

    lastPairRef.current = { word, lang: targetLang }
    // Word changed → openBubble owns the fetch.
    const switched = prev.word === word
    langSwitchedRef.current = switched ? { word, sentence: bubble?.sentence } : null
    if (prev.word !== word) return

    // Same word, lang flipped. Definition-mode switch (no targetLang) → clear translation.
    if (!targetLang) {
      setBubble((b) =>
        b && b.word === word ? { ...b, translation: null, translationLoading: false } : b,
      )
      return
    }

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setBubble((b) =>
      b && b.word === word ? { ...b, translation: null, translationLoading: true, translationLang: targetLang, langSwitched: switched } : b,
    )

    translateApi(word, bookLanguage, targetLang, ctrl.signal, { sentence: bubble?.sentence, bookId: bubble?.bookId })
      .then((res) => {
        if (ctrl.signal.aborted) return
        const translated = res?.translatedText ?? null
        setBubble((b) =>
          b && b.word === word
            ? { ...b, translation: translated, translationLoading: false }
            : b,
        )
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return
        if ((err as { name?: string })?.name === 'AbortError') return
        setBubble((b) => (b && b.word === word ? { ...b, translationLoading: false } : b))
      })
  }, [bubble?.word, bubble?.sentence, bubble?.bookId, targetLang, bookLanguage, updateTranslation, setBubble, abortRef])

  const triggerAutoSave = useCallback(
    (word: string, save: () => Promise<unknown>) => {
      const key = normalizeVocabKey(word)
      if (vocabMap.has(key) || autoSavedRef.current.has(key)) return
      autoSavedRef.current.add(key)
      save().catch(() => {
        autoSavedRef.current.delete(key)
      })
    },
    [vocabMap],
  )

  const clearAutoSave = useCallback((word: string) => {
    autoSavedRef.current.delete(normalizeVocabKey(word))
  }, [])

  return { triggerAutoSave, clearAutoSave }
}
