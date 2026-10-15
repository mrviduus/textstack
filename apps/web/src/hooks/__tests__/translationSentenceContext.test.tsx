import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'

const getCachedTranslation = vi.fn((..._a: unknown[]) => Promise.resolve(null))
const cacheTranslation = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock('../../lib/offlineDb', () => ({
  getCachedTranslation: (...a: unknown[]) => getCachedTranslation(...a),
  cacheTranslation: (...a: unknown[]) => cacheTranslation(...a),
  clearOldTranslations: vi.fn(() => Promise.resolve()),
}))
const translate = vi.fn((..._a: unknown[]) => Promise.resolve({ translatedText: 'embolsou', sourceLang: 'en', targetLang: 'pt' }))
vi.mock('../../api/translation', () => ({
  translate: (...a: unknown[]) => translate(...a),
  getLanguages: vi.fn(),
}))
const updateWord = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock('../../api/vocabulary', () => ({ updateWord: (...a: unknown[]) => updateWord(...a) }))

import { useTranslationPopup } from '../useTranslationPopup'
import { useBubbleTranslationSync, type BubbleLike } from '../useBubbleTranslationSync'
import type { VocabMap } from '../useReaderVocabulary'

const SENTENCE = 'He pocketed the coins and walked out.'
const ctx = { sentence: SENTENCE, bookId: 'book-1' }

beforeEach(() => {
  translate.mockClear()
  updateWord.mockClear()
  getCachedTranslation.mockClear()
  cacheTranslation.mockClear()
})

function mountSync(vocabMap: VocabMap, initial: BubbleLike) {
  const updateTranslation = vi.fn()
  const setBubble = vi.fn()
  const hook = renderHook(
    ({ lang, bubble = initial }: { lang: string; bubble?: BubbleLike }) => {
      const abortRef = useRef<AbortController | null>(null)
      return useBubbleTranslationSync<BubbleLike>({
        bubble, setBubble, vocabMap, updateTranslation,
        targetLang: lang, bookLanguage: 'en', abortRef,
      })
    },
    { initialProps: { lang: 'pt' } as { lang: string; bubble?: BubbleLike } },
  )
  return { ...hook, updateTranslation, setBubble }
}

describe('TR-1: web translate calls carry the tapped sentence', () => {
  // ReaderHighlights passing the selection's sentence to the popup is asserted by rendering it:
  // ReaderHighlights.engine.test.tsx `…TranslateCarriesTheSentence`.
  it('TR-1: selection toolbar translates and caches with the sentence, also after a language switch', async () => {
    const { result } = renderHook(() => useTranslationPopup({ bookLanguage: 'en', targetLang: 'pt' }))
    await act(async () => { result.current.open('pocketed', null, ctx) })
    expect(translate).toHaveBeenLastCalledWith('pocketed', 'en', 'pt', undefined, ctx)
    expect(getCachedTranslation).toHaveBeenCalledWith('en', 'pt', 'pocketed', ctx)
    expect(cacheTranslation).toHaveBeenCalledWith('en', 'pt', 'pocketed', 'embolsou', ctx)

    await act(async () => { result.current.setTargetLang('uk') })
    expect(translate).toHaveBeenLastCalledWith('pocketed', 'en', 'uk', undefined, ctx)
  })

  it('TR-1: word bubble language switch refetches with the bubble sentence', async () => {
    const { rerender } = mountSync(new Map(), { word: 'pocketed', translation: 'embolsou', translationLoading: false, ...ctx })

    await act(async () => { rerender({ lang: 'uk' }) })

    expect(translate).toHaveBeenCalledWith('pocketed', 'en', 'uk', expect.anything(), ctx)
  })
})

describe('TR-2: the word bubble never overwrites a saved translation', () => {
  const saved = (): VocabMap => new Map([['pocketed', { stage: 1, id: 'w1', translation: 'enterrou' }]])

  it('TR-2: tap in another sentence or a language switch sends no PATCH for a translated word', async () => {
    const { rerender } = mountSync(saved(), { word: 'pocketed', translation: 'embolsou', translationLoading: false, ...ctx })
    await act(async () => {})
    await act(async () => { rerender({ lang: 'uk' }) })

    expect(translate).toHaveBeenCalledTimes(1)
    // The guard lives in ONE place — useReaderVocabulary.updateTranslation (tested there).
    expect(updateWord).not.toHaveBeenCalled()
  })

  it('TR-2: a tapped translation reaches updateTranslation (fill-if-empty), a language-switched one never does', async () => {
    const b = { word: 'pocketed', translation: 'embolsou', translationLoading: false, ...ctx }
    const { rerender, updateTranslation } = mountSync(saved(), b)
    await act(async () => {})
    expect(updateTranslation).toHaveBeenLastCalledWith('pocketed', 'embolsou')

    updateTranslation.mockClear()
    await act(async () => { rerender({ lang: 'uk' }) })
    await act(async () => { rerender({ lang: 'uk', bubble: { ...b, translation: 'поклав' } }) })
    expect(updateTranslation).not.toHaveBeenCalled()
  })

  it('TR-2: a language switch stops covering the bubble once it shows a new sentence', async () => {
    const b = { word: 'pocketed', translation: 'embolsou', translationLoading: false, ...ctx }
    const { rerender, updateTranslation } = mountSync(saved(), b)
    await act(async () => {})
    await act(async () => { rerender({ lang: 'uk' }) })

    updateTranslation.mockClear()
    const NEW = 'She pocketed the key.'
    await act(async () => { rerender({ lang: 'uk', bubble: { ...b, translation: 'поклав', sentence: NEW } }) })
    expect(updateTranslation).toHaveBeenLastCalledWith('pocketed', 'поклав')
  })

  it('TR-3: a language switch marks the bubble switched, in the new language — so no "Use this translation" offer', async () => {
    // ReaderHighlights offers the saved translation only for `!bubble.langSwitched` in the native
    // language (`savedTranslationOffer`, tested in shared). This is the half that sets the flag.
    const b = { word: 'pocketed', translation: 'embolsou', translationLoading: false, translationLang: 'pt', ...ctx }
    const { rerender, setBubble } = mountSync(saved(), b)
    await act(async () => {})
    expect(setBubble).not.toHaveBeenCalled()

    await act(async () => { rerender({ lang: 'uk' }) })
    const next = setBubble.mock.calls.map(([update]) => update(b)).find((x) => x.langSwitched !== undefined)
    expect(next).toMatchObject({ word: 'pocketed', translationLang: 'uk', langSwitched: true })
  })
})
