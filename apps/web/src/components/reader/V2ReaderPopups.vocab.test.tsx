import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V2Popup } from '../../../../../packages/reader/src/wordPopup.mjs'

// #1270: a word tapped in the V2 reader is saved to the vocabulary as the legacy reader saves it (useReaderVocabulary),
// and each answer is shown as the legacy reader shows it.

const auth: { isAuthenticated: boolean; isGuest: boolean; user?: { id: string }; ensureSession: () => Promise<void>; openAuthModal: () => void } =
  { isAuthenticated: true, isGuest: false, user: { id: 'u1' }, ensureSession: vi.fn(async () => {}), openAuthModal: vi.fn() }
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ ...auth, waitForSession: async () => {} }),
}))
vi.mock('../../context/GuestLimitsContext', () => ({ useGuestLimits: () => ({ commitmentThreshold: 3 }) }))
const native = { nativeLanguage: 'uk', hasConfirmedLanguage: true, setNativeLanguage: vi.fn() }
vi.mock('../../context/NativeLanguageContext', () => ({ useNativeLanguage: () => native }))

const api = {
  saveWord: vi.fn(),
  getReaderVocab: vi.fn(),
  updateWord: vi.fn(),
  restoreWord: vi.fn(),
}
vi.mock('../../api/vocabulary', () => ({
  saveWord: (...a: unknown[]) => api.saveWord(...a),
  getReaderVocab: (...a: unknown[]) => api.getReaderVocab(...a),
  updateWord: (...a: unknown[]) => api.updateWord(...a),
  restoreWord: (...a: unknown[]) => api.restoreWord(...a),
  deleteWord: vi.fn(),
}))
let translation: (v: unknown) => void
/** #1271: what the hook's backfill (word, from, to) is answered; unset, it never answers. */
let backfill: ((a: unknown[]) => unknown) | null = null
vi.mock('../../api/translation', () => ({
  // The popup's own request (it passes a signal) resolves through `translation`; the hook's backfill (three
  // arguments) never answers, so a test sees only the popup's translation path.
  translate: (...a: unknown[]) => new Promise((r) => { if (a.length > 3) translation = r; else if (backfill) r(backfill(a)) }),
  getLanguages: async () => [],
}))
const pending: Record<string, { id: string }> = {}
vi.mock('../../lib/offlineDb', async (orig) => ({
  ...(await orig<object>()),
  addPendingVocabWord: async (w: { id: string }) => { pending[w.id] = w },
  listPendingVocabWords: async () => Object.values(pending),
  countPendingVocabWords: async () => Object.keys(pending).length,
  deletePendingVocabWord: async (id: string) => { delete pending[id] },
}))

import { V2ReaderPopups } from './V2ReaderPopups'

// A V2 card always has its language (the reader marks and fills by it).
const card = (word: string, extra: object = {}) => ({ id: `id-${word}`, word, stage: 0, translation: null, language: 'en', ...extra })
const saved = (word: string) => ({ outcome: 'srs', word: card(word), lookupId: null, tapsRemaining: null, pendingId: null, reason: null })
const popup = (w: string): V2Popup => ({ kind: 'word', index: 0, word: w, sentence: `By the ${w}.`, cfi: null, rect: { x: 400, y: 100, w: 30, h: 10 } })
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

function show(w: string, props: { bookId?: string } = { bookId: 'book-1' }) {
  const frame = createRef<HTMLIFrameElement>()
  const el = (p: V2Popup) => <V2ReaderPopups frame={frame} bookLanguage="en" bookTitle="Walden" onClose={() => {}} {...props} popup={p} />
  const first = popup(w)
  const view = render(el(first))
  return { ...view, popup: first, next: (x: string) => view.rerender(el(popup(x))) }
}

beforeEach(() => {
  Object.assign(auth, { isAuthenticated: true, isGuest: false, user: { id: 'u1' } })
  Object.assign(native, { hasConfirmedLanguage: true })
  for (const f of Object.values(api)) f.mockReset()
  api.getReaderVocab.mockResolvedValue([])
  api.updateWord.mockResolvedValue(card('pond', { translation: 'ставок' }))
  for (const k of Object.keys(pending)) delete pending[k]
  localStorage.clear()
  backfill = null
})
afterEach(cleanup)

