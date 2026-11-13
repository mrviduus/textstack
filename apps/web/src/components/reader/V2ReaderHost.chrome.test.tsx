import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'

// #1263: the bars and tap zones of the V2 reader on the web, driven through a fake frame as V2ReaderHost.test.tsx.

const WIDTH = 1000
const frame = () => screen.getByTitle('V2 reader') as HTMLIFrameElement
let posted: { call: string; args: unknown[] }[]

beforeEach(() => {
  localStorage.clear()
  posted = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

function mount(extra: { backUrl?: string } = {}) {
  const book: V2HostBook = { bytes: new ArrayBuffer(8), name: 'a.epub' }
  const view = render(<MemoryRouter><V2ReaderHost book={book} idleHeading="idle" {...extra} /></MemoryRouter>)
  Object.defineProperty(frame(), 'clientWidth', { value: WIDTH, configurable: true })
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  return view
}

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}

/** A book open on screen, its bars still shown. */
function opened(reflowable = true, dir?: string) {
  const view = mount()
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', reflowable, dir, book: { sha256: 'aa', size: 8, name: '1/a.epub' } })
  posted = []
  return view
}
/** A page `tap` at `x` (page-viewport px, as the page sends it). */
const tap = (x: number) => ({ type: 'tap', x, y: 300 })
/** A page `key` (a navigation key pressed inside the book). */
const key = (k: string, shift = false, repeat = false) => ({ type: 'key', key: k, shift, repeat })
/** A page `relocate`; `moved`: the reader moved the place. */
const relocate = (fraction: number, moved: boolean) => ({ type: 'relocate', fraction, index: 0, sections: 3, toc: null, moved })

const bars = () => document.querySelector('main')!.getAttribute('data-bars')
const turns = () => posted.filter((m) => m.call === 'next' || m.call === 'prev').map((m) => m.call)
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  act(() => { fireEvent.keyDown(target, { key, ...init }) })

describe('V2ReaderHost bars and tap zones', () => {
  it('bars_Shown_ThenHidden3sAfterTheOpen', () => {
    opened()
    expect(bars()).toBe('shown')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(bars()).toBe('hidden')
  })

  it('centreTap_TogglesTheBars_NeverTurns', () => {
    opened()
    fromPage(tap(WIDTH / 2))
    expect(bars()).toBe('hidden')
    fromPage(tap(WIDTH / 2))
    expect(bars()).toBe('shown')
    expect(turns()).toEqual([])
  })

  it('malformedTap_Dropped_NeitherTurnsNorToggles', () => {
    opened()
    for (const m of [{ type: 'tap' }, { type: 'tap', x: WIDTH - 5 }, { type: 'tap', x: '995', y: 10 }, { type: 'tap', x: 1e9, y: 10 }]) fromPage(m)
    expect(turns()).toEqual([])
    expect(bars()).toBe('shown')
  })

  it('tapOnAnEdge_Paginated_TurnsThePage_AndHidesTheBars', () => {
    opened()
    fromPage(tap(WIDTH - 5))
    fromPage(tap(5))
    expect(turns()).toEqual(['next', 'prev'])
    expect(bars()).toBe('hidden')
    fromPage(tap(WIDTH / 2))
    expect(bars()).toBe('shown')
    expect(turns()).toHaveLength(2)
  })

  it('rtlBook_LeftEdgeAndArrowLeftAreNext_AnUnknownDirIsLtr', () => {
    opened(true, 'rtl')
    fromPage(tap(5))
    fromPage(key('ArrowLeft'))
    press('ArrowRight')
    expect(turns()).toEqual(['next', 'next', 'prev'])
    cleanup()
    opened(true, 'sideways')
    fromPage(tap(5))
    expect(turns()).toEqual(['prev'])
  })

  it('relocateDir_TheLatestDirectionDecides_AMalformedOneKeepsIt', () => {
    opened(true, 'ltr')
    fromPage({ type: 'relocate', fraction: 0.1, index: 0, sections: 3, dir: 'rtl' })
    fromPage(tap(5))
    fromPage({ type: 'relocate', fraction: 0.2, index: 0, sections: 3, dir: 'up' })
    fromPage(key('ArrowLeft'))
    fromPage({ type: 'relocate', fraction: 0.3, index: 0, sections: 3, dir: 'ltr' })
    fromPage(tap(5))
    expect(turns()).toEqual(['next', 'next', 'prev'])
  })

  it('tapOnAnEdge_ScrolledFlow_Toggles', () => {
    localStorage.setItem('v2reader:flow', 'scrolled')
    opened()
    fromPage(tap(WIDTH - 5))
    expect(turns()).toEqual([])
    expect(bars()).toBe('hidden')
  })

  it('tapOnAnEdge_FixedLayoutBook_TurnsWhateverTheFlowSetting', () => {
    localStorage.setItem('v2reader:flow', 'scrolled')
    opened(false)
    fromPage(tap(WIDTH - 5))
    expect(turns()).toEqual(['next'])
  })

  it('wordTap_AnEdgeWordTurns_ACentreWordNeitherTurnsNorToggles_AMalformedRectDropped', () => {
    // #1269 (wordPopup.mjs popupStep): an edge word in paginated flow turns the page; a centre one opens its popup.
    opened()
    const word = (x: number, w = 30) => ({ type: 'word', word: 'pond', sentence: 'The pond.', cfi: 'epubcfi(/6/2)', index: 0, rect: { x, y: 10, w, h: 10 } })
    fromPage(word(WIDTH - 40))
    expect(turns()).toEqual(['next'])
    fromPage(word(WIDTH / 2 - 15))
    expect(bars()).toBe('hidden')
    expect(turns()).toEqual(['next'])
    fromPage(word(5, -3))
    expect(turns()).toEqual(['next'])
  })

  it('keyFromInsideTheBook_TurnsPages_EscShowsTheBars_AMalformedOneDropped', () => {
    opened()
    fromPage(key('ArrowRight'))
    fromPage(key('Space', true))
    fromPage(key('PageDown'))
    expect(turns()).toEqual(['next', 'prev', 'next'])
    expect(bars()).toBe('hidden')
    fromPage(key('Escape'))
    expect(bars()).toBe('shown')
    for (const m of [{ type: 'key', key: 'Enter', shift: false, repeat: false }, { type: 'key', key: 'ArrowRight', shift: false }, { type: 'key', key: ' ', shift: false, repeat: false }]) fromPage(m)
    expect(turns()).toHaveLength(3)
  })

  it('heldKey_OneTurnPerPress_InTheBookAndOnTheHost', () => {
    opened()
    fromPage(key('ArrowRight'))
    fromPage(key('ArrowRight', false, true))
    press('ArrowRight')
    press('ArrowRight', { repeat: true })
    expect(turns()).toEqual(['next', 'next'])
  })

  it('hostKeys_TurnPagesAndHideTheBars_EscShowsThem', () => {
    opened()
    press('ArrowRight')
    press('PageDown')
    press(' ')
    press('ArrowLeft')
    press('PageUp')
    press(' ', { shiftKey: true })
    expect(turns()).toEqual(['next', 'next', 'next', 'prev', 'prev', 'prev'])
    expect(bars()).toBe('hidden')
    press('Escape')
    expect(bars()).toBe('shown')
  })

  it('hostKeys_NotTheReaders_ModifiersShiftArrowSpaceOnAControlAField', () => {
    opened()
    press('ArrowLeft', { altKey: true })
    press('ArrowRight', { metaKey: true })
    press(' ', { ctrlKey: true })
    press('ArrowRight', { shiftKey: true })
    press(' ', {}, screen.getByRole('button', { name: 'Next ›' }))
    const input = document.body.appendChild(document.createElement('input'))
    press('ArrowRight', {}, input)
    press(' ', {}, input)
    expect(turns()).toEqual([])
    input.remove()
  })

  it('aFocusedBarButton_ArrowsAndPageKeysStillTurn_EscShowsFromAField', () => {
    opened()
    const next = screen.getByRole('button', { name: 'Next ›' })
    press('ArrowRight', {}, next)
    press('PageDown', {}, next)
    expect(turns()).toEqual(['next', 'next'])
    const input = document.body.appendChild(document.createElement('input'))
    expect(bars()).toBe('hidden')
    press('Escape', {}, input)
    expect(bars()).toBe('shown')
    input.remove()
  })

  it('barsHiding_MoveFocusOutOfThem_ToTheReader', () => {
    opened()
    const next = screen.getByRole('button', { name: 'Next ›' })
    act(() => { next.focus() })
    press('ArrowRight', {}, next)
    expect(bars()).toBe('hidden')
    expect(document.activeElement).toBe(document.querySelector('main'))
  })

  it('relocateMoved_HidesTheBars_EitherFlow_NotMovedDoesNot', () => {
    for (const flow of ['paginated', 'scrolled']) {
      localStorage.setItem('v2reader:flow', flow)
      opened()
      fromPage(relocate(0.1, false))
      expect(bars()).toBe('shown')
      fromPage(relocate(0.2, true))
      expect(bars()).toBe('hidden')
      cleanup()
    }
  })

  it('aBarButtonOrTheTakenOfferMoved_ItsRelocatesKeepTheBars', () => {
    opened()
    act(() => { screen.getByRole('button', { name: 'Next ›' }).click() })
    vi.setSystemTime(Date.now() + 5000) // the landing comes late: still the button's
    fromPage(relocate(0.2, true))
    fromPage(relocate(0.2, true))
    expect(bars()).toBe('shown')
    expect(posted.map((m) => m.call)).toEqual(['next'])
    vi.setSystemTime(Date.now() + 2000)
    fromPage(relocate(0.3, true)) // the reader's own move, past the grace
    expect(bars()).toBe('hidden')
  })

  it('relocate_TheChromeReadsItThroughReadRelocate', () => {
    opened()
    fromPage({ type: 'relocate', fraction: 5, index: -1, sections: 'x', toc: 7, moved: 'yes' })
    expect(screen.getByTestId('v2-status')).toHaveTextContent(/^—$/)
    expect(bars()).toBe('shown')
  })

  it('noBookOnScreen_TapsKeysAndWordsDoNothing_ANewOpenShowsTheBarsUntilOpened', () => {
    const view = opened()
    fromPage(tap(WIDTH / 2))
    expect(bars()).toBe('hidden')
    view.rerender(<MemoryRouter><V2ReaderHost book={{ bytes: new ArrayBuffer(8), name: 'b.epub' }} idleHeading="idle" /></MemoryRouter>)
    expect(bars()).toBe('shown')
    expect(screen.getByTestId('v2-heading')).toHaveTextContent('Opening b.epub')
    fromPage(tap(WIDTH - 5))
    fromPage(key('ArrowRight'))
    press('PageDown')
    fromPage({ type: 'word', word: 'x', sentence: 'x', cfi: null, index: 0, rect: { x: WIDTH - 40, y: 10, w: 30, h: 10 } })
    fromPage(relocate(0.4, true))
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(turns()).toEqual([])
    expect(bars()).toBe('shown')
    fromPage({ type: 'opened', title: 'B', book: { sha256: 'bb', size: 8, name: '2/b.epub' } })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(bars()).toBe('hidden')
  })

  it('focusOnAHiddenBar_ShowsTheBars', () => {
    opened()
    fromPage(tap(WIDTH / 2))
    expect(bars()).toBe('hidden')
    act(() => { screen.getByRole('button', { name: 'Next ›' }).focus() })
    expect(bars()).toBe('shown')
  })

  it('states_InLayoutAboveTheFrame_NotInABarNorOverTheBook', () => {
    const view = opened()
    view.rerender(<MemoryRouter><V2ReaderHost book={{ bytes: new ArrayBuffer(8), name: 'b.epub' }} idleHeading="idle" /></MemoryRouter>)
    fromPage({ type: 'open-failed', name: '2/b.epub', error: 'not a zip' })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('cannot open b.epub')
    expect(alert.closest('header, footer')).toBeNull()
    expect(alert.compareDocumentPosition(frame()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(alert.closest('main')).toBe(frame().parentElement)
  })

  it('backLink_NamedAndToTheGivenUrl', () => {
    mount({ backUrl: '/en/library' })
    expect(screen.getByRole('link', { name: 'Back to the library' })).toHaveAttribute('href', '/en/library')
  })
})
