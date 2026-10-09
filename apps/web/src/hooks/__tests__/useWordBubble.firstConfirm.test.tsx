import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, isGuest: false, waitForSession: () => Promise.resolve(), ensureSession: () => Promise.resolve() }),
}))
vi.mock('../../context/GuestLimitsContext', () => ({ useGuestLimits: () => ({ commitmentThreshold: 3 }) }))
const saveWord = vi.fn()
const updateWord = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock('../../api/vocabulary', () => ({
  getReaderVocab: () => Promise.resolve([]),
  saveWord: (...a: unknown[]) => saveWord(...a),
  updateWord: (...a: unknown[]) => updateWord(...a),
  deleteWord: vi.fn(), markAsKnown: vi.fn(), promoteLookup: vi.fn(),
}))
const byLang: Record<string, string> = { pt: 'embolsou', uk: 'поклав' }
vi.mock('../../api/translation', () => ({
  translate: (_w: string, _f: string, to: string) => Promise.resolve({ translatedText: byLang[to] }),
}))
vi.mock('../../api/explain', () => ({ explain: vi.fn() }))
vi.mock('../../lib/offlineDb', () => ({
  addPendingVocabWord: vi.fn(), listPendingVocabWords: () => Promise.resolve([]),
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

describe('TR-2: first native-language confirm is not a language switch', () => {
  it('TR-2: the catch-up save never stores the guessed-language translation; the confirmed one fills it', async () => {
    saveWord.mockResolvedValue({ outcome: 'saved', word: { id: 'w1', word: 'pocketed', stage: 0, translation: null } })
    const { result, rerender } = renderHook(useReader, { initialProps: { lang: 'pt', confirmed: false } })
    await waitFor(() => expect(result.current.bubble?.translation).toBe('embolsou'))
    expect(result.current.bubble?.translationLang).toBe('pt')
    expect(saveWord).not.toHaveBeenCalled()

    // The reader picks Ukrainian in the popup's picker: confirm + language flip in one render.
    rerender({ lang: 'uk', confirmed: true })

    await waitFor(() => expect(updateWord).toHaveBeenCalledWith('w1', { translation: 'поклав', onlyIfEmpty: true }))
    expect(saveWord).toHaveBeenCalledTimes(1)
    expect(saveWord.mock.calls[0][0]).toMatchObject({ translation: null })
    expect(updateWord).not.toHaveBeenCalledWith('w1', expect.objectContaining({ translation: 'embolsou' }))
    expect(result.current.bubble?.translation).toBe('поклав')
    expect(result.current.bubble).toMatchObject({ translationLang: 'uk', langSwitched: false })
  })
})
