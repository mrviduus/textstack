import { useCallback, useEffect, useRef, useState } from 'react'
import { vocabularyApi } from '@textstack/shared'
import { vocabMapCache } from '../lib/readerOfflineCache'
import { cachedTranslate } from '../lib/translateCache'
import { vocabPaintJs } from '../lib/vocabPaintJs'

/** `sentence`: the one it was saved in, when saved this session (the main load carries none).
 *  Never injected into the WebView (vocabPaintJs). */
export type VocabMapEntry = { stage: number; id: string; translation?: string; sentence?: string }
export type VocabMap = Record<string, VocabMapEntry>

type User = { id: string } | null | undefined

type Options = {
  user: User
  isAuthenticated: boolean
  chapterId: string | null | undefined
  injectJs: (js: string) => void
  /** Source language of the current book — first arg to translationApi.translate. */
  bookLanguage?: string | null
  /** User's native language (target). When null/equal-to-book, backfill is skipped. */
  nativeLanguage?: string | null
  /** editionId or userBookId — sent with the backfill's translations, as the toolbar does. */
  bookId?: string | null
}

/**
 * Owns the per-user vocab-map ref + cache-first load.
 * Save/remove handlers in the reader screen mutate `vocabMapRef.current`
 * directly and call `bumpVocab()` to trigger a debounced re-paint —
 * defends against drift between the ref and the WebView when an inline
 * injectJs call gets skipped (e.g. translation failure path).
 */
export function useReaderVocabMap({
  user,
  isAuthenticated,
  chapterId,
  injectJs,
  bookLanguage,
  nativeLanguage,
  bookId,
}: Options) {
  const vocabMapRef = useRef<VocabMap>({})
  const [vocabVersion, setVocabVersion] = useState(0)
  const bumpVocab = useCallback(() => setVocabVersion(v => v + 1), [])

  // Reactive re-paint on bumpVocab(): debounced 100ms so multiple mutations
  // in a frame (e.g. translation update right after save) coalesce into a
  // single markVocabWords injection. Skip the initial render — the
  // chapter-load effect below already paints once on mount.
  const skipFirstRef = useRef(true)
  useEffect(() => {
    if (skipFirstRef.current) {
      skipFirstRef.current = false
      return
    }
    const t = setTimeout(() => {
      injectJs(vocabPaintJs(vocabMapRef.current))
    }, 100)
    return () => clearTimeout(t)
  }, [vocabVersion, injectJs])

  // 'done' only once the backfill has run with its own sentence data; a failed fetch → 'idle'.
  const backfillStateRef = useRef<'idle' | 'running' | 'done'>('idle')

  // Load + paint vocab underlines. Cache-first so offline nav still shows
  // marks; API refresh overwrites. Keyed off chapterId (not chapter object)
  // so a refetch with the same id doesn't re-trigger.
  useEffect(() => {
    if (!isAuthenticated || !chapterId) return
    let cancelled = false

    const uid = user?.id
    if (uid) {
      vocabMapCache.get(uid).then(cached => {
        if (!cancelled && cached && Object.keys(cached).length > 0) {
          vocabMapRef.current = cached
          injectJs(vocabPaintJs(cached))
          // Bump so the backfill effect sees the populated map.
          bumpVocab()
        }
      })
    }

    vocabularyApi.getReaderVocab()
      .then(words => {
        if (cancelled || words.length === 0) return
        const map: VocabMap = {}
        for (const w of words) map[w.word.toLowerCase()] = { stage: w.stage, id: w.id, translation: w.translation }
        vocabMapRef.current = map
        injectJs(vocabPaintJs(map))
        if (uid) vocabMapCache.set(uid, map)
        // Re-evaluate backfill against the fresh map (API may have
        // returned translations the cache didn't have).
        if (backfillStateRef.current === 'done') backfillStateRef.current = 'idle'
        bumpVocab()
      })
      .catch(() => { /* offline — cache paint already rendered */ })
    return () => { cancelled = true }
  }, [isAuthenticated, chapterId, user?.id, injectJs, bumpVocab])

  // Backfill translations for vocab entries that were saved without one
  // (early-save race, network error mid-translate, or older app version
  // that never set it). Mirrors apps/web/src/hooks/useReaderVocabulary.ts
  // backfill loop — without it, those words underline forever but the
  // gloss above them never appears. Rare, so it fetches its own data — each
  // untranslated word's stored sentence — right before running, and translates
  // in that sentence + this book, so the gloss is the sense the word was saved in.
  useEffect(() => {
    if (!isAuthenticated || !chapterId) return
    if (!bookLanguage || !nativeLanguage || nativeLanguage === bookLanguage) return
    if (backfillStateRef.current !== 'idle') return
    if (!Object.values(vocabMapRef.current).some(e => !e.translation)) return
    backfillStateRef.current = 'running'
    ;(async () => {
      let words: Awaited<ReturnType<typeof vocabularyApi.getReaderVocab>>
      try {
        words = await vocabularyApi.getReaderVocab({ includeSentences: true })
      } catch {
        backfillStateRef.current = 'idle' // never ran — the next bump retries
        return
      }
      backfillStateRef.current = 'done'
      for (const w of words) {
        if (w.translation) continue
        const key = w.word.toLowerCase()
        if (vocabMapRef.current[key]?.translation) continue
        try {
          // cachedTranslate de-dupes against the toolbar/save path and
          // memoizes, so re-opening the chapter is free.
          const { translation } = await cachedTranslate(key, bookLanguage, nativeLanguage, { sentence: w.sentence, bookId })
          if (!translation) continue
          const entry = vocabMapRef.current[key]
          if (entry) vocabMapRef.current[key] = { ...entry, translation }
          // Persist server-side so re-opens skip the round-trip.
          vocabularyApi.updateWord(w.id, { translation }).catch(() => {})
          // Progressive paint: each gloss appears the moment its word
          // resolves, instead of all-at-once after the whole loop (which on
          // a page of N missing words felt like "glosses never show"). The
          // 100ms-debounced paint effect coalesces bursts.
          bumpVocab()
        } catch {
          // Skip a single word's failure — keep going.
        }
      }
    })()
  }, [isAuthenticated, chapterId, bookLanguage, nativeLanguage, bookId, vocabVersion, bumpVocab])

  /** Persist current map to per-user cache. Caller invokes when a selection closes. */
  const flushToCache = () => {
    const uid = user?.id
    if (uid && Object.keys(vocabMapRef.current).length > 0) {
      vocabMapCache.set(uid, vocabMapRef.current)
    }
  }

  return { vocabMapRef, flushToCache, bumpVocab }
}
