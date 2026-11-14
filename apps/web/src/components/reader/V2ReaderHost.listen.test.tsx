import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'

// #1272: Listen on the web: the host fetches and plays the word or selection in the book's voice, at the chosen speed,
// and the page marks the range spoken (`speaking`) until the audio ends or is stopped. Driven through a fake frame.

const fetchTtsAudio = vi.fn()
vi.mock('../../api/tts', () => ({
  fetchTtsAudio: (...a: unknown[]) => fetchTtsAudio(...a),
  fetchTtsTimestamps: async () => [],
  TtsRateLimitError: class extends Error {},
}))
vi.mock('../../lib/offlineDb', async (orig) => ({ ...(await orig<object>()), getCachedTtsAudio: async () => null, cacheTtsAudio: async () => {} }))
vi.mock('../../api/translation', () => ({ translate: async () => ({ translatedText: 'x' }), getLanguages: async () => [] }))

const WIDTH = 1000
const frame = () => screen.getByTitle('V2 reader') as HTMLIFrameElement
let posted: { call: string; args: unknown[] }[]
let playing: HTMLMediaElement | null

beforeEach(() => {
  localStorage.clear()
  posted = []
  playing = null
  fetchTtsAudio.mockReset().mockResolvedValue(new ArrayBuffer(4))
  URL.createObjectURL = () => 'blob:tts'
  URL.revokeObjectURL = () => {}
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playing = this
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(cleanup)

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}
function opened(lang: unknown = 'de') {
  const book: V2HostBook = { bytes: new ArrayBuffer(8), name: 'a.epub' }
  render(<MemoryRouter><V2ReaderHost book={book} idleHeading="idle" dev /></MemoryRouter>)
  Object.defineProperty(frame(), 'clientWidth', { value: WIDTH, configurable: true })
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', lang, book: { sha256: 'aa', size: 8, name: '1/a.epub' } })
  posted = []
}
const word = (w = 'Teich') => ({ type: 'word', word: w, sentence: `Am ${w}.`, cfi: 'epubcfi(/6/4!/4/2/1:3)', index: 2, rect: { x: WIDTH / 2 - 15, y: 100, w: 30, h: 10 } })
const selection = (text = 'am Teich') => ({ type: 'selection', text, sentence: 'Am Teich.', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:8)', index: 2, rect: { x: 400, y: 100, w: 200, h: 10 } })
const spoken = () => posted.filter((m) => m.call === 'speaking').map((m) => m.args)
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const speaker = () => within(document.querySelector('.word-popup') as HTMLElement).queryByRole('button', { name: 'Listen to pronunciation' })
const toolbarListen = () => within(document.querySelector('.selection-toolbar') as HTMLElement).queryByRole('button', { name: 'Listen to pronunciation' })

describe('V2ReaderHost Listen', () => {
  it('wordSpeaker_SpeaksTheWordInTheBooksVoice_ThePageMarksItUntilTheEnd', async () => {
    opened('de')
    fromPage(word())
    await settle()
    fireEvent.click(speaker()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledWith('Teich', 'de', 'de-DE-KatjaNeural', 1, expect.anything())
    expect(spoken()).toEqual([['epubcfi(/6/4!/4/2/1:3)', 2]])
    act(() => { playing!.onended?.(new Event('ended')) })
    await settle()
    expect(spoken()).toEqual([['epubcfi(/6/4!/4/2/1:3)', 2], [null]])
  })

  it('toolbarListen_SpeaksTheSelection_PressedAgainStops', async () => {
    opened('pt-BR')
    fromPage(selection('a lagoa'))
    await settle()
    fireEvent.click(toolbarListen()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledWith('a lagoa', 'pt', 'pt-BR-FranciscaNeural', 1, expect.anything())
    expect(spoken()).toEqual([['epubcfi(/6/4!/4/2,/1:0,/1:8)', 2]])
    fireEvent.click(toolbarListen()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledTimes(1)
    expect(spoken()).toEqual([['epubcfi(/6/4!/4/2,/1:0,/1:8)', 2], [null]])
  })

  it('threeLetterLanguage_ItsVoice_NeverEnglish', async () => {
    opened('deu')
    fromPage(word())
    await settle()
    fireEvent.click(speaker()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledWith('Teich', 'de', 'de-DE-KatjaNeural', 1, expect.anything())
  })

  it('chosenSpeed_StoredAndSpokenAt', async () => {
    opened('de')
    fireEvent.click(screen.getByRole('button', { name: 'Reading settings' }))
    fireEvent.click(within(screen.getByTestId('v2-settings')).getByRole('button', { name: '1.5x' }))
    expect(localStorage.getItem('v2reader.ttsSpeed')).toBe('1.5')
    fromPage(word())
    await settle()
    fireEvent.click(speaker()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledWith('Teich', 'de', 'de-DE-KatjaNeural', 1.5, expect.anything())
  })

  it('ukrainianBook_NoListen', async () => {
    opened('uk')
    fromPage(word('ставок'))
    await settle()
    expect(speaker()).toBeNull()
    fromPage(selection('біля ставка'))
    await settle()
    expect(toolbarListen()).toBeNull()
  })

  it('failedSpeech_Said_TheMarkGoes', async () => {
    opened('de')
    fetchTtsAudio.mockRejectedValue(new Error('502'))
    fromPage(word())
    await settle()
    fireEvent.click(speaker()!)
    await settle()
    expect(screen.getByText('Could not play the speech. Try again.')).toBeInTheDocument()
    expect(spoken()).toEqual([['epubcfi(/6/4!/4/2/1:3)', 2], [null]])
  })

  it('aPdfWord_NoCfi_SpokenWithNoMark', async () => {
    opened('en')
    fromPage({ ...word('pond'), cfi: null })
    await settle()
    fireEvent.click(speaker()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledWith('pond', 'en', 'en-US-AriaNeural', 1, expect.anything())
    expect(spoken()).toEqual([[null]])
  })
})
