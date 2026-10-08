import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { updateWord } from '../api/vocabulary'
import { translate as translateApi } from '../api/translation'
import { normalizeVocabKey } from '../lib/vocabKey'
import type { VocabMap } from './useReaderVocabulary'

// Shared bubble shape. Callers extend this with their own extras (rect, range,
// definition, …).
export interface BubbleLike {
  word: string
  translation: string | null
  translationLoading: boolean
  /** Sentence + book the popup was opened with — resent on a lang-switch refetch. */
  sentence?: string
  bookId?: string
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
 * 1. **Save-time translation**: auto-save fires as the bubble opens, before its
 *    translation arrives. When it does, write it onto the word THIS bubble saved
 *    (in this sentence) — once. A word saved earlier is never written: its
 *    translation is set at save time or by the gloss backfill, nowhere else.
 *
 * 2. **Mid-popup lang switch**: when the user opens the popup's language picker
 *    and chooses a different native language, `targetLang` changes while the
 *    same word is visible. Refetch translation in place for display only — the
 *    saved row is not written. Definition stays (always in book language).
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
  const patchedRef = useRef<Set<string>>(new Set())

  // (1) Save-time translation — only onto a word this bubble saved, only while it has none.
  useEffect(() => {
    const word = bubble?.word
    const translation = bubble?.translation
    if (!word || !translation) return
    const key = normalizeVocabKey(word)
    if (!autoSavedRef.current.has(key)) return
    const entry = vocabMap.get(key)
    if (!entry?.id || entry.isPending || entry.translation) return
    if (patchedRef.current.has(entry.id)) return
    patchedRef.current.add(entry.id)
    updateWord(entry.id, { translation }).catch(() => {})
    updateTranslation(word, translation)
  }, [bubble?.word, bubble?.translation, vocabMap, updateTranslation])

  // (2) Lang-picker mid-popup refetch. Track (word, lang) pair — word changes
  // are owned by the openBubble path, this effect only fires on lang flips for
  // the same word. Stored as a tuple ref instead of a `word::lang` string so
  // words containing `::` don't break the parse.
  const lastPairRef = useRef<{ word: string; lang: string | null } | null>(null)

  useEffect(() => {
    const word = bubble?.word
    if (!word) {
      lastPairRef.current = null
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
      b && b.word === word ? { ...b, translation: null, translationLoading: true } : b,
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
  }, [bubble?.word, bubble?.sentence, bubble?.bookId, targetLang, bookLanguage, setBubble, abortRef])

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
