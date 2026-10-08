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
vi.mock('../../api/vocabulary', () => ({ updateWord: vi.fn(() => Promise.resolve()) }))

import { useTextTranslation } from '../useTextTranslation'
import { useTranslationPopup } from '../useTranslationPopup'
import { useBubbleTranslationSync, type BubbleLike } from '../useBubbleTranslationSync'

const SENTENCE = 'He pocketed the coins and walked out.'
const ctx = { sentence: SENTENCE, bookId: 'book-1' }

beforeEach(() => {
  translate.mockClear()
  getCachedTranslation.mockClear()
  cacheTranslation.mockClear()
})

describe('translate sentence context (web)', () => {
  it('useTextTranslation_WithContext_SendsSentenceAndKeysCacheBySentence', async () => {
    const { result } = renderHook(() => useTextTranslation({ defaultSourceLang: 'en', defaultTargetLang: 'pt' }))

    await act(async () => { await result.current.translate('pocketed the coins', 'en', 'pt', ctx) })

    expect(translate).toHaveBeenCalledWith('pocketed the coins', 'en', 'pt', undefined, ctx)
    expect(getCachedTranslation).toHaveBeenCalledWith('en', 'pt', 'pocketed the coins', SENTENCE)
    expect(cacheTranslation).toHaveBeenCalledWith('en', 'pt', 'pocketed the coins', 'embolsou', SENTENCE)
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
