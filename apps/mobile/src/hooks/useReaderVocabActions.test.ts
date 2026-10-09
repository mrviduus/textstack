// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '../test/renderHook'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

  const setup = (vocabMapRef: { current: VocabMap }, injectJs: (js: string) => void = () => {}) => {
    const noop = () => {}
    return renderHook(useReaderVocabActions, {
      vocabMapRef, bookTitleRef: { current: null }, chapter: null, language: 'en',
      editionIdRef: { current: 'book-1' },
      textLanguage: 'en', nativeLanguage: 'pt', isAuthenticated: true, injectJs, bumpVocab: noop,
      notifyWordSaved: noop, setSessionWordCount: noop, setWordSaved: noop, setSelection: noop,
      setLookupState: noop, showToast: noop,
    } as unknown as Parameters<typeof useReaderVocabActions>[0])
  }

  it('TR-2: saving (or "Add anyway" on) an already-translated word never PATCHes it — the saved translation is painted', async () => {
    const sentence = 'He pocketed the coins and walked out.'
    api.updateWord.mockReset()
    api.updateWord.mockRejectedValue(new Error('offline'))
    cachedTranslate.mockImplementation(() => Promise.resolve({ translation: 'embolsou' }) as never)
    api.promoteLookup.mockResolvedValue({ id: 'w3', word: 'pocketed', stage: 1, sentence, translation: 'enterrado' })
    api.saveWord.mockResolvedValue({ outcome: 'saved', word: { id: 'w3', word: 'pocketed', stage: 1, sentence, translation: 'enterrado' } })
    const vocabMapRef = { current: {} as VocabMap }
    const { result } = setup(vocabMapRef)

    await act(async () => { await result.current.saveWord({ text: 'pocketed', sentence, selectionId: 3 }) })
    await act(async () => { await result.current.addAnyway({ kind: 'lookup', id: 'l3', tapsRemaining: 1, busy: false }) })

    expect(api.updateWord).not.toHaveBeenCalled()
    expect(vocabMapRef.current.pocketed.translation).toBe('enterrado')
  })

  it('TR-2: an untranslated saved word gets the gloss painted even when its PATCH fails', async () => {
    api.updateWord.mockReset()
    api.updateWord.mockRejectedValue(new Error('offline'))
    cachedTranslate.mockImplementation(() => Promise.resolve({ translation: 'ferida' }) as never)
    api.saveWord.mockResolvedValue({ outcome: 'saved', word: { id: 'w4', word: 'wound', stage: 0, sentence: null, translation: null } })
    const vocabMapRef = { current: {} as VocabMap }
    const painted: string[] = []
    const { result } = setup(vocabMapRef, (js) => painted.push(js))

    await act(async () => { await result.current.saveWord({ text: 'wound', sentence: 'The wound bled.', selectionId: 4 }) })

    expect(api.updateWord).toHaveBeenCalledWith('w4', { translation: 'ferida', onlyIfEmpty: true })
    expect(vocabMapRef.current.wound.translation).toBe('ferida')
    expect(painted.some((js) => js.includes('ferida'))).toBe(true)
  })

  it('TR-3: replaceTranslation PATCHes the shown translation explicitly, once, and repaints', async () => {
    api.updateWord.mockReset()
    api.updateWord.mockResolvedValue({ id: 'w3', word: 'pocketed', stage: 1, translation: 'embolsou' })
    const vocabMapRef = { current: { pocketed: { stage: 1, id: 'w3', translation: 'enterrado' } } as VocabMap }
    const painted: string[] = []
    const { result } = setup(vocabMapRef, (js) => painted.push(js))

    await act(async () => { await result.current.replaceTranslation('Pocketed', 'embolsou') })

    expect(api.updateWord).toHaveBeenCalledTimes(1)
    expect(api.updateWord).toHaveBeenCalledWith('w3', { translation: 'embolsou' })
    expect(vocabMapRef.current.pocketed.translation).toBe('embolsou')
    expect(painted.some((js) => js.includes('embolsou'))).toBe(true)
  })

  it('TR-3: replaceTranslation finds the saved entry through the map key normalizer ("word," and a curly apostrophe)', async () => {
    api.updateWord.mockReset()
    api.updateWord.mockResolvedValue({})
    const vocabMapRef = { current: {
      pocketed: { stage: 1, id: 'w3', translation: 'enterrado' },
      "don't": { stage: 1, id: 'w5', translation: 'não' },
    } as VocabMap }
    const { result } = setup(vocabMapRef)

    await act(async () => { await result.current.replaceTranslation('Pocketed,', 'embolsou') })
    await act(async () => { await result.current.replaceTranslation('Don’t', 'nao faça') })

    expect(api.updateWord).toHaveBeenCalledWith('w3', { translation: 'embolsou' })
    expect(api.updateWord).toHaveBeenCalledWith('w5', { translation: 'nao faça' })
    expect(vocabMapRef.current.pocketed.translation).toBe('embolsou')
    expect(vocabMapRef.current["don't"].translation).toBe('nao faça')
  })

  it('TR-3: replaceTranslation with no saved entry shows the failed-save error toast', async () => {
    api.updateWord.mockReset()
    const showToast = vi.fn()
    const noop = () => {}
    const { result } = renderHook(useReaderVocabActions, {
      vocabMapRef: { current: {} as VocabMap }, bookTitleRef: { current: null }, chapter: null, language: 'en',
      editionIdRef: { current: 'book-1' },
      textLanguage: 'en', nativeLanguage: 'pt', isAuthenticated: true, injectJs: noop, bumpVocab: noop,
      notifyWordSaved: noop, setSessionWordCount: noop, setWordSaved: noop, setSelection: noop,
      setLookupState: noop, showToast,
    } as unknown as Parameters<typeof useReaderVocabActions>[0])

    await act(async () => { await result.current.replaceTranslation('ghost', 'fantasma') })

    expect(api.updateWord).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith({ message: 'reader.vocab.useTranslationFailed', variant: 'error' })
  })

  it('TR-3: the reader looks up and builds the vocab map with the same key normalizer', () => {
    const shell = readFileSync(resolve(__dirname, '../components/reader/ReaderShell.tsx'), 'utf8')
    const map = readFileSync(resolve(__dirname, 'useReaderVocabMap.ts'), 'utf8')
    expect(shell).not.toContain('selection.text.toLowerCase()')
    expect(shell).toContain('vocabMapRef.current[vocabMapKey(selection.text)]')
    expect(map).toContain('map[vocabMapKey(w.word)]')
  })

  it('TR-2: the chapter-open backfill (useReaderVocabMap) is an automatic fill and sends onlyIfEmpty', () => {
    const src = readFileSync(resolve(__dirname, 'useReaderVocabMap.ts'), 'utf8')
    expect(src).toContain('vocabularyApi.updateWord(id, { translation, onlyIfEmpty: true })')
  })
})
