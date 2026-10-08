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

const mount = (nativeLanguage = 'pt') => renderHook(useReaderVocabMap, {
  user: { id: 'u1' }, isAuthenticated: true, chapterId: 'c1', injectJs: () => {},
  bookLanguage: 'en', nativeLanguage, bookId: 'book-1',
})

const SENTENCE = 'He pocketed the coins and walked out.'
/** The server: a sentence only when asked for (`includeSentences`). */
const serve = (word: Record<string, unknown>) =>
  api.getReaderVocab.mockImplementation(async (opts?: { includeSentences?: boolean }) =>
    [{ id: 'w1', word: 'Pocketed', stage: 1, ...word, ...(opts?.includeSentences ? { sentence: SENTENCE } : {}) }])

describe('useReaderVocabMap gloss backfill', () => {
  // Review r4 of #780: the backfill fetches its own sentences (the main load carries none)
  // and translates in the stored sentence + the book — never the bare word when there is one.
  it('backfill_ServerHasSentence_NeverTranslatesWithoutIt', async () => {
    serve({})

    mount()
    await flush()

    expect(api.getReaderVocab).toHaveBeenCalledWith({ includeSentences: true })
    expect(cachedTranslate).toHaveBeenCalledTimes(1)
    expect(cachedTranslate).toHaveBeenCalledWith('pocketed', 'en', 'pt', { sentence: SENTENCE, bookId: 'book-1' })
    expect(api.updateWord).toHaveBeenCalledWith('w1', { translation: 'embolsou' })
  })

  it('backfill_SentenceFetchFails_NoTranslationUntilItRuns', async () => {
    api.getReaderVocab.mockImplementation(async (opts?: { includeSentences?: boolean }) => {
      if (opts?.includeSentences) throw new Error('offline')
      return [{ id: 'w1', word: 'pocketed', stage: 1 }]
    })

    const { result } = mount()
    await flush()
    expect(cachedTranslate).not.toHaveBeenCalled()

    // Not marked done: the next map change runs it, with the sentence.
    serve({})
    await act(async () => { result.current.bumpVocab() })
    await flush()
    expect(cachedTranslate).toHaveBeenCalledWith('pocketed', 'en', 'pt', { sentence: SENTENCE, bookId: 'book-1' })
  })

  it('backfill_WordAlreadyTranslated_NotRequested', async () => {
    serve({ translation: 'embolsou' })

    mount()
    await flush()

    expect(cachedTranslate).not.toHaveBeenCalled()
    expect(api.getReaderVocab).not.toHaveBeenCalledWith({ includeSentences: true })
  })

  it('backfill_DefinitionMode_NothingFetchedOrTranslated', async () => {
    serve({})

    mount('en')
    await flush()

    expect(api.getReaderVocab).not.toHaveBeenCalledWith({ includeSentences: true })
    expect(cachedTranslate).not.toHaveBeenCalled()
  })

  // Review r4 of #780: the main load does not depend on the native language — a change used
  // to refetch and replace the map, wiping words saved since.
  it('load_NativeLanguageChange_NoRefetchSavedEntrySurvives', async () => {
    serve({ translation: 'embolsou' })
    const { result, rerender } = mount('pt')
    await flush()
    result.current.vocabMapRef.current.coins = { stage: 0, id: 'w2', translation: 'moedas' }

    rerender({ nativeLanguage: 'uk' })
    await flush()

    expect(api.getReaderVocab).toHaveBeenCalledTimes(1)
    expect(api.getReaderVocab).toHaveBeenCalledWith()
    expect(result.current.vocabMapRef.current.coins?.id).toBe('w2')
  })
})
