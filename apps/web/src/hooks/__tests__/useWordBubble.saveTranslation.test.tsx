import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const auth = vi.hoisted(() => ({ isAuthenticated: true }))
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: auth.isAuthenticated, isGuest: false, waitForSession: () => Promise.resolve(), ensureSession: () => Promise.resolve() }),
}))
vi.mock('../../context/GuestLimitsContext', () => ({ useGuestLimits: () => ({ commitmentThreshold: 3 }) }))
const saveWord = vi.fn()
const getReaderVocab = vi.fn((): Promise<unknown[]> => Promise.resolve([]))
const updateWord = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock('../../api/vocabulary', () => ({
  getReaderVocab: () => getReaderVocab(),
  saveWord: (...a: unknown[]) => saveWord(...a),
  updateWord: (...a: unknown[]) => updateWord(...a),
  deleteWord: vi.fn(), markAsKnown: vi.fn(), promoteLookup: vi.fn(),
}))
const byLang: Record<string, string> = { pt: 'embolsou', uk: 'поклав' }
vi.mock('../../api/translation', () => ({
  translate: (_w: string, _f: string, to: string) => Promise.resolve({ translatedText: byLang[to] }),
}))
vi.mock('../../api/explain', () => ({ explain: vi.fn() }))
const addPendingVocabWord = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock('../../lib/offlineDb', () => ({
  addPendingVocabWord: (...a: unknown[]) => addPendingVocabWord(...a), listPendingVocabWords: () => Promise.resolve([]),
  countPendingVocabWords: () => Promise.resolve(0), deletePendingVocabWord: vi.fn(),
}))

import { useReaderVocabulary } from '../useReaderVocabulary'
import { useWordBubble } from '../useWordBubble'

function useReader({ lang, confirmed }: { lang: string; confirmed: boolean }) {
  // Backfill off (targetLang null): only the bubble path writes.
  const vocab = useReaderVocabulary('en', null)
  return useWordBubble({
    selection: { text: 'pocketed', rect: new DOMRect(), range: null } as never,
    clearSelection: () => {}, hasSelection: true, isSingleWord: true,
    containerRef: { current: null }, bookLanguage: 'en', targetLang: lang,
    editionId: 'e1', chapterId: 'c1', nativeLanguage: lang, hasConfirmedLanguage: confirmed,
    vocab, t: (k) => k,
  })
}

describe('TR-2: the save carries the bubble translation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.isAuthenticated = true
    getReaderVocab.mockResolvedValue([])
  })

  it('TR-2: the catch-up save after confirming sends the bubble translation', async () => {
    saveWord.mockResolvedValue({ outcome: 'saved', word: { id: 'w1', word: 'pocketed', stage: 0, translation: 'embolsou' } })
    const { result, rerender } = renderHook(useReader, { initialProps: { lang: 'pt', confirmed: false } })
    await waitFor(() => expect(result.current.bubble?.translation).toBe('embolsou'))
    expect(saveWord).not.toHaveBeenCalled()

    rerender({ lang: 'pt', confirmed: true })

    await waitFor(() => expect(saveWord).toHaveBeenCalledTimes(1))
    expect(saveWord.mock.calls[0][0]).toMatchObject({ word: 'pocketed', translation: 'embolsou' })
  })

  it('TR-2: a signed-out reader\'s pending IndexedDB record keeps the bubble translation', async () => {
    auth.isAuthenticated = false
    const { result, rerender } = renderHook(useReader, { initialProps: { lang: 'pt', confirmed: false } })
    await waitFor(() => expect(result.current.bubble?.translation).toBe('embolsou'))

    rerender({ lang: 'pt', confirmed: true })

    await waitFor(() => expect(addPendingVocabWord).toHaveBeenCalledTimes(1))
    expect(addPendingVocabWord.mock.calls[0][0]).toMatchObject({ word: 'pocketed', translation: 'embolsou' })
    expect(saveWord).not.toHaveBeenCalled()
  })

  it('TR-2: a mid-popup language switch never PATCHes an existing saved translation', async () => {
    getReaderVocab.mockResolvedValue([{ id: 'w1', word: 'pocketed', stage: 1, translation: 'enterrado' }])
    saveWord.mockResolvedValue({ outcome: 'already_saved', word: { id: 'w1', word: 'pocketed', stage: 1, translation: 'enterrado' } })
    const { result, rerender } = renderHook(useReader, { initialProps: { lang: 'pt', confirmed: true } })
    await waitFor(() => expect(result.current.bubble?.translation).toBe('embolsou'))

    rerender({ lang: 'uk', confirmed: true })

    await waitFor(() => expect(result.current.bubble?.translation).toBe('поклав'))
    expect(result.current.bubble).toMatchObject({ translationLang: 'uk', langSwitched: true })
    expect(updateWord).not.toHaveBeenCalled()
  })
})
