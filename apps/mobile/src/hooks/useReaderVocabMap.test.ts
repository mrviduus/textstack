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
/** The server: an untranslated word carries its sentence in the one main load. */
const serve = (word: Record<string, unknown>) =>
  api.getReaderVocab.mockResolvedValue([{ id: 'w1', word: 'Pocketed', stage: 1, sentence: SENTENCE, ...word }])

describe('useReaderVocabMap gloss backfill', () => {
  // Review r5 of #780: one fetch — the backfill translates in the main load's sentence + the book.
  it('backfill_MainLoadHasSentence_TranslatesInItWithoutSecondFetch', async () => {
    serve({})

    mount()
    await flush()

    expect(api.getReaderVocab).toHaveBeenCalledTimes(1)
    expect(cachedTranslate).toHaveBeenCalledTimes(1)
    expect(cachedTranslate).toHaveBeenCalledWith('pocketed', 'en', 'pt', { sentence: SENTENCE, bookId: 'book-1' })
    expect(api.updateWord).toHaveBeenCalledWith('w1', { translation: 'embolsou' })
  })

  it('backfill_WordAlreadyTranslated_NotRequested', async () => {
    serve({ translation: 'embolsou', sentence: undefined })

    mount()
    await flush()

    expect(cachedTranslate).not.toHaveBeenCalled()
  })

  it('backfill_DefinitionMode_NothingTranslated', async () => {
    serve({})

    mount('en')
    await flush()

    expect(cachedTranslate).not.toHaveBeenCalled()
  })

  const twoWords = () => api.getReaderVocab.mockResolvedValue([
    { id: 'w1', word: 'alpha', stage: 1, sentence: 'Alpha here.' },
    { id: 'w2', word: 'beta', stage: 1, sentence: 'Beta here.' },
  ])
  const holdFirstTranslate = () => {
    let release!: () => void
    cachedTranslate.mockImplementationOnce(() => new Promise(r => { release = () => r({ translation: 'a' }) }))
    return () => release()
  }

  // Review r5 of #780: the loop stops on unmount instead of translating for a closed reader.
  it('backfill_UnmountMidLoop_NoFurtherTranslate', async () => {
    twoWords()
    const release = holdFirstTranslate()
    const { unmount } = mount()
    await flush()
    expect(cachedTranslate).toHaveBeenCalledTimes(1)

    unmount()
    release()
    await flush()

    expect(cachedTranslate).toHaveBeenCalledTimes(1)
    expect(api.updateWord).not.toHaveBeenCalled()
  })

  it('backfill_SignOutMidLoop_NoFurtherTranslate', async () => {
    twoWords()
    const release = holdFirstTranslate()
    const { rerender } = mount()
    await flush()

    rerender({ isAuthenticated: false, user: undefined })
    release()
    await flush()

    expect(cachedTranslate).toHaveBeenCalledTimes(1)
  })

  // Review r5 of #780: a word removed while the loop runs is skipped, as on web.
  it('backfill_WordRemovedBeforeItsTurn_Skipped', async () => {
    twoWords()
    const release = holdFirstTranslate()
    const { result } = mount()
    await flush()

    delete result.current.vocabMapRef.current.beta
    release()
    await flush()

    expect(cachedTranslate).toHaveBeenCalledTimes(1)
  })

  // The loop bumps per word; that must not cancel it (an earlier version stopped after one).
  it('backfill_TwoWords_BothTranslated', async () => {
    twoWords()

    mount()
    await flush()

    expect(cachedTranslate).toHaveBeenCalledTimes(2)
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
