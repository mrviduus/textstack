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

/**
 * A saved word's translation is the sense of the sentence it was saved in. Write a
 * bubble's translation into it only when that bubble is in the same sentence — or,
 * when the stored sentence is unknown, only to fill an empty translation.
 */
export function mayWriteSavedTranslation(
  entry: { translation?: string; sentence?: string },
  bubbleSentence: string | undefined,
): boolean {
  if (!entry.translation) return true
  return entry.sentence !== undefined && entry.sentence.trim() === (bubbleSentence ?? '').trim()
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
 * 1. **Backend translation patch** after auto-save: `fetchWordBubble`'s built-in
 *    patch closes over `vocabMap` at call time — before auto-save inserts the
 *    entry — so it misses. This effect watches `bubble.translation` + current
 *    `vocabMap` and fires one PATCH per `(wordId, translation)` pair.
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
  const patchedRef = useRef<Set<string>>(new Set())

  // (1) Backend translation patch — once per (wordId, translation).
  useEffect(() => {
    const word = bubble?.word
    const translation = bubble?.translation
    if (!word || !translation) return
    const entry = vocabMap.get(normalizeVocabKey(word))
    if (!entry?.id || entry.isPending) return
    if (!mayWriteSavedTranslation(entry, bubble?.sentence)) return
    const patchKey = `${entry.id}:${translation}`
    if (patchedRef.current.has(patchKey)) return
    patchedRef.current.add(patchKey)
    updateWord(entry.id, { translation }).catch(() => {})
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
        const existing = vocabMap.get(normalizeVocabKey(word))
        if (translated && existing && mayWriteSavedTranslation(existing, bubble?.sentence)) {
          if (existing.id && !existing.isPending) {
            updateWord(existing.id, { translation: translated }).catch(() => {})
          }
          updateTranslation(word, translated)
        }
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return
        if ((err as { name?: string })?.name === 'AbortError') return
        setBubble((b) => (b && b.word === word ? { ...b, translationLoading: false } : b))
      })
  }, [bubble?.word, bubble?.sentence, bubble?.bookId, targetLang, bookLanguage, vocabMap, updateTranslation, setBubble, abortRef])

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
