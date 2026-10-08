// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '../test/renderHook'

const api = vi.hoisted(() => ({ saveWord: vi.fn(), updateWord: vi.fn() }))
vi.mock('@textstack/shared', () => ({ vocabularyApi: api, t: (_l: string, k: string) => k }))
vi.mock('../lib/translateCache', () => ({ cachedTranslate: vi.fn(() => new Promise(() => {})) }))

import { useReaderVocabActions } from './useReaderVocabActions'
import type { VocabMap } from './useReaderVocabMap'

describe('useReaderVocabActions', () => {
  // Review of #780: the map entry keeps the sentence the word was saved in, so a later
  // bubble in another sentence does not overwrite this sense.
  it('saveWord_Saved_MapEntryKeepsSentence', async () => {
    const sentence = 'He pocketed the coins and walked out.'
    api.saveWord.mockResolvedValue({ outcome: 'saved', word: { id: 'w1', word: 'pocketed', stage: 0, sentence } })
    const vocabMapRef = { current: {} as VocabMap }
    const noop = () => {}
    const { result } = renderHook(useReaderVocabActions, {
      vocabMapRef, bookTitleRef: { current: null }, chapter: null, language: 'en',
      textLanguage: 'en', nativeLanguage: 'pt', isAuthenticated: true, injectJs: noop, bumpVocab: noop,
      notifyWordSaved: noop, setSessionWordCount: noop, setWordSaved: noop, setSelection: noop,
      setLookupState: noop, showToast: noop,
    } as unknown as Parameters<typeof useReaderVocabActions>[0])

    await act(async () => { await result.current.saveWord({ text: 'pocketed', sentence, selectionId: 1 }) })

    expect(vocabMapRef.current.pocketed).toEqual({ stage: 0, id: 'w1', sentence })
  })
})
