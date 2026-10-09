import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// --- Mocks ---

const authState: { isAuthenticated: boolean; isGuest: boolean; sessionReadyDelayMs: number; ensureSession: () => Promise<void> } = {
  isAuthenticated: true,
  isGuest: false,
  sessionReadyDelayMs: 0,
  ensureSession: () => Promise.resolve(),
}

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: authState.isAuthenticated,
    isGuest: authState.isGuest,
    waitForSession: () =>
      authState.sessionReadyDelayMs > 0
        ? new Promise<void>((r) => setTimeout(r, authState.sessionReadyDelayMs))
        : Promise.resolve(),
    // I4: addWord зовёт ensureSession как fallback если !isAuthRef.current после waitForSession.
    ensureSession: () => authState.ensureSession(),
  }),
}))

const guestLimits = { commitmentThreshold: 3 }

vi.mock('../../context/GuestLimitsContext', () => ({
  useGuestLimits: () => ({
    commitmentThreshold: guestLimits.commitmentThreshold,
  }),
}))

const getReaderVocabMock = vi.fn()
const saveWordMock = vi.fn()

vi.mock('../../api/vocabulary', () => ({
  getReaderVocab: (...args: unknown[]) => getReaderVocabMock(...args),
  saveWord: (...args: unknown[]) => saveWordMock(...args),
  deleteWord: vi.fn(),
  markAsKnown: vi.fn(),
  updateWord: vi.fn(),
}))

const translateMock = vi.fn().mockResolvedValue({ translatedText: '' })
vi.mock('../../api/translation', () => ({
  translate: (...args: unknown[]) => translateMock(...args),
}))
vi.mock('../../api/explain', () => ({ explain: vi.fn() }))

// In-memory IndexedDB substitute controlled by the tests.
const pendingStore: Record<string, any> = {}
const addPendingMock = vi.fn(async (w: any) => { pendingStore[w.id] = w })
const listPendingMock = vi.fn(async () => Object.values(pendingStore).sort((a: any, b: any) => a.createdAt - b.createdAt))
const countPendingMock = vi.fn(async () => Object.keys(pendingStore).length)
const deletePendingMock = vi.fn(async (id: string) => { delete pendingStore[id] })

vi.mock('../../lib/offlineDb', () => ({
  addPendingVocabWord: (...args: unknown[]) => addPendingMock(...(args as [any])),
  listPendingVocabWords: (...args: unknown[]) => listPendingMock(...(args as [])),
  countPendingVocabWords: (...args: unknown[]) => countPendingMock(...(args as [])),
  deletePendingVocabWord: (...args: unknown[]) => deletePendingMock(...(args as [string])),
}))

// crypto.randomUUID polyfill for jsdom.
if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
  let seq = 0
  // @ts-ignore — minimal polyfill for test env
  globalThis.crypto = { ...(globalThis.crypto || {}), randomUUID: () => `uuid-${++seq}` }
}

// Import under test AFTER mocks are registered.
import { useReaderVocabulary } from '../useReaderVocabulary'
import { useBubbleTranslationSync, type BubbleLike } from '../useBubbleTranslationSync'
import { fetchWordBubble } from '../../lib/wordBubbleFetch'
import { useRef, useState } from 'react'

/** The real reader wiring: vocabulary + the bubble's sync effect + the bubble fetch. */
function useBubbleHarness(initial: BubbleLike, targetLang: string | null = 'pt', vocabTarget = targetLang) {
  const vocab = useReaderVocabulary('en', vocabTarget)
  const [bubble, setBubble] = useState<BubbleLike | null>(initial)
  const abortRef = useRef<AbortController | null>(null)
  useBubbleTranslationSync<BubbleLike>({
    bubble, setBubble, vocabMap: vocab.vocabMap, updateTranslation: vocab.updateTranslation,
    targetLang, bookLanguage: 'en', abortRef,
  })
  const open = () => fetchWordBubble({
    word: initial.word, bookLanguage: 'en', targetLang, explainInContext: false,
    signal: new AbortController().signal,
    patch: (f) => setBubble((b) => (b ? { ...b, ...f } as BubbleLike : b)),
    sentence: initial.sentence,
  })
  return { vocab, open, bubble }
}

