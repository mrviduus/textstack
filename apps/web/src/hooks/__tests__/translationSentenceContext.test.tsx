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

// Review of #780: a saved word's translation is the sense of the sentence it was
// saved in. A bubble opened on that word in ANOTHER sentence (or a language switch
// there) must not overwrite it with the other sense. Unknown stored sentence (the
// server ships none for a word that has a translation) → write, as before #780.
describe('saved-word translation is not overwritten from another sentence', () => {
  type Entry = { stage: number; id?: string; translation?: string; sentence?: string; isPending?: boolean }

  function mountSync(entry: Entry, bubbleTranslation: string | null = null) {
    const bubble: BubbleLike = { word: 'pocketed', translation: bubbleTranslation, translationLoading: false, ...ctx }
    const vocabMap = new Map([['pocketed', entry]])
    const updateTranslation = vi.fn()
    const hook = renderHook(
      ({ lang }: { lang: string }) => {
        const abortRef = useRef<AbortController | null>(null)
        return useBubbleTranslationSync<BubbleLike>({
          bubble, setBubble: vi.fn(), vocabMap, updateTranslation,
          targetLang: lang, bookLanguage: 'en', abortRef,
        })
      },
      { initialProps: { lang: 'pt' } },
    )
    return { ...hook, updateTranslation }
  }

  it('LangSwitch_SavedInOtherSentence_TranslationNotOverwritten', async () => {
    const { rerender, updateTranslation } = mountSync({ stage: 1, id: 'w1', translation: 'enterrou', sentence: 'She pocketed the letter.' })
    await act(async () => { rerender({ lang: 'uk' }) })

    expect(translate).toHaveBeenCalledTimes(1)
    expect(updateWord).not.toHaveBeenCalled()
    expect(updateTranslation).not.toHaveBeenCalled()
  })

  it('LangSwitch_SavedInSameSentence_TranslationUpdated', async () => {
    const { rerender } = mountSync({ stage: 1, id: 'w1', translation: 'embolsou', sentence: `  ${SENTENCE} ` })
    await act(async () => { rerender({ lang: 'uk' }) })

    expect(updateWord).toHaveBeenCalledWith('w1', { translation: 'embolsou' })
  })

  it('LangSwitch_UnknownSentenceEmptyTranslation_Filled', async () => {
    const { rerender } = mountSync({ stage: 1, id: 'w1' })
    await act(async () => { rerender({ lang: 'uk' }) })

    expect(updateWord).toHaveBeenCalledWith('w1', { translation: 'embolsou' })
  })

  it('LangSwitch_UnknownSentenceHasTranslation_Updated', async () => {
    const { rerender, updateTranslation } = mountSync({ stage: 1, id: 'w1', translation: 'enterrou' })
    await act(async () => { rerender({ lang: 'uk' }) })

    expect(updateWord).toHaveBeenCalledWith('w1', { translation: 'embolsou' })
    expect(updateTranslation).toHaveBeenCalledWith('pocketed', 'embolsou')
  })

  it('BubbleOpen_SavedInOtherSentence_NoPatch', async () => {
    mountSync({ stage: 1, id: 'w1', translation: 'enterrou', sentence: 'She pocketed the letter.' }, 'embolsou')
    await act(async () => {})

    expect(updateWord).not.toHaveBeenCalled()
  })

  it('BubbleOpen_JustSavedInThisSentence_Patched', async () => {
    mountSync({ stage: 0, id: 'w1', sentence: SENTENCE }, 'embolsou')
    await act(async () => {})

    expect(updateWord).toHaveBeenCalledWith('w1', { translation: 'embolsou' })
  })
})

describe('fetchWordBubble caption write', () => {
  async function open(entry: { stage: number; id?: string; translation?: string; sentence?: string }) {
    const { fetchWordBubble } = await import('../../lib/wordBubbleFetch')
    const updateTranslation = vi.fn()
    fetchWordBubble({
      word: 'pocketed', bookLanguage: 'en', targetLang: 'pt', explainInContext: false,
      vocabMap: new Map([['pocketed', entry]]), updateTranslation,
      signal: new AbortController().signal, patch: vi.fn(), ...ctx,
    })
    await act(async () => {})
    return updateTranslation
  }

  it('fetchWordBubble_ServerLoadedWordNoSentence_CaptionUpdated', async () => {
    expect(await open({ stage: 1, id: 'w1', translation: 'enterrou' })).toHaveBeenCalledWith('pocketed', 'embolsou')
  })

  it('fetchWordBubble_SavedInOtherSentence_CaptionKept', async () => {
    expect(await open({ stage: 1, id: 'w1', translation: 'enterrou', sentence: 'She pocketed the letter.' })).not.toHaveBeenCalled()
  })
})
