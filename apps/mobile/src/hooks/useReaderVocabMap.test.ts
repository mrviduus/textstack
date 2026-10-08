// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '../test/renderHook'

const api = vi.hoisted(() => ({ getReaderVocab: vi.fn(), updateWord: vi.fn() }))
const cachedTranslate = vi.hoisted(() => vi.fn())
vi.mock('@textstack/shared', () => ({ vocabularyApi: api }))
vi.mock('../lib/readerOfflineCache', () => ({ vocabMapCache: { get: async () => null, set: async () => {} } }))
vi.mock('../lib/translateCache', () => ({ cachedTranslate }))
vi.mock('../lib/vocabPaintJs', () => ({ vocabPaintJs: () => '' }))

import { useReaderVocabMap } from './useReaderVocabMap'

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })

beforeEach(() => {
  api.getReaderVocab.mockReset()
  api.updateWord.mockReset().mockResolvedValue({})
  cachedTranslate.mockReset().mockResolvedValue({ translation: 'embolsou' })
})

const mount = () => renderHook(useReaderVocabMap, {
  user: { id: 'u1' }, isAuthenticated: true, chapterId: 'c1', injectJs: () => {},
  bookLanguage: 'en', nativeLanguage: 'pt',
})

describe('useReaderVocabMap gloss backfill', () => {
  // QA-007: the backfill translated the bare word, so a saved word could get
  // another sense than the one in the sentence it was saved from.
  it('backfill_WordWithStoredSentence_TranslatesInThatSentence', async () => {
    const sentence = 'He pocketed the coins and walked out.'
    api.getReaderVocab.mockResolvedValue([{ id: 'w1', word: 'Pocketed', stage: 1, sentence }])

    mount()
    await flush()

    expect(cachedTranslate).toHaveBeenCalledWith('pocketed', 'en', 'pt', { sentence })
    expect(api.updateWord).toHaveBeenCalledWith('w1', { translation: 'embolsou' })
  })

  it('backfill_NoStoredSentence_StillTranslates', async () => {
    api.getReaderVocab.mockResolvedValue([{ id: 'w1', word: 'pocketed', stage: 1 }])

    mount()
    await flush()

    expect(cachedTranslate).toHaveBeenCalledWith('pocketed', 'en', 'pt', { sentence: undefined })
  })

  it('backfill_WordAlreadyTranslated_NotRequested', async () => {
    api.getReaderVocab.mockResolvedValue([{ id: 'w1', word: 'pocketed', stage: 1, translation: 'embolsou' }])

    mount()
    await flush()

    expect(cachedTranslate).not.toHaveBeenCalled()
  })
})