describe('V2ReaderPopups vocabulary save', () => {
  it('aWordTapped_SavedWithItsSentenceBookAndLanguage_ThenItsTranslation', async () => {
    api.saveWord.mockResolvedValue(saved('pond'))
    show('pond')
    await settle()
    expect(api.saveWord).toHaveBeenCalledTimes(1)
    expect(api.saveWord.mock.calls[0][0]).toMatchObject({
      word: 'pond', language: 'en', userBookId: 'book-1', sentence: 'By the pond.', bookTitle: 'Walden', nativeLanguage: 'uk',
    })
    await act(async () => { translation({ translatedText: 'ставок' }) })
    await settle()
    // TR-2: the translation fills the untranslated card, never replaces one.
    expect(api.updateWord).toHaveBeenCalledWith('id-pond', { translation: 'ставок', onlyIfEmpty: true })
  })

  it('theSameWordAgain_NotSavedTwice', async () => {
    api.saveWord.mockResolvedValue(saved('pond'))
    const v = show('pond')
    await settle()
    v.next('Pond')
    await settle()
    expect(api.saveWord).toHaveBeenCalledTimes(1)
  })

  it('aWordAlreadyInTheVocabulary_NotSavedAgain', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond')])
    api.saveWord.mockImplementation(async (r: { word: string }) => saved(r.word))
    const v = show('woods')
    await settle()
    v.next('Pond')
    await settle()
    expect(api.saveWord.mock.calls.map((c) => c[0].word)).toEqual(['woods'])
  })

  it('aLanguageSwitchedMidPopup_ItsTranslationIsDisplayOnly', async () => {
    api.saveWord.mockResolvedValue(saved('pond'))
    const v = show('pond')
    await settle()
    native.nativeLanguage = 'de'
    try {
      v.rerender(<V2ReaderPopups frame={createRef()} bookLanguage="en" bookTitle="Walden" bookId="book-1" onClose={() => {}} popup={v.popup} />)
      await act(async () => { translation({ translatedText: 'Teich' }) })
      await settle()
      expect(api.updateWord).not.toHaveBeenCalled()
    } finally {
      native.nativeLanguage = 'uk'
    }
  })

  it('aTapWhileTheReadersWordsLoad_SavedOnceTheyLand_NotWhenTheWordIsAmongThem', async () => {
    let land: (w: unknown[]) => void = () => {}
    api.getReaderVocab.mockReturnValue(new Promise((r) => { land = r }))
    api.saveWord.mockImplementation(async (r: { word: string }) => saved(r.word))
    show('pond')
    await settle()
    expect(api.saveWord).not.toHaveBeenCalled()
    await act(async () => { land([card('pond')]) })
    await settle()
    expect(api.saveWord).not.toHaveBeenCalled()
    cleanup()
    api.getReaderVocab.mockReturnValue(new Promise((r) => { land = r }))
    show('woods')
    await settle()
    await act(async () => { land([]) })
    await settle()
    expect(api.saveWord.mock.calls.map((c) => c[0].word)).toEqual(['woods'])
  })

  it('aFailedLoad_NothingSaved_TheNextTapRetriesTheLoad_ThenSaves', async () => {
    api.getReaderVocab.mockRejectedValueOnce(new Error('503')).mockResolvedValue([])
    api.saveWord.mockImplementation(async (r: { word: string }) => saved(r.word))
    const v = show('pond')
    await settle()
    expect(api.saveWord).not.toHaveBeenCalled()
    expect(api.getReaderVocab).toHaveBeenCalledTimes(1)
    v.next('woods')
    await settle()
    expect(api.getReaderVocab).toHaveBeenCalledTimes(2)
    expect(api.saveWord.mock.calls.map((c) => c[0].word)).toEqual(['woods'])
  })

  it('aLanguagePickedInTheFooter_ItsTranslationFillsTheCard', async () => {
    Object.assign(native, { nativeLanguage: 'uk', hasConfirmedLanguage: false })
    api.saveWord.mockResolvedValue(saved('pond'))
    const v = show('pond')
    await settle()
    expect(api.saveWord).not.toHaveBeenCalled()
    Object.assign(native, { nativeLanguage: 'de', hasConfirmedLanguage: true })
    try {
      v.rerender(<V2ReaderPopups frame={createRef()} bookLanguage="en" bookTitle="Walden" bookId="book-1" onClose={() => {}} popup={v.popup} />)
      await settle()
      expect(api.saveWord).toHaveBeenCalledTimes(1)
      await act(async () => { translation({ translatedText: 'Teich' }) })
      await settle()
      expect(api.updateWord).toHaveBeenCalledWith('id-pond', { translation: 'Teich', onlyIfEmpty: true })
    } finally {
      native.nativeLanguage = 'uk'
    }
  })

  it('aFailedSave_ARetapRetries', async () => {
    api.saveWord.mockRejectedValueOnce(new Error('503')).mockImplementation(async (r: { word: string }) => saved(r.word))
    const v = show('pond')
    await settle()
    v.next('woods')
    await settle()
    v.next('pond')
    await settle()
    expect(api.saveWord.mock.calls.map((c) => c[0].word)).toEqual(['pond', 'woods', 'pond'])
  })

  it('noServerBook_NothingSaved', async () => {
    show('pond', {})
    await settle()
    expect(api.saveWord).not.toHaveBeenCalled()
  })

  it('noConfirmedLanguage_NotSaved_UntilTheReaderPicksOne', async () => {
    native.hasConfirmedLanguage = false
    api.saveWord.mockResolvedValue(saved('pond'))
    const v = show('pond')
    await settle()
    expect(api.saveWord).not.toHaveBeenCalled()
    native.hasConfirmedLanguage = true
    v.next('pond')
    await settle()
    expect(api.saveWord).toHaveBeenCalledTimes(1)
  })

  it('deleted_TheRestoreOffer_RestoreBringsItBack', async () => {
    api.saveWord.mockResolvedValue({ ...saved('pond'), outcome: 'deleted' })
    api.restoreWord.mockResolvedValue(card('pond'))
    show('pond')
    await settle()
    expect(screen.getByText('You deleted “pond” earlier.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await settle()
    expect(api.restoreWord).toHaveBeenCalledWith('id-pond')
  })

  it('aGuestsThirdWord_TheNudge', async () => {
    Object.assign(auth, { isGuest: true })
    api.getReaderVocab.mockResolvedValue([card('a'), card('b')])
    api.saveWord.mockResolvedValue(saved('pond'))
    show('pond')
    await settle()
    expect(screen.getByText('3 words saved. Keep them — create a free account.')).toBeInTheDocument()
  })

  it('noSessionYet_TheThirdWordMintsIt', async () => {
    Object.assign(auth, { isAuthenticated: false })
    const v = show('one')
    await settle()
    v.next('two')
    await settle()
    expect(auth.ensureSession).not.toHaveBeenCalled()
    v.next('three')
    await settle()
    expect(auth.ensureSession).toHaveBeenCalledTimes(1)
    expect(api.saveWord).not.toHaveBeenCalled()
  })
})

describe('V2ReaderPopups saved-word marks (#1271)', () => {
  const frame = createRef<HTMLIFrameElement>()
  const mount = (onMarks: (w: unknown) => void) =>
    render(<V2ReaderPopups frame={frame} bookLanguage="en" bookTitle="Walden" bookId="book-1" onClose={() => {}} popup={null} onMarks={onMarks} />)

  it('theReadersWords_ReadOnce_SentWithStageAndTranslation_ThenASavedWord', async () => {
    api.getReaderVocab.mockResolvedValue([card('pond', { stage: 3, translation: 'ставок' }), card('reed', { stage: 1 })])
    const onMarks = vi.fn()
    const view = mount(onMarks)
    await settle()
    expect(api.getReaderVocab).toHaveBeenCalledTimes(1)
    expect(onMarks).toHaveBeenLastCalledWith([{ word: 'pond', stage: 3, gloss: 'ставок' }, { word: 'reed', stage: 1, gloss: null }])
    // A word saved: kept in memory and marked, no second read.
    api.saveWord.mockResolvedValue(saved('heron'))
    view.rerender(<V2ReaderPopups frame={frame} bookLanguage="en" bookTitle="Walden" bookId="book-1" onClose={() => {}} popup={popup('heron')} onMarks={onMarks} />)
    await settle()
    expect(onMarks.mock.lastCall![0]).toContainEqual({ word: 'heron', stage: 0, gloss: null })
    expect(api.getReaderVocab).toHaveBeenCalledTimes(1)
  })

  it('missingTranslations_BackfilledOnce_ThenMarkedWithThem', async () => {
    api.getReaderVocab.mockResolvedValue([card('reed', { stage: 1 })])
    backfill = (a) => ({ translatedText: `uk:${a[0]}` })
    // The card had none: onlyIfEmpty writes ours, and the answer carries it.
    api.updateWord.mockImplementation(async (id: string, d: { translation: string }) => card('reed', { id, stage: 1, translation: d.translation }))
    const onMarks = vi.fn()
    mount(onMarks)
    await settle()
    await settle()
    expect(onMarks).toHaveBeenLastCalledWith([{ word: 'reed', stage: 1, gloss: 'uk:reed' }])
    expect(api.updateWord).toHaveBeenCalledWith('id-reed', { translation: 'uk:reed', onlyIfEmpty: true })
  })

  it('onlyTheBooksLanguage_MarkedAndBackfilled_AnotherLanguagesCardNeverWritten', async () => {
    api.getReaderVocab.mockResolvedValue([card('reed', { language: 'en-GB' }), card('hund', { language: 'de' }), card('pond', { stage: 2 })])
    const asked = vi.fn((a: unknown[]) => ({ translatedText: `uk:${a[0]}` }))
    backfill = asked
    const onMarks = vi.fn()
    mount(onMarks)
    await settle()
    await settle()
    expect(onMarks.mock.lastCall![0].map((w: { word: string }) => w.word)).toEqual(['reed', 'pond'])
    expect(asked.mock.calls.map((c) => (c[0] as unknown[])[0])).toEqual(['reed', 'pond'])
    expect(api.updateWord.mock.calls.map((c) => c[0])).toEqual(['id-reed', 'id-pond'])
  })

  it('signedInAfterMount_TheLoadedWordsBackfilledOnce', async () => {
    Object.assign(auth, { isAuthenticated: false })
    api.getReaderVocab.mockResolvedValue([card('reed', { language: 'en' })])
    const asked = vi.fn((a: unknown[]) => ({ translatedText: `uk:${a[0]}` }))
    backfill = asked
    const el = () => <V2ReaderPopups frame={frame} bookLanguage="en" bookTitle="Walden" bookId="book-1" onClose={() => {}} popup={null} onMarks={vi.fn()} />
    const view = render(el())
    await settle()
    Object.assign(auth, { isAuthenticated: true })
    view.rerender(el())
    await settle()
    await settle()
    view.rerender(el())
    await settle()
    expect(asked).toHaveBeenCalledTimes(1)
    expect(api.updateWord).toHaveBeenCalledTimes(1)
  })

  it('aWriteAnswered429_TheBackfillStops', async () => {
    api.getReaderVocab.mockResolvedValue([card('reed'), card('pond')])
    api.updateWord.mockRejectedValue(Object.assign(new Error('slow down'), { status: 429 }))
    const asked = vi.fn((a: unknown[]) => ({ translatedText: `uk:${a[0]}` }))
    backfill = asked
    mount(vi.fn())
    await settle()
    await settle()
    expect(asked).toHaveBeenCalledTimes(1)
    expect(api.updateWord).toHaveBeenCalledTimes(1)
  })

  it('aWordSavedDuringTheOpen_NotBackfilled_OnlyTheLoadedOnesAre', async () => {
    api.getReaderVocab.mockResolvedValue([])
    const asked = vi.fn((a: unknown[]) => ({ translatedText: `uk:${a[0]}` }))
    backfill = asked
    api.saveWord.mockResolvedValue(saved('heron'))
    const view = mount(vi.fn())
    await settle()
    view.rerender(<V2ReaderPopups frame={frame} bookLanguage="en" bookTitle="Walden" bookId="book-1" onClose={() => {}} popup={popup('heron')} onMarks={vi.fn()} />)
    await settle()
    await settle()
    expect(api.saveWord).toHaveBeenCalledTimes(1)
    expect(asked).not.toHaveBeenCalled()
  })
})

describe('V2ReaderPopups: a save that sent nothing (#1271 review)', () => {
  it('theIdentityChangedWhileTheFlushRan_NothingSent_TheWordStillSavedOnce', async () => {
    api.getReaderVocab.mockResolvedValue([])
    pending.q1 = { id: 'q1', word: 'heron', language: 'en', createdAt: 1 } as never
    let flushed!: (v: unknown) => void
    api.saveWord.mockReturnValueOnce(new Promise((r) => { flushed = r })).mockResolvedValue(saved('pond'))
    const view = show('pond')
    await settle()
    // The tap's save waits on the flush; another identity signs in meanwhile.
    Object.assign(auth, { user: { id: 'u2' } })
    view.next('pond')
    flushed(saved('heron'))
    await settle()
    await settle()
    view.next('pond')
    await settle()
    await settle()
    // The tap under the old identity sent nothing, and did not spend the word: it is saved once, for the new one.
    expect(api.saveWord.mock.calls.map((c) => (c[0] as { word: string }).word)).toEqual(['heron', 'pond'])
  })
})
