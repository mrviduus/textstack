import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor, configure } from '@testing-library/react'

// #1271 review: the V2 reader's language-filtered map (`marks`) and the backfill rule (vocabWords.mjs), against the
// legacy reader's unfiltered map.

const auth = { isAuthenticated: true, isGuest: false }
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ ...auth, waitForSession: async () => {}, ensureSession: async () => {} }),
}))
vi.mock('../../context/GuestLimitsContext', () => ({ useGuestLimits: () => ({ commitmentThreshold: 3 }) }))

const api = { getReaderVocab: vi.fn(), saveWord: vi.fn(), updateWord: vi.fn() }
vi.mock('../../api/vocabulary', () => ({
  getReaderVocab: (...a: unknown[]) => api.getReaderVocab(...a),
  saveWord: (...a: unknown[]) => api.saveWord(...a),
  updateWord: (...a: unknown[]) => api.updateWord(...a),
  deleteWord: vi.fn(),
  markAsKnown: vi.fn(),
}))
const translate = vi.fn()
vi.mock('../../api/translation', () => ({ translate: (...a: unknown[]) => translate(...a) }))
const pending: Record<string, { id: string; createdAt: number }> = {}
vi.mock('../../lib/offlineDb', () => ({
  addPendingVocabWord: async (w: { id: string; createdAt: number }) => { pending[w.id] = w },
  listPendingVocabWords: async () => Object.values(pending),
  countPendingVocabWords: async () => Object.keys(pending).length,
  deletePendingVocabWord: async (id: string) => { delete pending[id] },
}))

import { useReaderVocabulary } from '../useReaderVocabulary'

const card = (word: string, language: string | undefined, extra: object = {}) => ({ id: `id-${word}`, word, stage: 0, translation: undefined, language, ...extra })
const saved = (word: string, language: string) => ({ outcome: 'srs', word: { id: `id-${word}`, word, stage: 0, translation: null, language }, lookupId: null, tapsRemaining: null, pendingId: null, reason: null })
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  Object.assign(auth, { isAuthenticated: true, isGuest: false })
  for (const f of [...Object.values(api), translate]) f.mockReset()
  translate.mockImplementation(async (word: string) => ({ translatedText: `uk:${word}` }))
  api.updateWord.mockResolvedValue({})
  for (const k of Object.keys(pending)) delete pending[k]
  localStorage.clear()
})

describe('useReaderVocabulary: legacy reader (no marks)', () => {
  it('legacyUpload_ADeCardInAnUploadReadAsEn_StaysSaved_NoFilter', async () => {
    // A legacy upload is read with bookLanguage 'en': its own 'de' card is still its saved word (no duplicate save).
    api.getReaderVocab.mockResolvedValue([card('hund', 'de'), card('pond', 'en'), card('reed', undefined)])
    const { result } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect([...result.current.vocabMap.keys()].sort()).toEqual(['hund', 'pond', 'reed'])
  })
})

