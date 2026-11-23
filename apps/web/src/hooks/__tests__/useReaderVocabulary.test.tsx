import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor, configure } from '@testing-library/react'

// #1271 review: the V2 reader's own hook: its language-filtered map and the backfill rule (vocabWords.mjs).

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
  Object.assign(auth, { isAuthenticated: true, isGuest: false, user: { id: 'u1' } })
  for (const f of [...Object.values(api), translate]) f.mockReset()
  translate.mockImplementation(async (word: string) => ({ translatedText: `uk:${word}` }))
  api.updateWord.mockResolvedValue({})
  for (const k of Object.keys(pending)) delete pending[k]
  localStorage.clear()
})

describe('useReaderVocabulary', () => {
  it('marks_OnlyTheBooksLanguagesCards_ByPrimarySubtag_NotOneWithNoLanguage', async () => {
    api.getReaderVocab.mockResolvedValue([card('hund', 'de'), card('pond', 'en-GB'), card('reed', undefined)])
    const { result } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect([...result.current.vocabMap.keys()].sort()).toEqual(['pond'])
  })

  it('marksLanguageNull_ABookWhoseLanguageDoesNotRead_NoWords_NoBackfill', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en'), card('reed', undefined)])
    const { result } = renderHook(() => useReaderVocabulary(null, 'uk'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await flush()
    expect(result.current.vocabMap.size).toBe(0)
    expect(translate).not.toHaveBeenCalled()
  })

  it('backfill_FromTheLanguageTheLoadWasFor_ALanguageChangeRestartsIt_NeverEnglishCardsFromGerman', async () => {
    const first = deferred<unknown[]>()
    api.getReaderVocab.mockReturnValueOnce(first.promise).mockResolvedValue([card('hund', 'de'), card('pond', 'en')])
    const { rerender } = renderHook(({ lang }) => useReaderVocabulary(lang, 'uk'), { initialProps: { lang: 'de' } })
    rerender({ lang: 'en' })
    first.resolve([card('hund', 'de'), card('pond', 'en')])
    await flush()
    expect(translate.mock.calls.map((c) => [c[0], c[1]])).toEqual([['pond', 'en']])
    expect(api.updateWord.mock.calls.map((c) => c[0])).toEqual(['id-pond'])
  })

  it('backfill_ALoadDoneForDe_ThenLanguageAndTargetChangeInOneCommit_OnlyTheNewLoadIsFilled', async () => {
    api.getReaderVocab.mockResolvedValueOnce([card('hund', 'de')]).mockResolvedValue([card('pond', 'en')])
    const { rerender } = renderHook(({ lang, target }) => useReaderVocabulary(lang, target), { initialProps: { lang: 'de', target: null as string | null } })
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
    const { result } = renderHook(() => useReaderVocabulary('en', 'uk'))
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
    renderHook(() => useReaderVocabulary('en', 'uk'))
    await flush()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(api.updateWord).not.toHaveBeenCalled()
  })

  it('backfill_UnderStrictMode_ItsMountUnmountMount_StillRuns', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en')])
    // RTL's StrictMode: every effect mounts, unmounts and mounts again, as the dev server does.
    configure({ reactStrictMode: true })
    try {
      renderHook(() => useReaderVocabulary('en', 'uk'))
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
    const { result } = renderHook(() => useReaderVocabulary('en', null))
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
    const { result } = renderHook(() => useReaderVocabulary('en', null))
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
    const { rerender } = renderHook(({ target }) => useReaderVocabulary('en', target), { initialProps: { target: 'uk' } })
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1))
    rerender({ target: 'pl' })
    slow.resolve({ translatedText: 'uk:pond' })
    await flush()
    expect(api.updateWord.mock.calls.map((c) => [c[0], (c[1] as { translation: string }).translation])).toEqual([['id-pond', 'pl:pond'], ['id-reed', 'pl:reed']])
  })

  it('guestBecomesAnAccount_TheMapIsLoadedAgainForTheNewIdentity', async () => {
    Object.assign(auth, { isGuest: true, user: { id: 'g1' } })
    api.getReaderVocab.mockResolvedValueOnce([card('pond', 'en', { id: 'guest-pond' })]).mockResolvedValue([card('pond', 'en', { id: 'acct-pond' })])
    const { result, rerender } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.vocabMap.get('pond')?.id).toBe('guest-pond'))
    Object.assign(auth, { isGuest: false, user: { id: 'a1' } })
    rerender()
    await waitFor(() => expect(result.current.vocabMap.get('pond')?.id).toBe('acct-pond'))
    expect(api.getReaderVocab).toHaveBeenCalledTimes(2)
  })

  it('syncDown_TheLegacyList_AKnownWordIsNotSavedAgain_NothingMarkedOrFilled', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', undefined)])
    const { result } = renderHook(() => useReaderVocabulary('en', 'uk'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await flush()
    // The auto-save's guard knows it (any language, none too); the marks and the backfill do not take it.
    expect(result.current.isKnown('Pond')).toBe(true)
    expect(result.current.isKnown('reed')).toBe(false)
    expect(result.current.vocabMap.size).toBe(0)
    expect(translate).not.toHaveBeenCalled()
  })

  // #1341: the backfill translates with no sentence; the tapped word's translate (the popup's) carries one. A word
  // saved untranslated after the load is the save's to fill (TR-2), never a second, sentence-less request here.
  it('backfill_AWordSavedAfterTheLoad_NotTranslatedAgain', async () => {
    api.getReaderVocab.mockResolvedValue([])
    api.saveWord.mockImplementation(async (req: { word: string; language: string }) => saved(req.word, req.language))
    const { result } = renderHook(() => useReaderVocabulary('en', 'uk'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => { await result.current.addWord({ word: 'woods', language: 'en' } as never) })
    await flush()
    expect(result.current.vocabMap.get('woods')?.translation).toBeUndefined()
    expect(translate).not.toHaveBeenCalled()
  })

  it('aSaveAnsweredWhileAReloadWasInFlight_KeptWhenTheReloadCommits', async () => {
    api.getReaderVocab.mockResolvedValueOnce([])
    const { result } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const reload = deferred<unknown[]>()
    api.getReaderVocab.mockReturnValueOnce(reload.promise)
    api.saveWord.mockImplementation(async (req: { word: string; language: string }) => saved(req.word, req.language))
    act(() => result.current.retryLoad())
    await act(async () => { await result.current.addWord({ word: 'otter', language: 'en' } as never) })
    // The reload's snapshot predates the save.
    reload.resolve([card('pond', 'en')])
    await flush()
    expect([...result.current.vocabMap.keys()].sort()).toEqual(['otter', 'pond'])
    expect(result.current.isKnown('otter')).toBe(true)
  })

  it('aSaveAnsweredAfterAnotherIdentitySignedIn_AppliesNothing', async () => {
    api.getReaderVocab.mockResolvedValue([])
    const answer = deferred<unknown>()
    api.saveWord.mockReturnValueOnce(answer.promise)
    const { result, rerender } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    let saving!: Promise<unknown>
    act(() => { saving = result.current.addWord({ word: 'otter', language: 'en' } as never) })
    await flush()
    Object.assign(auth, { user: { id: 'u2' } })
    rerender()
    answer.resolve(saved('otter', 'en'))
    await act(async () => { await saving })
    await flush()
    expect(result.current.vocabMap.has('otter')).toBe(false)
    expect(result.current.isKnown('otter')).toBe(false)
  })

  it('aQueuedWordFlushedAcrossAnIdentityChange_AppliesNothing', async () => {
    api.getReaderVocab.mockResolvedValue([])
    pending.q1 = { id: 'q1', word: 'heron', language: 'en', createdAt: 1 } as never
    const flushed = deferred<unknown>()
    api.saveWord.mockReturnValueOnce(flushed.promise).mockImplementation(async (req: { word: string; language: string }) => saved(req.word, req.language))
    const { result, rerender } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    let saving!: Promise<unknown>
    act(() => { saving = result.current.addWord({ word: 'otter', language: 'en' } as never) })
    await flush()
    Object.assign(auth, { user: { id: 'u2' } })
    rerender()
    flushed.resolve(saved('heron', 'en'))
    await act(async () => { await saving })
    await flush()
    expect(result.current.vocabMap.has('heron')).toBe(false)
  })

  it('anotherIdentityWhileTheFlushRan_TheTappedWordIsNotSent', async () => {
    api.getReaderVocab.mockResolvedValue([])
    pending.q1 = { id: 'q1', word: 'heron', language: 'en', createdAt: 1 } as never
    const flushed = deferred<unknown>()
    api.saveWord.mockReturnValueOnce(flushed.promise).mockImplementation(async (req: { word: string; language: string }) => saved(req.word, req.language))
    const { result, rerender } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    let saving!: Promise<unknown>
    act(() => { saving = result.current.addWord({ word: 'otter', language: 'en' } as never) })
    await flush()
    Object.assign(auth, { user: { id: 'u2' } })
    rerender()
    flushed.resolve(saved('heron', 'en'))
    await act(async () => { expect(await saving).toBeNull() })
    expect(api.saveWord.mock.calls.map((c) => (c[0] as { word: string }).word)).toEqual(['heron'])
  })

  it('aTr2FillAnsweredForAnotherIdentity_AppliesNothing', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en')])
    const answer = deferred<unknown>()
    api.updateWord.mockReturnValueOnce(answer.promise)
    const { result, rerender } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.vocabMap.has('pond')).toBe(true))
    let filling!: Promise<unknown>
    act(() => { filling = result.current.updateTranslation('pond', 'ставок') })
    Object.assign(auth, { user: { id: 'u2' } })
    rerender()
    answer.resolve({ id: 'id-pond', translation: 'ставок' })
    await act(async () => { await filling })
    expect(result.current.vocabMap.get('pond')?.translation).toBeFalsy()
  })

  it('aCardRecordedForAnotherIdentity_AppliesNothing', async () => {
    api.getReaderVocab.mockResolvedValue([])
    const { result, rerender } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const asked = result.current.identity()
    Object.assign(auth, { user: { id: 'u2' } })
    rerender()
    act(() => result.current.recordSavedWord(saved('otter', 'en').word as never, asked))
    expect(result.current.vocabMap.has('otter')).toBe(false)
    act(() => result.current.recordSavedWord(saved('heron', 'en').word as never, result.current.identity()))
    expect(result.current.vocabMap.has('heron')).toBe(true)
  })

  it('aCardOfAnotherLanguage_DoesNotBlockTheSave', async () => {
    api.getReaderVocab.mockResolvedValue([card('gift', 'de'), card('pond', 'en')])
    const { result } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.isKnown('gift')).toBe(false)
    expect(result.current.isKnown('Pond')).toBe(true)
  })

  it('backfill_TheMapShowsTheTranslationTheServerKept_NotOurs', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', 'en')])
    // Another device filled it meanwhile: onlyIfEmpty keeps theirs, and the answer carries it.
    api.updateWord.mockResolvedValue({ id: 'id-pond', word: 'pond', translation: 'ставочок', stage: 0 })
    const { result } = renderHook(() => useReaderVocabulary('en', 'uk'))
    await waitFor(() => expect(api.updateWord).toHaveBeenCalledTimes(1))
    await flush()
    expect(result.current.vocabMap.get('pond')?.translation).toBe('ставочок')
  })

  it('theLegacyList_CardsWithNoLanguage_NotMarked_NotFilled', async () => {
    // V2 not answering: the list has no languages; the V2 reader marks and fills none of them.
    api.getReaderVocab.mockResolvedValue([card('pond', undefined), card('reed', undefined)])
    const { result } = renderHook(() => useReaderVocabulary('en', 'uk'))
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
    const { result } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.vocabMap.size).toBe(0)
    await act(async () => { await result.current.addWord({ word: 'pond', language: 'en' } as never) })
    expect(result.current.guestNudge).toBe('three')
  })
})
