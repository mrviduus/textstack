import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'

// QA-007: "pocketed" → "enterrado" (buried). The server disambiguates a word by
// the sentence it sits in — every web translate path must send that sentence,
// and the cache must not serve one sentence's sense for another.

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

import { useTextTranslation } from '../useTextTranslation'
import { useTranslationPopup } from '../useTranslationPopup'
import { useBubbleTranslationSync, type BubbleLike } from '../useBubbleTranslationSync'

const SENTENCE = 'He pocketed the coins and walked out.'
const ctx = { sentence: SENTENCE, bookId: 'book-1' }

beforeEach(() => {
  translate.mockClear()
  updateWord.mockClear()
  getCachedTranslation.mockClear()
  cacheTranslation.mockClear()
})

describe('translate sentence context (web)', () => {
  it('useTextTranslation_WithContext_SendsSentenceAndKeysCacheBySentence', async () => {
    const { result } = renderHook(() => useTextTranslation({ defaultSourceLang: 'en', defaultTargetLang: 'pt' }))

    await act(async () => { await result.current.translate('pocketed the coins', 'en', 'pt', ctx) })

    expect(translate).toHaveBeenCalledWith('pocketed the coins', 'en', 'pt', undefined, ctx)
    expect(getCachedTranslation).toHaveBeenCalledWith('en', 'pt', 'pocketed the coins', SENTENCE, 'book-1')
    expect(cacheTranslation).toHaveBeenCalledWith('en', 'pt', 'pocketed the coins', 'embolsou', SENTENCE, 'book-1')
  })

  it('useTranslationPopup_TargetLangChange_ResendsSentenceItWasOpenedWith', async () => {
    const { result } = renderHook(() => useTranslationPopup({ bookLanguage: 'en', targetLang: 'pt' }))

    await act(async () => { result.current.open('pocketed the coins', null, ctx) })
    expect(translate).toHaveBeenLastCalledWith('pocketed the coins', 'en', 'pt', undefined, ctx)

    await act(async () => { result.current.setTargetLang('uk') })
    expect(translate).toHaveBeenLastCalledWith('pocketed the coins', 'en', 'uk', undefined, ctx)
  })

  it('useBubbleTranslationSync_LangSwitch_RefetchKeepsBubbleSentence', async () => {
    type B = BubbleLike
    const bubble: B = { word: 'pocketed', translation: 'embolsou', translationLoading: false, ...ctx }
    const { rerender } = renderHook(
      ({ lang }: { lang: string }) => {
        const abortRef = useRef<AbortController | null>(null)
        return useBubbleTranslationSync<B>({
          bubble, setBubble: vi.fn(), vocabMap: new Map(), updateTranslation: vi.fn(),
          targetLang: lang, bookLanguage: 'en', abortRef,
        })
      },
      { initialProps: { lang: 'pt' } },
    )

    await act(async () => { rerender({ lang: 'uk' }) })

    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0][0]).toBe('pocketed')
    expect(translate.mock.calls[0][2]).toBe('uk')
    expect(translate.mock.calls[0][4]).toEqual(ctx)
  })
})

// Review r7 of #780: a saved word's translation is written at save time (with its sentence)
// and by the gloss backfill — never by a bubble opened on it later, in any sentence or language.
describe('bubble never writes onto an already-saved word', () => {
  type Entry = { stage: number; id?: string; translation?: string; sentence?: string; isPending?: boolean }

  function mountSync(entry: Entry | null, bubbleTranslation: string | null = null) {
    const updateTranslation = vi.fn()
    const hook = renderHook(
      ({ lang, map, b }: { lang: string; map: Map<string, Entry>; b: BubbleLike }) => {
        const abortRef = useRef<AbortController | null>(null)
        return useBubbleTranslationSync<BubbleLike>({
          bubble: b, setBubble: vi.fn(), vocabMap: map, updateTranslation,
          targetLang: lang, bookLanguage: 'en', abortRef,
        })
      },
      {
        initialProps: {
          lang: 'pt',
          map: new Map(entry ? [['pocketed', entry]] : []),
          b: { word: 'pocketed', translation: bubbleTranslation, translationLoading: false, ...ctx } as BubbleLike,
        },
      },
    )
    return { ...hook, updateTranslation }
  }

  it('BubbleOpen_SavedWordOtherSentence_NoPatch', async () => {
    const { updateTranslation } = mountSync({ stage: 1, id: 'w1', translation: 'enterrou', sentence: 'She pocketed the letter.' }, 'embolsou')
    await act(async () => {})

    expect(updateWord).not.toHaveBeenCalled()
    expect(updateTranslation).not.toHaveBeenCalled()
  })

  it('BubbleOpen_SavedWordWithoutTranslation_NoPatch', async () => {
    mountSync({ stage: 1, id: 'w1' }, 'embolsou')
    await act(async () => {})

    expect(updateWord).not.toHaveBeenCalled()
  })

  it('LangSwitch_SavedWord_RefetchesForDisplayOnly', async () => {
    const { rerender, updateTranslation } = mountSync({ stage: 1, id: 'w1', translation: 'enterrou' }, 'embolsou')
    await act(async () => {
      rerender({ lang: 'uk', map: new Map([['pocketed', { stage: 1, id: 'w1', translation: 'enterrou' }]]), b: { word: 'pocketed', translation: 'embolsou', translationLoading: false, ...ctx } })
    })

    expect(translate).toHaveBeenCalledTimes(1)
    expect(updateWord).not.toHaveBeenCalled()
    expect(updateTranslation).not.toHaveBeenCalled()
  })

  it('AutoSaveThenTranslationArrives_JustSavedWord_PatchedOnce', async () => {
    const b: BubbleLike = { word: 'pocketed', translation: 'embolsou', translationLoading: false, ...ctx }
    const { result, rerender, updateTranslation } = mountSync(null, 'embolsou')
    act(() => { result.current.triggerAutoSave('pocketed', () => Promise.resolve()) })
    const saved = new Map([['pocketed', { stage: 0, id: 'w1' } as Entry]])
    await act(async () => { rerender({ lang: 'pt', map: saved, b }) })
    await act(async () => { rerender({ lang: 'pt', map: new Map(saved), b }) })

    expect(updateWord).toHaveBeenCalledTimes(1)
    expect(updateWord).toHaveBeenCalledWith('w1', { translation: 'embolsou' })
    expect(updateTranslation).toHaveBeenCalledWith('pocketed', 'embolsou')
  })
})
