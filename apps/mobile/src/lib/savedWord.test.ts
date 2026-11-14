import { ApiError } from '@textstack/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #1270: the save's retries and the saved card's translation, shared by the legacy and the V2 mobile readers.

const api = { saveWord: vi.fn(), updateWord: vi.fn() }
vi.mock('./vocabularyApi', () => ({
  vocabularyApi: { saveWord: (...a: unknown[]) => api.saveWord(...a), updateWord: (...a: unknown[]) => api.updateWord(...a) },
}))
const translate = vi.fn()
vi.mock('./translateCache', () => ({ cachedTranslate: (...a: unknown[]) => translate(...a) }))

import { fillSavedTranslation, saveWordWithRetry } from './savedWord'

const v2Error = (code: string) => Object.assign(new ApiError(404, code), { body: { code, message: '' } })
const body = { word: 'pond', language: 'en' } as Parameters<typeof saveWordWithRetry>[0]

beforeEach(() => {
  api.saveWord.mockReset()
  api.updateWord.mockReset().mockResolvedValue({})
  translate.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('saveWordWithRetry', () => {
  it('aServerAnswer_RethrownAtOnce_NeverRetried', async () => {
    api.saveWord.mockRejectedValue(v2Error('book_not_found'))
    await expect(saveWordWithRetry(body)).rejects.toMatchObject({ body: { code: 'book_not_found' } })
    expect(api.saveWord).toHaveBeenCalledTimes(1)
  })

  it('v2Unavailable_Retried', async () => {
    vi.useFakeTimers()
    api.saveWord.mockRejectedValueOnce(v2Error('v2_unavailable')).mockResolvedValue({ outcome: 'srs' })
    const done = saveWordWithRetry(body)
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ outcome: 'srs' })
    expect(api.saveWord).toHaveBeenCalledTimes(2)
  })

  it('aNetworkFailure_RetriedWithTheSameIds', async () => {
    vi.useFakeTimers()
    api.saveWord.mockRejectedValueOnce(new TypeError('Network request failed')).mockResolvedValue({ outcome: 'srs' })
    const done = saveWordWithRetry(body)
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ outcome: 'srs' })
    expect(api.saveWord).toHaveBeenCalledTimes(2)
    const [a, b] = api.saveWord.mock.calls.map((c) => c[0])
    expect(a.id).toBe(b.id)
    expect(a.operationId).toBe(b.operationId)
  })
})

describe('fillSavedTranslation', () => {
  it('aCardWithoutATranslation_TranslatedIntoTheReadersLanguage_PatchedOnlyIfEmpty', async () => {
    translate.mockResolvedValue({ translation: 'ставок' })
    expect(await fillSavedTranslation({ id: 'w1', translation: null }, 'pond', 'en', 'uk', { sentence: 'By the pond.', bookId: 'b1' })).toBe('ставок')
    expect(translate).toHaveBeenCalledWith('pond', 'en', 'uk', { sentence: 'By the pond.', bookId: 'b1' })
    expect(api.updateWord).toHaveBeenCalledWith('w1', { translation: 'ставок', onlyIfEmpty: true })
  })

  it('aCardWithATranslation_LeftAsItIs', async () => {
    expect(await fillSavedTranslation({ id: 'w1', translation: 'став' }, 'pond', 'en', 'uk', {})).toBeNull()
    expect(translate).not.toHaveBeenCalled()
    expect(api.updateWord).not.toHaveBeenCalled()
  })

  it('aBookInTheReadersLanguage_NothingToTranslateInto', async () => {
    expect(await fillSavedTranslation({ id: 'w1', translation: null }, 'pond', 'en', 'en', {})).toBeNull()
    expect(translate).not.toHaveBeenCalled()
  })

  it('noTranslation_NoPatch', async () => {
    translate.mockResolvedValue({ translation: '' })
    expect(await fillSavedTranslation({ id: 'w1', translation: null }, 'pond', 'en', 'uk', {})).toBeNull()
    expect(api.updateWord).not.toHaveBeenCalled()
  })

  it('aFailedPatch_TheTranslationStillReturned', async () => {
    translate.mockResolvedValue({ translation: 'ставок' })
    api.updateWord.mockRejectedValue(new Error('offline'))
    expect(await fillSavedTranslation({ id: 'w1', translation: null }, 'pond', 'en', 'uk', {})).toBe('ставок')
  })
})
