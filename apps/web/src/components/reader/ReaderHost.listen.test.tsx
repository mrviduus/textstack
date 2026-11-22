import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReaderHost, type HostBook } from './ReaderHost'

// #1272: Listen on the web: the host fetches and plays the word or selection in the book's language, at the chosen
// speed, and the page marks the range spoken (`speaking`) until the audio ends or is stopped. Driven through a fake frame.

const fetchTtsAudio = vi.fn()
const fetchTtsTimestamps = vi.fn()
vi.mock('../../api/tts', () => ({
  fetchTtsAudio: (...a: unknown[]) => fetchTtsAudio(...a),
  fetchTtsTimestamps: (...a: unknown[]) => fetchTtsTimestamps(...a),
  TtsRateLimitError: class extends Error {},
}))
const cachedTts = vi.fn()
vi.mock('../../lib/offlineDb', async (orig) => ({ ...(await orig<object>()), getCachedTtsAudio: (...a: unknown[]) => cachedTts(...a), cacheTtsAudio: async () => {} }))
vi.mock('../../api/translation', () => ({ translate: async () => ({ translatedText: 'x' }), getLanguages: async () => [] }))

const WIDTH = 1000
const frame = () => screen.getByTitle('Book text') as HTMLIFrameElement
let posted: { call: string; args: unknown[] }[]
let playing: HTMLMediaElement | null
let audioAnswer: (v: ArrayBuffer) => void
/** A play() held pending; pausing the element rejects it (AbortError), as browsers do. */
let pendingPlay: ((e: unknown) => void) | null

beforeEach(() => {
  localStorage.clear()
  posted = []
  playing = null
  fetchTtsAudio.mockReset().mockResolvedValue(new ArrayBuffer(4))
  fetchTtsTimestamps.mockReset().mockResolvedValue([])
  cachedTts.mockReset().mockResolvedValue(null)
  URL.createObjectURL = () => 'blob:tts'
  URL.revokeObjectURL = () => {}
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playing = this
    return Promise.resolve()
  })
  pendingPlay = null
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {
    const reject = pendingPlay
    pendingPlay = null
    reject?.(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'))
  })
})
afterEach(cleanup)

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}
function opened(lang: unknown = 'de') {
  const book: HostBook = { bytes: new ArrayBuffer(8), name: 'a.epub' }
  render(<MemoryRouter><ReaderHost book={book} idleHeading="idle" dev /></MemoryRouter>)
  Object.defineProperty(frame(), 'clientWidth', { value: WIDTH, configurable: true })
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', lang, book: { sha256: 'aa', size: 8, name: '1/a.epub' } })
  posted = []
}
const WORD_CFI = 'epubcfi(/6/4!/4/2/1:3)'
const word = (w = 'Teich', cfi = WORD_CFI) => ({ type: 'word', word: w, sentence: `Am ${w}.`, cfi, index: 2, rect: { x: WIDTH / 2 - 15, y: 100, w: 30, h: 10 } })
const SEL_CFI = 'epubcfi(/6/4!/4/2,/1:0,/1:8)'
const selection = (text = 'am Teich') => ({ type: 'selection', text, sentence: 'Am Teich.', cfi: SEL_CFI, index: 2, rect: { x: 400, y: 100, w: 200, h: 10 } })
const spoken = () => posted.filter((m) => m.call === 'speaking').map((m) => m.args)
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const popupButton = () => within(document.querySelector('.word-popup') as HTMLElement).getAllByRole('button').find((b) => b.classList.contains('speak-btn')) ?? null
const toolbarButton = () => {
  const bar = document.querySelector('.selection-toolbar') as HTMLElement
  return within(bar).queryByRole('button', { name: /Listen to pronunciation|Loading speech|Stop speech/ })
}
/** The audio fetch held until the test answers it. */
const holdAudio = () => fetchTtsAudio.mockImplementationOnce(() => new Promise<ArrayBuffer>((r) => { audioAnswer = r }))

