import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor, configure } from '@testing-library/react'

// #1271 review: the V2 reader's own hook: its language-filtered map and the backfill rule (vocabWords.mjs). The legacy
// reader's useReaderVocabulary is origin/main's, untouched.

const auth: { isAuthenticated: boolean; isGuest: boolean; user: { id: string } | null } = { isAuthenticated: true, isGuest: false, user: { id: 'u1' } }
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

import { useV2ReaderVocabulary } from '../useV2ReaderVocabulary'

const card = (word: string, language: string | undefined, extra: object = {}) => ({ id: `id-${word}`, word, stage: 0, translation: undefined, language, ...extra })
const saved = (word: string, language: string) => ({ outcome: 'srs', word: { id: `id-${word}`, word, stage: 0, translation: null, language }, lookupId: null, tapsRemaining: null, pendingId: null, reason: null })
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  Object.assign(auth, { isAuthenticated: true, isGuest: false, user: { id: 'u1' } })
  for (const f of [...Object.values(api), translate]) f.mockReset()
  translate.mockImplementation(async (word: string) => ({ translatedText: `uk:${word}` }))
  api.updateWord.mockResolvedValue({})
  for (const k of Object.keys(pending)) delete pending[k]
  localStorage.clear()
})

describe('useV2ReaderVocabulary', () => {
  it('marks_OnlyTheBooksLanguagesCards_ByPrimarySubtag_NotOneWithNoLanguage', async () => {
    api.getReaderVocab.mockResolvedValue([card('hund', 'de'), card('pond', 'en-GB'), card('reed', undefined)])
    const { result } = renderHook(() => useV2ReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect([...result.current.vocabMap.keys()].sort()).toEqual(['pond'])
  })

  it('marksLanguageNull_ABookWhoseLanguageDoesNotRead_NoWords_NoBackfill', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en'), card('reed', undefined)])
    const { result } = renderHook(() => useV2ReaderVocabulary(null, 'uk'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await flush()
    expect(result.current.vocabMap.size).toBe(0)
    expect(translate).not.toHaveBeenCalled()
  })

  it('backfill_FromTheLanguageTheLoadWasFor_ALanguageChangeRestartsIt_NeverEnglishCardsFromGerman', async () => {
    const first = deferred<unknown[]>()
    api.getReaderVocab.mockReturnValueOnce(first.promise).mockResolvedValue([card('hund', 'de'), card('pond', 'en')])
    const { rerender } = renderHook(({ lang }) => useV2ReaderVocabulary(lang, 'uk'), { initialProps: { lang: 'de' } })
    rerender({ lang: 'en' })
    first.resolve([card('hund', 'de'), card('pond', 'en')])
    await flush()
    expect(translate.mock.calls.map((c) => [c[0], c[1]])).toEqual([['pond', 'en']])
    expect(api.updateWord.mock.calls.map((c) => c[0])).toEqual(['id-pond'])
  })

  it('backfill_ALoadDoneForDe_ThenLanguageAndTargetChangeInOneCommit_OnlyTheNewLoadIsFilled', async () => {
    api.getReaderVocab.mockResolvedValueOnce([card('hund', 'de')]).mockResolvedValue([card('pond', 'en')])
    const { rerender } = renderHook(({ lang, target }) => useV2ReaderVocabulary(lang, target), { initialProps: { lang: 'de', target: null as string | null } })
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
    const { result } = renderHook(() => useV2ReaderVocabulary('en', 'uk'))
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
    renderHook(() => useV2ReaderVocabulary('en', 'uk'))
    await flush()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(api.updateWord).not.toHaveBeenCalled()
  })

  it('backfill_UnderStrictMode_ItsMountUnmountMount_StillRuns', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en')])
    // RTL's StrictMode: every effect mounts, unmounts and mounts again, as the dev server does.
    configure({ reactStrictMode: true })
    try {
      renderHook(() => useV2ReaderVocabulary('en', 'uk'))
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
    const { result } = renderHook(() => useV2ReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => { await result.current.addWord({ word: 'pond', language: 'en' } as never) })
    expect(api.saveWord.mock.calls.map((c) => (c[0] as { word: string }).word)).toEqual(['hund', 'pond'])
    expect([...result.current.vocabMap.keys()]).toEqual(['pond'])
  })

  it('flush_AQueuedWordOfAnotherLanguage_NeverTakesTheSameKeyedCardsTranslation', async () => {
    // An English card 'gift' with its translation is in the map; a queued German 'gift' is another card.
    api.getReaderVocab.mockResolvedValue([card('gift', 'en', { translation: 'подарунок' })])
    pending.q1 = { id: 'q1', word: 'gift', language: 'de', translation: null, createdAt: 1 } as never
    pending.q2 = { id: 'q2', word: 'gift', language: 'en', translation: null, createdAt: 2 } as never
    api.saveWord.mockImplementation(async (req: { word: string; language: string }) => saved(req.word, req.language))
    const { result } = renderHook(() => useV2ReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => { await result.current.addWord({ word: 'pond', language: 'en' } as never) })
    const sent = api.saveWord.mock.calls.map((c) => c[0] as { word: string; language: string; translation: string | null })
    expect(sent.filter((r) => r.word === 'gift').map((r) => [r.language, r.translation])).toEqual([['de', null], ['en', 'подарунок']])
  })

  it('aNewNativeLanguage_TheRunningBackfillStops_NothingWrittenInTheOld_TheRestFilledInTheNew', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en'), card('reed', 'en')])
    translate.mockImplementation(async (word: string, _from: string, to: string) => ({ translatedText: `${to}:${word}` }))
    const slow = deferred<{ translatedText: string }>()
    translate.mockReturnValueOnce(slow.promise)
    const { rerender } = renderHook(({ target }) => useV2ReaderVocabulary('en', target), { initialProps: { target: 'uk' } })
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1))
    rerender({ target: 'pl' })
    slow.resolve({ translatedText: 'uk:pond' })
    await flush()
    expect(api.updateWord.mock.calls.map((c) => [c[0], (c[1] as { translation: string }).translation])).toEqual([['id-pond', 'pl:pond'], ['id-reed', 'pl:reed']])
  })

  it('guestBecomesAnAccount_TheMapIsLoadedAgainForTheNewIdentity', async () => {
    Object.assign(auth, { isGuest: true, user: { id: 'g1' } })
    api.getReaderVocab.mockResolvedValueOnce([card('pond', 'en', { id: 'guest-pond' })]).mockResolvedValue([card('pond', 'en', { id: 'acct-pond' })])
    const { result, rerender } = renderHook(() => useV2ReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.vocabMap.get('pond')?.id).toBe('guest-pond'))
    Object.assign(auth, { isGuest: false, user: { id: 'a1' } })
    rerender()
    await waitFor(() => expect(result.current.vocabMap.get('pond')?.id).toBe('acct-pond'))
    expect(api.getReaderVocab).toHaveBeenCalledTimes(2)
  })

  it('theLegacyList_CardsWithNoLanguage_NotMarked_NotFilled', async () => {
    // V2 not answering: the list has no languages; the V2 reader marks and fills none of them.
    api.getReaderVocab.mockResolvedValue([card('pond', undefined), card('reed', undefined)])
    const { result } = renderHook(() => useV2ReaderVocabulary('en', 'uk'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await flush()
    expect(result.current.vocabMap.size).toBe(0)
    expect(translate).not.toHaveBeenCalled()
    expect(api.updateWord).not.toHaveBeenCalled()
  })

  it('guestNudge_CountsTheWholeVocabulary_NotTheBooksLanguageOnly', async () => {
    Object.assign(auth, { isGuest: true })
    api.getReaderVocab.mockResolvedValue([card('hund', 'de'), card('katze', 'de')])
    api.saveWord.mockImplementation(async (req: { word: string; language: string }) => saved(req.word, req.language))
    const { result } = renderHook(() => useV2ReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.vocabMap.size).toBe(0)
    await act(async () => { await result.current.addWord({ word: 'pond', language: 'en' } as never) })
    expect(result.current.guestNudge).toBe('three')
  })
})
