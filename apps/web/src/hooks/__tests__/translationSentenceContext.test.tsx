import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  const hook = renderHook(
    ({ lang, bubble = initial }: { lang: string; bubble?: BubbleLike }) => {
      const abortRef = useRef<AbortController | null>(null)
      return useBubbleTranslationSync<BubbleLike>({
        bubble, setBubble: vi.fn(), vocabMap, updateTranslation,
        targetLang: lang, bookLanguage: 'en', abortRef,
      })
    },
    { initialProps: { lang: 'pt' } as { lang: string; bubble?: BubbleLike } },
  )
  return { ...hook, updateTranslation }
}

describe('TR-1: web translate calls carry the tapped sentence', () => {
  it('TR-1: selection toolbar translates and caches with the sentence, also after a language switch', async () => {
    const shell = readFileSync(resolve(__dirname, '../../components/reader/ReaderHighlights.tsx'), 'utf8')
    expect(shell).toMatch(/translationPopup\.open\(selection\.text, selection\.rect, \{ sentence/)

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

  it('TR-3: the word popup offers "Use this translation" only for a non-switched translation in the native language', () => {
    const shell = readFileSync(resolve(__dirname, '../../components/reader/ReaderHighlights.tsx'), 'utf8')
    expect(shell).toContain('savedTranslationOffer(entry.translation, bubble.langSwitched ? null : bubble.translation, bubble.translationLang, nativeLanguage)')
  })

  it('TR-2: no bubble path PATCHes on its own — all go through updateTranslation', () => {
    for (const f of ['../useWordBubble.ts', '../useBubbleTranslationSync.ts', '../../lib/wordBubbleFetch.ts']) {
      expect(readFileSync(resolve(__dirname, f), 'utf8')).not.toMatch(/updateWord\(/)
    }
  })
})