describe('ReaderHost Listen', () => {
  it('wordSpeaker_SpeaksTheWordInTheBooksLanguage_LoadingThenStop_ThePageMarksItUntilTheEnd', async () => {
    opened('de')
    fromPage(word())
    await settle()
    holdAudio()
    fireEvent.click(popupButton()!)
    // The press shows at once: a spinner that says a press cancels.
    expect(popupButton()).toHaveAccessibleName('Loading speech, tap to cancel')
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledWith('Teich', 'de', undefined, 1, expect.anything())
    expect(spoken()).toEqual([[WORD_CFI, 2]])
    await act(async () => { audioAnswer(new ArrayBuffer(4)) })
    await settle()
    expect(popupButton()).toHaveAccessibleName('Stop speech')
    expect(popupButton()).toHaveClass('speak-btn--playing')
    act(() => { playing!.onended?.(new Event('ended')) })
    await settle()
    expect(spoken()).toEqual([[WORD_CFI, 2], [null]])
    expect(popupButton()).toHaveAccessibleName('Listen to pronunciation')
    // The speaker's own strings (speakButton.*), its title as before; the toolbar keeps its keys.
    expect(popupButton()).toHaveAttribute('title', 'Listen')
  })

  it('noWordTimestamps_NoTrackingRequest', async () => {
    opened('de')
    fromPage(word())
    await settle()
    fireEvent.click(popupButton()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledTimes(1)
    expect(fetchTtsTimestamps).not.toHaveBeenCalled()
  })

  it('aSecondPressWhileLoading_Cancels_NeverASecondFetch', async () => {
    opened('de')
    fromPage(word())
    await settle()
    holdAudio()
    fireEvent.click(popupButton()!)
    fireEvent.click(popupButton()!)
    await settle()
    // Cancelled before the audio was asked for: no fetch at all, and not a second start.
    expect(fetchTtsAudio).not.toHaveBeenCalled()
    expect(screen.queryByText('Could not play the speech. Try again.')).toBeNull()
    expect(spoken()).toEqual([[WORD_CFI, 2], [null]])
    expect(popupButton()).toHaveAccessibleName('Listen to pronunciation')
  })

  it('toolbarListen_SpeaksTheSelection_PressedAgainStops', async () => {
    opened('pt-BR')
    fromPage(selection('a lagoa'))
    await settle()
    fireEvent.click(toolbarButton()!)
    await settle()
    // The language only (the server picks the voice by it): pt-BR is sent as pt.
    expect(fetchTtsAudio).toHaveBeenCalledWith('a lagoa', 'pt', undefined, 1, expect.anything())
    expect(spoken()).toEqual([[SEL_CFI, 2]])
    expect(toolbarButton()).toHaveAccessibleName('Stop speech')
    fireEvent.click(toolbarButton()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledTimes(1)
    expect(spoken()).toEqual([[SEL_CFI, 2], [null]])
    expect(toolbarButton()).toHaveAccessibleName('Listen to pronunciation')
  })

  it('theSameWordElsewhere_SpokenThere', async () => {
    opened('de')
    fromPage(word('der'))
    await settle()
    fireEvent.click(popupButton()!)
    await settle()
    fromPage(word('der', 'epubcfi(/6/4!/4/8/1:0)'))
    await settle()
    expect(popupButton()).toHaveAccessibleName('Listen to pronunciation')
    fireEvent.click(popupButton()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledTimes(2)
    // The first word's popup closing ended its speech; the second is spoken where it is.
    expect(spoken()).toEqual([[WORD_CFI, 2], [null], ['epubcfi(/6/4!/4/8/1:0)', 2]])
  })

  it('threeLetterLanguage_ItsLanguage_NeverEnglish', async () => {
    opened('deu')
    fromPage(word())
    await settle()
    fireEvent.click(popupButton()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledWith('Teich', 'de', undefined, 1, expect.anything())
  })

  it('chosenSpeed_StoredSpokenAt_CachedPerSpeed', async () => {
    opened('de')
    fireEvent.click(screen.getByRole('button', { name: 'Reading settings' }))
    fireEvent.click(within(screen.getByTestId('v2-settings')).getByRole('button', { name: '1.5x' }))
    expect(localStorage.getItem('v2reader.ttsSpeed')).toBe('1.5')
    fromPage(word())
    await settle()
    fireEvent.click(popupButton()!)
    await settle()
    expect(cachedTts).toHaveBeenCalledWith('de', 'Teich', 1.5)
    expect(fetchTtsAudio).toHaveBeenCalledWith('Teich', 'de', undefined, 1.5, expect.anything())
  })

  it('ukrainianBook_NoListen', async () => {
    opened('uk')
    fromPage(word('ставок'))
    await settle()
    expect(popupButton()).toBeNull()
    fromPage(selection('біля ставка'))
    await settle()
    expect(toolbarButton()).toBeNull()
  })

  it('failedSpeech_Said_TheMarkGoes', async () => {
    opened('de')
    fetchTtsAudio.mockRejectedValue(new Error('502'))
    fromPage(word())
    await settle()
    fireEvent.click(popupButton()!)
    await settle()
    expect(screen.getByText('Could not play the speech. Try again.')).toBeInTheDocument()
    expect(spoken()).toEqual([[WORD_CFI, 2], [null]])
  })

  it('aNewListenWhileTheOldPlayIsPending_TheNewOneKeepsPlaying', async () => {
    // A's play() is still pending when B starts: B pauses the element, A's play() rejects (AbortError). That rejection
    // belongs to A: it must not end B, nor say B failed.
    opened('de')
    fromPage(word('Teich'))
    await settle()
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(function (this: HTMLMediaElement) {
      playing = this
      return new Promise<void>((_, reject) => { pendingPlay = reject })
    })
    fireEvent.click(popupButton()!)
    await settle()
    expect(pendingPlay).not.toBeNull()
    fromPage(word('Wald', 'epubcfi(/6/4!/4/8/1:0)'))
    fireEvent.click(popupButton()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenLastCalledWith('Wald', 'de', undefined, 1, expect.anything())
    expect(popupButton()).toHaveAccessibleName('Stop speech')
    expect(spoken()[spoken().length - 1]).toEqual(['epubcfi(/6/4!/4/8/1:0)', 2])
    expect(screen.queryByText('Could not play the speech. Try again.')).toBeNull()
  })

  it('closingThePopupThatStartedIt_StopsIt_TheMarkGoes', async () => {
    opened('de')
    fromPage(word())
    await settle()
    fireEvent.click(popupButton()!)
    await settle()
    expect(popupButton()).toHaveAccessibleName('Stop speech')
    const pauses = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length
    // A tap in the book closes the popup.
    fromPage({ type: 'tap', x: WIDTH / 2, y: 300 })
    await settle()
    expect(document.querySelector('.word-popup')).toBeNull()
    expect(spoken()).toEqual([[WORD_CFI, 2], [null]])
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length).toBeGreaterThan(pauses)
    expect(screen.queryByText('Could not play the speech. Try again.')).toBeNull()
  })

  it('closingTheToolbarThatStartedIt_StopsIt', async () => {
    opened('de')
    fromPage(selection())
    await settle()
    fireEvent.click(toolbarButton()!)
    await settle()
    fromPage({ type: 'selection-cleared' })
    await settle()
    expect(document.querySelector('.selection-toolbar')).toBeNull()
    expect(spoken()).toEqual([[SEL_CFI, 2], [null]])
  })

  it('aPdfWord_NoCfi_SpokenWithNoMark', async () => {
    opened('en')
    fromPage({ ...word('pond'), cfi: null })
    await settle()
    fireEvent.click(popupButton()!)
    await settle()
    expect(fetchTtsAudio).toHaveBeenCalledWith('pond', 'en', undefined, 1, expect.anything())
    expect(spoken()).toEqual([[null]])
  })
})