describe('useReaderVocabulary', () => {
  beforeEach(() => {
    authState.isAuthenticated = true
    authState.isGuest = false
    localStorage.clear()
    authState.sessionReadyDelayMs = 0
    authState.ensureSession = () => Promise.resolve()
    getReaderVocabMock.mockReset()
    saveWordMock.mockReset()
    addPendingMock.mockClear()
    listPendingMock.mockClear()
    countPendingMock.mockClear()
    deletePendingMock.mockClear()
    for (const k of Object.keys(pendingStore)) delete pendingStore[k]
    guestLimits.commitmentThreshold = 3
    getReaderVocabMock.mockResolvedValue([])
    translateMock.mockResolvedValue({ translatedText: '' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('TR-2: updateTranslation is the one PATCH path and never overwrites a saved translation (already_saved)', async () => {
    const { updateWord } = await import('../../api/vocabulary')
    saveWordMock.mockResolvedValue({
      outcome: 'already_saved',
      word: { id: 'w1', word: 'wound', stage: 1, translation: 'ferida' },
      pendingId: null,
      reason: null,
    })
    const { result } = renderHook(() => useReaderVocabulary('en', 'pt'))
    await waitFor(() => expect(getReaderVocabMock).toHaveBeenCalled())
    await act(async () => { await result.current.addWord({ word: 'wound', language: 'en' }) })

    await act(async () => { await result.current.updateTranslation('wound', 'enrolou') })

    expect(updateWord).not.toHaveBeenCalled()
    expect(result.current.vocabMap.get('wound')?.translation).toBe('ferida')
  })

  it('TR-2: the bubble never replaces a saved translation, not even from the sentence it was saved with', async () => {
    const { updateWord } = await import('../../api/vocabulary')
    const S = 'He pocketed the coins and walked out.'
    getReaderVocabMock.mockResolvedValue([{ id: 'w1', word: 'pocketed', stage: 1, translation: 'enterrado' }])
    translateMock.mockResolvedValue({ translatedText: 'embolsou' })
    const { result } = renderHook(() => useBubbleHarness({
      word: 'pocketed', translation: null, translationLoading: true, sentence: S,
    }))
    await waitFor(() => expect(result.current.vocab.vocabMap.get('pocketed')?.translation).toBe('enterrado'))

    await act(async () => { result.current.open() })
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(result.current.bubble?.translation).toBe('embolsou')
    expect(updateWord).not.toHaveBeenCalled()
    expect(result.current.vocab.vocabMap.get('pocketed')?.translation).toBe('enterrado')
  })

  it('TR-2: a mid-popup language switch does not fill an empty saved translation (display-only)', async () => {
    const { updateWord } = await import('../../api/vocabulary')
    getReaderVocabMock.mockResolvedValue([{ id: 'w1', word: 'pocketed', stage: 1, translation: null }])
    translateMock.mockResolvedValue({ translatedText: 'eingesteckt' })
    const { result, rerender } = renderHook(({ lang }) => useBubbleHarness({
      word: 'pocketed', translation: null, translationLoading: false, sentence: 'S.',
    }, lang, null), { initialProps: { lang: 'pt' as string | null } }) // vocab backfill off: the popup path only
    await waitFor(() => expect(result.current.vocab.vocabMap.has('pocketed')).toBe(true))

    rerender({ lang: 'de' })
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(result.current.bubble?.translation).toBe('eingesteckt')
    expect(updateWord).not.toHaveBeenCalled()
    expect(result.current.vocab.vocabMap.get('pocketed')?.translation).toBeFalsy()
    // TR-3: tagged so the popup offers no "Use this translation" for a switched translation.
    expect(result.current.bubble).toMatchObject({ translationLang: 'de', langSwitched: true })
  })

  it('TR-3: replaceTranslation PATCHes the bubble translation explicitly, once, and updates the map', async () => {
    const { updateWord } = await import('../../api/vocabulary')
    getReaderVocabMock.mockResolvedValue([{ id: 'w1', word: 'pocketed', stage: 1, translation: 'enterrado' }])
    vi.mocked(updateWord).mockResolvedValue({ id: 'w1', word: 'pocketed', translation: 'embolsou' } as never)
    const { result } = renderHook(() => useReaderVocabulary('en', 'pt'))
    await waitFor(() => expect(result.current.vocabMap.get('pocketed')?.translation).toBe('enterrado'))

    await act(async () => { await result.current.replaceTranslation('pocketed', 'embolsou') })

    expect(updateWord).toHaveBeenCalledTimes(1)
    expect(updateWord).toHaveBeenCalledWith('w1', { translation: 'embolsou' })
    expect(result.current.vocabMap.get('pocketed')?.translation).toBe('embolsou')
  })

  it('TR-2: updateTranslation PATCHes a saved word that has no translation yet', async () => {
    const { updateWord } = await import('../../api/vocabulary')
    vi.mocked(updateWord).mockResolvedValue({ id: 'w1', word: 'wound', translation: 'ferida' } as never)
    saveWordMock.mockResolvedValue({
      outcome: 'saved',
      word: { id: 'w1', word: 'wound', stage: 0, translation: null },
      pendingId: null,
      reason: null,
    })
    const { result } = renderHook(() => useReaderVocabulary('en', 'pt'))
    await waitFor(() => expect(getReaderVocabMock).toHaveBeenCalled())
    await act(async () => { await result.current.addWord({ word: 'wound', language: 'en' }) })

    await act(async () => { await result.current.updateTranslation('wound', 'ferida') })

    expect(updateWord).toHaveBeenCalledWith('w1', { translation: 'ferida', onlyIfEmpty: true })
    expect(result.current.vocabMap.get('wound')?.translation).toBe('ferida')
  })

  it('TR-2: updateTranslation takes the map from the PATCH response — the server kept its stored translation', async () => {
    const { updateWord } = await import('../../api/vocabulary')
    // Another device filled it first: onlyIfEmpty is ignored server-side, the stored value comes back.
    vi.mocked(updateWord).mockResolvedValue({ id: 'w1', word: 'wound', translation: 'ferimento' } as never)
    getReaderVocabMock.mockResolvedValue([{ id: 'w1', word: 'wound', stage: 0, translation: null }])
    const { result } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.vocabMap.has('wound')).toBe(true))

    await act(async () => { await result.current.updateTranslation('wound', 'ferida') })

    expect(result.current.vocabMap.get('wound')?.translation).toBe('ferimento')
  })

  it('TR-2: updateTranslation does not mark the word filled when the PATCH fails', async () => {
    const { updateWord } = await import('../../api/vocabulary')
    vi.mocked(updateWord).mockRejectedValue(new Error('offline'))
    getReaderVocabMock.mockResolvedValue([{ id: 'w1', word: 'wound', stage: 0, translation: null }])
    const { result } = renderHook(() => useReaderVocabulary('en', null))
    await waitFor(() => expect(result.current.vocabMap.has('wound')).toBe(true))

    await act(async () => { await result.current.updateTranslation('wound', 'ferida') })

    expect(updateWord).toHaveBeenCalledTimes(1)
    expect(result.current.vocabMap.get('wound')?.translation).toBeFalsy()
  })

  it('TR-2: the mount backfill is an automatic fill and sends onlyIfEmpty', async () => {
    const { updateWord } = await import('../../api/vocabulary')
    vi.mocked(updateWord).mockResolvedValue(undefined as never)
    getReaderVocabMock.mockResolvedValue([{ id: 'w9', word: 'garden', stage: 0, translation: null }])
    translateMock.mockResolvedValue({ translatedText: 'jardim' })

    renderHook(() => useReaderVocabulary('en', 'pt'))

    await waitFor(() => expect(updateWord).toHaveBeenCalledWith('w9', { translation: 'jardim', onlyIfEmpty: true }))
  })

  it('calls getReaderVocab on mount when isAuthenticated=true', async () => {
    renderHook(() => useReaderVocabulary('en', 'de'))
    await waitFor(() => expect(getReaderVocabMock).toHaveBeenCalledTimes(1))
  })

  it('does not call getReaderVocab when !isAuthenticated (no session yet)', async () => {
    authState.isAuthenticated = false
    renderHook(() => useReaderVocabulary('en', 'de'))
    await Promise.resolve()
    expect(getReaderVocabMock).not.toHaveBeenCalled()
  })

  it('addWord hits saveWord API when authenticated and dedupes repeats', async () => {
    saveWordMock.mockResolvedValue({
      outcome: 'srs',
      word: { id: 'w1', word: 'Hello', stage: 0, translation: null },
      pendingId: null,
      reason: null,
    })
    const { result } = renderHook(() => useReaderVocabulary('en', 'de'))
    await waitFor(() => expect(getReaderVocabMock).toHaveBeenCalled())

    await act(async () => {
      await result.current.addWord({ word: 'Hello', language: 'en' })
    })
    expect(saveWordMock).toHaveBeenCalledTimes(1)
    expect(result.current.vocabMap.has('hello')).toBe(true)

    await act(async () => {
      await result.current.addWord({ word: 'Hello', language: 'en' })
    })
    expect(saveWordMock).toHaveBeenCalledTimes(2)
    expect(result.current.vocabMap.size).toBe(1)
  })

  it('accumulates words locally until commitment threshold (I1, I2)', async () => {
    // Anon: саму-то session ещё нет, threshold=3. Ожидаем: 2 слова — local-only, 3-е — trigger ensureSession + flush.
    authState.isAuthenticated = false
    let ensureCalled = 0
    authState.ensureSession = async () => { ensureCalled++ }

    saveWordMock.mockImplementation(async (req: any) => ({
      outcome: 'srs',
      word: { id: `backend-${req.word}`, word: req.word, stage: 0, translation: null },
      pendingId: null,
      reason: null,
    }))

    const { result } = renderHook(() => useReaderVocabulary('en', 'de'))

    await act(async () => { await result.current.addWord({ word: 'one', language: 'en' }) })
    await act(async () => { await result.current.addWord({ word: 'two', language: 'en' }) })

    expect(saveWordMock).not.toHaveBeenCalled()
    expect(ensureCalled).toBe(0)
    expect(addPendingMock).toHaveBeenCalledTimes(2)
    expect(Object.keys(pendingStore).length).toBe(2)

    // 3rd word: triggers ensureSession. Guest create fails to flip isAuth in this test setup
    // (we don't fake backend cookie), so flush won't happen — but ensureSession MUST be called.
    await act(async () => { await result.current.addWord({ word: 'three', language: 'en' }) })
    expect(addPendingMock).toHaveBeenCalledTimes(3)
    expect(ensureCalled).toBe(1)
  })

  it('a pending word removed before the guest mint is not flushed to the account (M3)', async () => {
    authState.isAuthenticated = false
    const { result } = renderHook(() => useReaderVocabulary('en', 'de'))
    await act(async () => { await result.current.addWord({ word: 'one', language: 'en' }) })
    const id = result.current.vocabMap.get('one')!.id!

    await act(async () => { await result.current.removeWord(id, 'one') })

    expect(deletePendingMock).toHaveBeenCalledWith(id)
    expect(Object.keys(pendingStore)).toHaveLength(0)
    expect(result.current.vocabMap.has('one')).toBe(false)
  })

  describe('create-account nudge', () => {
    const echoSave = async (req: any) => ({
      outcome: 'srs',
      word: { id: `backend-${req.word}`, word: req.word, stage: 0, translation: null },
      pendingId: null,
      reason: null,
    })
    const save = async (result: any, words: string[]) => {
      for (const w of words) await act(async () => { await result.current.addWord({ word: w, language: 'en' }) })
    }

    it('guest: nudges on the 3rd and 10th saved word, each once', async () => {
      authState.isGuest = true
      saveWordMock.mockImplementation(echoSave)
      const { result } = renderHook(() => useReaderVocabulary('en', 'de'))
      await waitFor(() => expect(getReaderVocabMock).toHaveBeenCalled())

      await save(result, ['a', 'b'])
      expect(result.current.guestNudge).toBe(null)
      await save(result, ['c'])
      expect(result.current.guestNudge).toBe('three')
      act(() => result.current.dismissGuestNudge())
      await save(result, ['d', 'e', 'f', 'g', 'h', 'i'])
      expect(result.current.guestNudge).toBe(null)
      await save(result, ['j'])
      expect(result.current.guestNudge).toBe('ten')
      act(() => result.current.dismissGuestNudge())
      await save(result, ['k'])
      expect(result.current.guestNudge).toBe(null)
    })

    it('anonymous reader: the 3rd word (the one that mints the guest) nudges', async () => {
      authState.isAuthenticated = false
      const { result } = renderHook(() => useReaderVocabulary('en', 'de'))
      await save(result, ['one', 'two', 'three'])
      expect(result.current.guestNudge).toBe('three')
    })

    it('account: never nudged', async () => {
      saveWordMock.mockImplementation(echoSave)
      const { result } = renderHook(() => useReaderVocabulary('en', 'de'))
      await waitFor(() => expect(getReaderVocabMock).toHaveBeenCalled())
      await save(result, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
      expect(result.current.guestNudge).toBe(null)
      expect(localStorage.getItem('guestNudge.three')).toBe(null)
    })
  })

  it('flushes pending pre-save when session acquired externally (I5)', async () => {
    // Pre-populate pending as if user saved 2 words as anon, then logged in elsewhere.
    pendingStore['p1'] = { id: 'p1', word: 'alpha', language: 'en', createdAt: 1 }
    pendingStore['p2'] = { id: 'p2', word: 'beta', language: 'en', createdAt: 2 }

    authState.isAuthenticated = true
    saveWordMock.mockImplementation(async (req: any) => ({
      outcome: 'srs',
      word: { id: `backend-${req.word}`, word: req.word, stage: 0, translation: null },
      pendingId: null,
      reason: null,
    }))

    const { result } = renderHook(() => useReaderVocabulary('en', 'de'))
    await waitFor(() => expect(getReaderVocabMock).toHaveBeenCalled())

    await act(async () => {
      await result.current.addWord({ word: 'gamma', language: 'en' })
    })

    // Expect: 2 pending flushed + 1 current = 3 saveWord calls, pending store emptied.
    expect(saveWordMock).toHaveBeenCalledTimes(3)
    expect(Object.keys(pendingStore).length).toBe(0)
  })

  it('keeps pending on flush fail, does not lose data (I4, I7)', async () => {
    pendingStore['p1'] = { id: 'p1', word: 'alpha', language: 'en', createdAt: 1 }
    pendingStore['p2'] = { id: 'p2', word: 'beta', language: 'en', createdAt: 2 }
    pendingStore['p3'] = { id: 'p3', word: 'gamma', language: 'en', createdAt: 3 }

    authState.isAuthenticated = true
    let call = 0
    saveWordMock.mockImplementation(async (req: any) => {
      call++
      if (call === 2) throw new Error('flaky backend')
      return {
        outcome: 'srs',
        word: { id: `backend-${req.word}`, word: req.word, stage: 0, translation: null },
        pendingId: null,
        reason: null,
      }
    })

    const { result } = renderHook(() => useReaderVocabulary('en', 'de'))
    await waitFor(() => expect(getReaderVocabMock).toHaveBeenCalled())

    await act(async () => {
      try { await result.current.addWord({ word: 'delta', language: 'en' }) } catch {}
    })

    // alpha flushed (1st call, success) → removed from pending.
    // beta flush fails (2nd call) → pending still has beta + gamma.
    // Then `delta` (Path A after flush) — not reached because we stopped flush loop on beta's error
    // and the flushPendingIfAny catches the throw? Actually flushPendingIfAny has try/catch per iter
    // with break on catch. So it stops after beta fails. Then current addWord proceeds to saveWord(delta).
    // But saveWord for delta is call #3 → succeeds in mock.
    // Conclusion: alpha removed, beta + gamma remain, delta persisted.
    expect(pendingStore['p1']).toBeUndefined()
    expect(pendingStore['p2']).toBeDefined()
    expect(pendingStore['p3']).toBeDefined()
  })

  it('addWord awaits waitForSession before hitting saveWord (B2 gate)', async () => {
    authState.isAuthenticated = false
    authState.sessionReadyDelayMs = 50
    saveWordMock.mockResolvedValue({
      outcome: 'srs',
      word: { id: 'w1', word: 'late', stage: 0, translation: null },
      pendingId: null,
      reason: null,
    })

    const { result, rerender } = renderHook(() => useReaderVocabulary('en', 'de'))

    let pending: Promise<unknown>
    await act(async () => {
      pending = result.current.addWord({ word: 'late', language: 'en' })
    })
    expect(saveWordMock).not.toHaveBeenCalled()

    // Simulate session becoming ready with auth flipping true.
    authState.isAuthenticated = true
    authState.sessionReadyDelayMs = 0
    rerender()

    await act(async () => {
      await pending
    })

    expect(saveWordMock).toHaveBeenCalledTimes(1)
  })
})
