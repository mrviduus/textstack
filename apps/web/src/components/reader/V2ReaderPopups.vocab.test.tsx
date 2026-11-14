import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V2Popup } from '../../../../mobile/src/lib/v2reader/wordPopup.mjs'

// #1270: a word tapped in the V2 reader is saved to the vocabulary as the legacy reader saves it (useReaderVocabulary),
// and each answer is shown as the legacy reader shows it.

const auth = { isAuthenticated: true, isGuest: false, ensureSession: vi.fn(async () => {}), openAuthModal: vi.fn() }
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
  promoteLookup: vi.fn(),
}
vi.mock('../../api/vocabulary', () => ({
  saveWord: (...a: unknown[]) => api.saveWord(...a),
  getReaderVocab: (...a: unknown[]) => api.getReaderVocab(...a),
  updateWord: (...a: unknown[]) => api.updateWord(...a),
  restoreWord: (...a: unknown[]) => api.restoreWord(...a),
  promoteLookup: (...a: unknown[]) => api.promoteLookup(...a),
  deleteWord: vi.fn(),
  markAsKnown: vi.fn(),
}))
let translation: (v: unknown) => void
vi.mock('../../api/translation', () => ({
  translate: () => new Promise((r) => { translation = r }),
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

const card = (word: string, extra: object = {}) => ({ id: `id-${word}`, word, stage: 0, translation: null, ...extra })
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
  Object.assign(auth, { isAuthenticated: true, isGuest: false })
  Object.assign(native, { hasConfirmedLanguage: true })
  for (const f of Object.values(api)) f.mockReset()
  api.getReaderVocab.mockResolvedValue([])
  api.updateWord.mockResolvedValue(card('pond', { translation: 'ставок' }))
  for (const k of Object.keys(pending)) delete pending[k]
  localStorage.clear()
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

  it('pending_QueuedForTomorrow', async () => {
    api.saveWord.mockResolvedValue({ ...saved('pond'), outcome: 'pending', word: null })
    show('pond')
    await settle()
    expect(screen.getByText('Daily cap reached — queued for tomorrow')).toBeInTheDocument()
  })

  it('lookup_TheRareWordNotice_AddAnywayPromotesIt', async () => {
    api.saveWord.mockResolvedValue({ ...saved('pond'), outcome: 'lookup', word: null, lookupId: 'l1', tapsRemaining: 2 })
    api.promoteLookup.mockResolvedValue(card('pond'))
    show('pond')
    await settle()
    fireEvent.click(screen.getByText('Add to SRS anyway'))
    await settle()
    expect(api.promoteLookup).toHaveBeenCalledWith('l1')
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
