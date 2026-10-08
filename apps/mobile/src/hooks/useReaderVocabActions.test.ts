// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '../test/renderHook'

const api = vi.hoisted(() => ({ saveWord: vi.fn(), updateWord: vi.fn(), promoteLookup: vi.fn() }))
vi.mock('@textstack/shared', () => ({ vocabularyApi: api, t: (_l: string, k: string) => k }))
const cachedTranslate = vi.hoisted(() => vi.fn(() => new Promise(() => {})))
vi.mock('../lib/translateCache', () => ({ cachedTranslate }))

import { useReaderVocabActions } from './useReaderVocabActions'
import type { VocabMap } from './useReaderVocabMap'

describe('useReaderVocabActions', () => {
  it('TR-1: the save-time gloss translates with the tapped sentence and book', async () => {
    const sentence = 'He pocketed the coins and walked out.'
    api.saveWord.mockResolvedValue({ outcome: 'saved', word: { id: 'w1', word: 'pocketed', stage: 0, sentence: null } })
    const noop = () => {}
    const { result } = renderHook(useReaderVocabActions, {
      vocabMapRef: { current: {} as VocabMap }, bookTitleRef: { current: null }, chapter: null, language: 'en',
      editionIdRef: { current: 'book-1' },
      textLanguage: 'en', nativeLanguage: 'pt', isAuthenticated: true, injectJs: noop, bumpVocab: noop,
      notifyWordSaved: noop, setSessionWordCount: noop, setWordSaved: noop, setSelection: noop,
      setLookupState: noop, showToast: noop,
    } as unknown as Parameters<typeof useReaderVocabActions>[0])

    await act(async () => { await result.current.saveWord({ text: 'pocketed', sentence, selectionId: 1 }) })

    expect(cachedTranslate).toHaveBeenCalledWith('pocketed', 'en', 'pt', { sentence, bookId: 'book-1' })
  })

  it('TR-1: "Add anyway" glosses with the tapped selection, so it hits the toolbar cache entry', async () => {
    cachedTranslate.mockClear()
    const sentence = 'The quiver hung at his side.'
    api.saveWord.mockResolvedValue({ outcome: 'lookup', lookupId: 'l1', tapsRemaining: 2 })
    api.promoteLookup.mockResolvedValue({ id: 'w2', word: 'quiver', stage: 0, sentence: null })
    const noop = () => {}
    const { result } = renderHook(useReaderVocabActions, {
      vocabMapRef: { current: {} as VocabMap }, bookTitleRef: { current: null }, chapter: null, language: 'en',
      editionIdRef: { current: 'book-1' },
      textLanguage: 'en', nativeLanguage: 'pt', isAuthenticated: true, injectJs: noop, bumpVocab: noop,
      notifyWordSaved: noop, setSessionWordCount: noop, setWordSaved: noop, setSelection: noop,
      setLookupState: noop, showToast: noop,
    } as unknown as Parameters<typeof useReaderVocabActions>[0])

    await act(async () => { await result.current.saveWord({ text: 'Quiver', sentence, selectionId: 2 }) })
    await act(async () => {
      await result.current.addAnyway({ kind: 'lookup', id: 'l1', tapsRemaining: 2, busy: false })
    })

    expect(cachedTranslate).toHaveBeenCalledWith('Quiver', 'en', 'pt', { sentence, bookId: 'book-1' })
  })
})