describe('useReaderVocabulary: V2 marks', () => {
  it('marks_OnlyTheBooksLanguagesCards_ACardWithNoLanguagePasses', async () => {
    api.getReaderVocab.mockResolvedValue([card('hund', 'de'), card('pond', 'en-GB'), card('reed', undefined)])
    const { result } = renderHook(() => useReaderVocabulary('en', null, { language: 'en' }))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect([...result.current.vocabMap.keys()].sort()).toEqual(['pond', 'reed'])
  })

  it('marksLanguageNull_ABookWhoseLanguageDoesNotRead_NoWords_NoBackfill', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en'), card('reed', undefined)])
    const { result } = renderHook(() => useReaderVocabulary('en', 'uk', { language: null }))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await flush()
    expect(result.current.vocabMap.size).toBe(0)
    expect(translate).not.toHaveBeenCalled()
  })

  it('backfill_FromTheLanguageTheLoadWasFor_ALanguageChangeRestartsIt_NeverEnglishCardsFromGerman', async () => {
    const first = deferred<unknown[]>()
    api.getReaderVocab.mockReturnValueOnce(first.promise).mockResolvedValue([card('hund', 'de'), card('pond', 'en')])
    const { rerender } = renderHook(({ lang }) => useReaderVocabulary(lang, 'uk', { language: lang }), { initialProps: { lang: 'de' } })
    rerender({ lang: 'en' })
    first.resolve([card('hund', 'de'), card('pond', 'en')])
    await flush()
    expect(translate.mock.calls.map((c) => [c[0], c[1]])).toEqual([['pond', 'en']])
    expect(api.updateWord.mock.calls.map((c) => c[0])).toEqual(['id-pond'])
  })

  it('backfill_ALoadDoneForDe_ThenLanguageAndTargetChangeInOneCommit_OnlyTheNewLoadIsFilled', async () => {
    api.getReaderVocab.mockResolvedValueOnce([card('hund', 'de')]).mockResolvedValue([card('pond', 'en')])
    const { rerender } = renderHook(({ lang, target }) => useReaderVocabulary(lang, target, { language: lang }), { initialProps: { lang: 'de', target: null as string | null } })
    await flush()
    // The 'de' load is in (no target: nothing filled yet); the book is now English, a target too, in the same render.
    rerender({ lang: 'en', target: 'uk' })
    await flush()
    expect(translate.mock.calls.map((c) => [c[0], c[1]])).toEqual([['pond', 'en']])
    expect(api.updateWord.mock.calls.map((c) => c[0])).toEqual(['id-pond'])
  })

  it('backfill_ASecondLoadCancelsTheFirst_NoWriteFromItAfter', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en'), card('reed', 'en')])
    const slow = deferred<{ translatedText: string }>()
    translate.mockReturnValueOnce(slow.promise)
    const { result } = renderHook(() => useReaderVocabulary('en', 'uk', { language: 'en' }))
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1))
    api.getReaderVocab.mockResolvedValue([card('heron', 'en')])
    act(() => result.current.retryLoad())
    await flush()
    slow.resolve({ translatedText: 'uk:pond' })
    await flush()
    // The first load's loop stopped at its word in flight: no write for pond or reed; the second load filled heron.
    expect(api.updateWord.mock.calls.map((c) => c[0])).toEqual(['id-heron'])
  })

  it('backfill_ATranslate429_StopsIt', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en'), card('reed', 'en')])
    translate.mockRejectedValue(Object.assign(new Error('Translation failed: 429'), { status: 429 }))
    renderHook(() => useReaderVocabulary('en', 'uk', { language: 'en' }))
    await flush()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(api.updateWord).not.toHaveBeenCalled()
  })

  it('backfill_UnderStrictMode_ItsMountUnmountMount_StillRuns', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en')])
    // RTL's StrictMode: every effect mounts, unmounts and mounts again, as the dev server does.
    configure({ reactStrictMode: true })
    try {
      renderHook(() => useReaderVocabulary('en', 'uk', { language: 'en' }))
      await flush()
    } finally {
      configure({ reactStrictMode: false })
    }
    expect(api.updateWord.mock.calls.map((c) => c[0])).toEqual(['id-pond'])
  })

  it('flush_AnotherBooksQueuedWord_NotInThisBooksMap', async () => {
    api.getReaderVocab.mockResolvedValue([])
    pending.q1 = { id: 'q1', word: 'hund', language: 'de', createdAt: 1 } as never
    api.saveWord.mockImplementation(async (req: { word: string; language: string }) => saved(req.word, req.language))
    const { result } = renderHook(() => useReaderVocabulary('en', null, { language: 'en' }))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => { await result.current.addWord({ word: 'pond', language: 'en' } as never) })
    expect(api.saveWord.mock.calls.map((c) => (c[0] as { word: string }).word)).toEqual(['hund', 'pond'])
    expect([...result.current.vocabMap.keys()]).toEqual(['pond'])
  })

  it('guestNudge_CountsTheWholeVocabulary_NotTheBooksLanguageOnly', async () => {
    Object.assign(auth, { isGuest: true })
    api.getReaderVocab.mockResolvedValue([card('hund', 'de'), card('katze', 'de')])
    api.saveWord.mockImplementation(async (req: { word: string; language: string }) => saved(req.word, req.language))
    const { result } = renderHook(() => useReaderVocabulary('en', null, { language: 'en' }))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.vocabMap.size).toBe(0)
    await act(async () => { await result.current.addWord({ word: 'pond', language: 'en' } as never) })
    expect(result.current.guestNudge).toBe('three')
  })
})
