import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'

// #1269: the word popup, the selection toolbar, translation and explain of the V2 reader on the web, fetched by the
// host (the page has no network), driven through a fake frame as V2ReaderHost.chrome.test.tsx.

const translate = vi.fn()
vi.mock('../../api/translation', () => ({ translate: (...a: unknown[]) => translate(...a), getLanguages: async () => [] }))
const postSse = vi.fn()
vi.mock('../../lib/sse', () => ({ postSse: (...a: unknown[]) => postSse(...a), SseUnsupportedError: class extends Error {} }))

const WIDTH = 1000
const frame = () => screen.getByTitle('V2 reader') as HTMLIFrameElement
let posted: { call: string; args: unknown[] }[]

beforeEach(() => {
  localStorage.clear()
  posted = []
  translate.mockReset().mockResolvedValue({ translatedText: 'Teich', sourceLang: 'en', targetLang: 'de' })
  postSse.mockReset()
})
afterEach(cleanup)

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}

/** A book open on screen; `lang`: `opened.lang`. */
function opened({ lang = 'de', dev = true, annotatable = true }: { lang?: unknown; dev?: boolean; annotatable?: boolean } = {}) {
  const book: V2HostBook = { bytes: new ArrayBuffer(8), name: 'a.epub' }
  render(<MemoryRouter><V2ReaderHost book={book} idleHeading="idle" dev={dev} /></MemoryRouter>)
  Object.defineProperty(frame(), 'clientWidth', { value: WIDTH, configurable: true })
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', lang, annotatable, book: { sha256: 'aa', size: 8, name: '1/a.epub' } })
  posted = []
}
const word = (w = 'pond', x = WIDTH / 2 - 15) => ({ type: 'word', word: w, sentence: `By the ${w}.`, cfi: 'epubcfi(/6/2)', index: 0, rect: { x, y: 100, w: 30, h: 10 } })
const selection = (text = 'by the pond') => ({ type: 'selection', text, sentence: 'By the pond.', cfi: 'epubcfi(/6/2)', index: 0, rect: { x: 400, y: 100, w: 200, h: 10 } })
const calls = (name: string) => posted.filter((m) => m.call === name)
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('V2ReaderHost word popup and selection toolbar', () => {
  it('centreWord_OpensThePopup_TranslatedFromTheBooksLanguage_WithThePickerInside', async () => {
    opened({ lang: 'en-GB' })
    fromPage(word())
    await settle()
    const popup = document.querySelector('.word-popup')!
    expect(popup).toHaveTextContent('pond')
    // From the book's language (readLang: en-GB → en) into the reader's (the context's default here, en):
    // definition mode is the same language; the default-context reader is unconfirmed, so the picker is open.
    expect(screen.getByPlaceholderText('Search language...')).toBeInTheDocument()
    expect(calls('next').length + calls('prev').length).toBe(0)
  })

  it('centreWord_ABookInAnotherLanguage_TheTranslationOfTheWordInItsSentence', async () => {
    opened({ lang: 'de' })
    fromPage(word('Teich'))
    await settle()
    expect(translate).toHaveBeenCalledWith('Teich', 'de', 'en', expect.anything(), expect.objectContaining({ sentence: 'By the Teich.' }))
    expect(document.querySelector('.word-popup__translation')).toHaveTextContent('Teich')
  })

  it('noLanguageInTheBook_En', async () => {
    opened({ lang: '<b>' })
    fromPage(word())
    await settle()
    // en into en: definition mode, nothing to translate.
    expect(translate).not.toHaveBeenCalled()
  })

  it('aFailedTranslation_SaidInThePopup_ReadingGoesOn', async () => {
    opened()
    translate.mockRejectedValue(new Error('503'))
    fromPage(word())
    await settle()
    expect(document.querySelector('.word-popup__translation')).toHaveTextContent('Could not translate this word.')
    fromPage({ type: 'tap', x: WIDTH - 5, y: 10 })
    expect(calls('next')).toHaveLength(1)
  })

  it('edgeWord_TurnsThePage_NoPopupNoFetch', async () => {
    opened()
    fromPage(word('pond', WIDTH - 40))
    await settle()
    expect(calls('next')).toHaveLength(1)
    expect(document.querySelector('.word-popup')).toBeNull()
    expect(translate).not.toHaveBeenCalled()
  })

  it('aTapInTheBook_ClosesThePopup_AndDoesNothingMore', async () => {
    opened()
    fromPage(word())
    await settle()
    const bars = document.querySelector('main')!.getAttribute('data-bars')
    fromPage({ type: 'tap', x: WIDTH / 2, y: 10 })
    expect(document.querySelector('.word-popup')).toBeNull()
    expect(document.querySelector('main')!.getAttribute('data-bars')).toBe(bars)
  })

  it('untrustedWord_RenderedAsText', async () => {
    opened()
    fromPage({ ...word('<img src=x onerror=alert(1)>'), sentence: '<img src=x>' })
    await settle()
    expect(document.querySelector('.word-popup')).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(document.querySelector('.word-popup img[src="x"]')).toBeNull()
  })

  it('aMalformedWord_Dropped', async () => {
    opened()
    fromPage({ ...word(), rect: { x: 'a' } })
    fromPage({ ...word(), sentence: 3 })
    await settle()
    expect(document.querySelector('.word-popup')).toBeNull()
  })

  it('selection_TheToolbar_HighlightTranslateExplainCopy_NoListenYet_ASelectionSupersedesTheWord', async () => {
    opened()
    fromPage(word())
    await settle()
    fromPage(selection())
    expect(document.querySelector('.word-popup')).toBeNull()
    for (const name of ['Highlight yellow', 'Translate selected text', 'Explain in context', 'Copy selected text']) expect(screen.getByRole('button', { name })).toBeEnabled()
    // One colour: the page draws one.
    expect(screen.queryByRole('button', { name: 'Highlight green' })).toBeNull()
    // Listen is the TTS slice's (#1272).
    expect(screen.queryByRole('button', { name: 'Listen to pronunciation' })).toBeNull()
  })

  it('selection_Highlight_TheOneDescribedHighlighted_ToolbarClosed', () => {
    opened()
    fromPage(selection())
    fireEvent.click(screen.getByRole('button', { name: 'Highlight yellow' }))
    expect(calls('highlightSelection')).toHaveLength(1)
    expect(document.querySelector('.selection-toolbar')).toBeNull()
  })

  it('selection_NotAnnotatable_NoHighlight', () => {
    opened({ annotatable: false })
    fromPage(selection())
    expect(screen.queryByRole('button', { name: 'Highlight yellow' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy selected text' })).toBeInTheDocument()
  })

  it('selection_Copy_ClearsThePagesSelection_ToolbarClosed', async () => {
    opened()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn() }, configurable: true })
    fromPage(selection())
    fireEvent.click(screen.getByRole('button', { name: 'Copy selected text' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('by the pond')
    expect(calls('clearSelection')).toHaveLength(1)
    expect(document.querySelector('.selection-toolbar')).toBeNull()
  })

  it('selectionCleared_ClosesTheToolbar', () => {
    opened()
    fromPage(selection())
    fromPage({ type: 'selection-cleared' })
    expect(document.querySelector('.selection-toolbar')).toBeNull()
  })

  it('tooLong_TranslateAndExplainOff_TheNoticeSaysWhy', () => {
    opened()
    fromPage(selection('word '.repeat(120).trim()))
    expect(screen.getByRole('button', { name: 'Translate selected text' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Explain in context' })).toBeDisabled()
    expect(screen.getByText('Too long to listen, translate or explain')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy selected text' })).toBeEnabled()
  })

  it('translate_ThePopupWithTheTranslation_ItsCloseClearsTheSelection', async () => {
    opened()
    fromPage(selection())
    fireEvent.click(screen.getByRole('button', { name: 'Translate selected text' }))
    await settle()
    expect(translate).toHaveBeenCalledWith('by the pond', 'de', 'en', undefined, expect.objectContaining({ sentence: 'By the pond.' }))
    expect(document.querySelector('.selection-toolbar')).toBeNull()
    expect(document.querySelector('.translation-popup')).toHaveTextContent('Teich')
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    expect(calls('clearSelection').length).toBeGreaterThan(0)
  })

  it('explain_Streamed_TheTextGrowsAsItComes', async () => {
    opened()
    let emit: (e: { event: string; data: string }) => void = () => {}
    let end: () => void = () => {}
    postSse.mockImplementation((_url: string, _body: unknown, onEvent: typeof emit) => { emit = onEvent; return new Promise<void>((r) => { end = r }) })
    fromPage(selection())
    fireEvent.click(screen.getByRole('button', { name: 'Explain in context' }))
    await settle()
    expect(postSse.mock.calls[0][1]).toMatchObject({ word: 'by the pond', sentence: 'By the pond.' })
    act(() => emit({ event: 'delta', data: 'A small ' }))
    expect(document.querySelector('.translation-popup')).toHaveTextContent('A small')
    act(() => emit({ event: 'delta', data: 'lake.' }))
    await act(async () => { end() })
    expect(document.querySelector('.translation-popup')).toHaveTextContent('A small lake.')
  })

  it('aTapInTheBookWhileTheTranslationIsOpen_ClosesIt', async () => {
    opened()
    fromPage(selection())
    fireEvent.click(screen.getByRole('button', { name: 'Translate selected text' }))
    await settle()
    // The press dismissed the page's selection.
    fromPage({ type: 'selection-cleared' })
    await settle()
    expect(document.querySelector('.translation-popup')).toBeNull()
  })

  it('aMove_ClosesTheWordPopup_NotTheToolbar', async () => {
    opened()
    fromPage(word())
    await settle()
    fromPage({ type: 'relocate', fraction: 0.2, index: 0, sections: 3, toc: null, moved: true })
    expect(document.querySelector('.word-popup')).toBeNull()
    fromPage(selection())
    fromPage({ type: 'relocate', fraction: 0.3, index: 0, sections: 3, toc: null, moved: true })
    expect(document.querySelector('.selection-toolbar')).not.toBeNull()
  })

  it('escapeInTheBook_APopupOpen_ClosesIt_AndDoesNothingElse', async () => {
    opened()
    fromPage(word())
    await settle()
    const bars = document.querySelector('main')!.getAttribute('data-bars')
    fromPage({ type: 'key', key: 'Escape', shift: false, repeat: false })
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    expect(document.querySelector('.word-popup')).toBeNull()
    expect(document.querySelector('main')!.getAttribute('data-bars')).toBe(bars)
    // The toolbar: Escape ends the page's selection too.
    fromPage(selection())
    fromPage({ type: 'key', key: 'Escape', shift: false, repeat: false })
    expect(document.querySelector('.selection-toolbar')).toBeNull()
    expect(calls('clearSelection')).toHaveLength(1)
  })

  it('escapeOnTheHost_TheToolbarOpen_ClosesIt', () => {
    opened()
    fromPage(selection())
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.querySelector('.selection-toolbar')).toBeNull()
    expect(calls('clearSelection')).toHaveLength(1)
  })

  it('escapeInTheBook_NothingOpen_ShowsTheBars', async () => {
    opened()
    await act(async () => { await new Promise((r) => setTimeout(r, 3100)) })
    expect(document.querySelector('main')!.getAttribute('data-bars')).toBe('hidden')
    fromPage({ type: 'key', key: 'Escape', shift: false, repeat: false })
    expect(document.querySelector('main')!.getAttribute('data-bars')).toBe('shown')
  })

  it('aThreeLetterLanguage_TheFallback_DefinitionModeForAnEnglishReader', async () => {
    // `eng` is not read as a language other than `en`: no en→en translation.
    opened({ lang: 'eng' })
    fromPage(word())
    await settle()
    expect(translate).not.toHaveBeenCalled()
  })
})
