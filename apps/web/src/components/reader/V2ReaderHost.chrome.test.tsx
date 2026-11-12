import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keyAction, V2ReaderHost, type V2HostBook } from './V2ReaderHost'

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
    fromPage({ type: 'key', key: 'ArrowLeft', shift: false })
    press('ArrowRight')
    expect(turns()).toEqual(['next', 'next', 'prev'])
    cleanup()
    opened(true, 'sideways')
    fromPage(tap(5))
    expect(turns()).toEqual(['prev'])
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

  it('wordTap_NeverTurnsNorToggles', () => {
    opened()
    fromPage({ type: 'word', word: 'pond', cfi: 'epubcfi(/6/2)', index: 0, x: WIDTH - 5, y: 10, rect: { x: WIDTH - 20, y: 10, w: 30, h: 10 } })
    expect(turns()).toEqual([])
    expect(bars()).toBe('shown')
  })

  it('keyFromInsideTheBook_TurnsPages_EscShowsTheBars_AMalformedOneDropped', () => {
    opened()
    fromPage({ type: 'key', key: 'ArrowRight', shift: false })
    fromPage({ type: 'key', key: 'Space', shift: true })
    fromPage({ type: 'key', key: 'PageDown', shift: false })
    expect(turns()).toEqual(['next', 'prev', 'next'])
    expect(bars()).toBe('hidden')
    fromPage({ type: 'key', key: 'Escape', shift: false })
    expect(bars()).toBe('shown')
    for (const m of [{ type: 'key', key: 'Enter', shift: false }, { type: 'key', key: 'ArrowRight' }, { type: 'key', key: ' ', shift: false }]) fromPage(m)
    expect(turns()).toHaveLength(3)
  })

  it('keys_TurnPagesAndHideTheBars_EscShowsThem', () => {
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

  it('spaceOnAButton_IsTheButtons_NotATurn', () => {
    opened()
    press(' ', {}, screen.getByRole('button', { name: 'Next ›' }))
    expect(turns()).toEqual([])
  })

  it('scrolledFlow_ANewPlaceHidesTheBars_TheFirstAfterAnOpenDoesNot', () => {
    localStorage.setItem('v2reader:flow', 'scrolled')
    opened()
    fromPage({ type: 'relocate', fraction: 0.1, index: 0, sections: 3 })
    expect(bars()).toBe('shown')
    fromPage({ type: 'relocate', fraction: 0.1, index: 0, sections: 3 })
    expect(bars()).toBe('shown')
    fromPage({ type: 'relocate', fraction: 0.2, index: 0, sections: 3 })
    expect(bars()).toBe('hidden')
  })

  it('paginatedFlow_APageTurnFromTheBar_KeepsTheBars', () => {
    opened()
    fromPage({ type: 'relocate', fraction: 0.1, index: 0, sections: 3 })
    fromPage({ type: 'relocate', fraction: 0.2, index: 0, sections: 3 })
    expect(bars()).toBe('shown')
  })

  it('focusOnAHiddenBar_ShowsTheBars', () => {
    opened()
    fromPage(tap(WIDTH / 2))
    expect(bars()).toBe('hidden')
    act(() => { screen.getByRole('button', { name: 'Next ›' }).focus() })
    expect(bars()).toBe('shown')
  })

  it('aStateWithTheBarsHidden_NotInsideABar', () => {
    const view = opened()
    fromPage(tap(WIDTH / 2))
    expect(bars()).toBe('hidden')
    view.rerender(<MemoryRouter><V2ReaderHost book={{ bytes: new ArrayBuffer(8), name: 'b.epub' }} idleHeading="idle" /></MemoryRouter>)
    fromPage({ type: 'open-failed', name: '2/b.epub', error: 'not a zip' })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('cannot open b.epub')
    expect(alert.closest('header, footer')).toBeNull()
  })

  it('backLink_NamedAndToTheGivenUrl', () => {
    mount({ backUrl: '/en/library' })
    expect(screen.getByRole('link', { name: 'Back to the library' })).toHaveAttribute('href', '/en/library')
  })
})

describe('keyAction', () => {
  const k = (key: string, init: Partial<KeyboardEvent> = {}, target: EventTarget | null = document.body) =>
    keyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target, ...init })

  it('readerKeys', () => {
    expect([k('ArrowLeft'), k('PageUp'), k(' ', { shiftKey: true })]).toEqual(['prev', 'prev', 'prev'])
    expect([k('ArrowRight'), k('PageDown'), k(' ')]).toEqual(['next', 'next', 'next'])
    expect(k('Escape')).toBe('show')
    expect(k('a')).toBeNull()
  })

  it('rtlBook_ArrowsFollowTheScreen_PageKeysAndSpaceDoNot', () => {
    const r = (key: string, init: Partial<KeyboardEvent> = {}) =>
      keyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: null, ...init }, 'rtl')
    expect([r('ArrowLeft'), r('ArrowRight')]).toEqual(['next', 'prev'])
    expect([r('PageDown'), r('PageUp'), r(' '), r(' ', { shiftKey: true })]).toEqual(['next', 'prev', 'next', 'prev'])
  })

  it('modifierChords_NotTheReaders', () => {
    expect(k('ArrowLeft', { altKey: true })).toBeNull()
    expect(k('ArrowRight', { metaKey: true })).toBeNull()
    expect(k(' ', { ctrlKey: true })).toBeNull()
  })

  it('typingInAField_NotTheReaders', () => {
    const input = document.createElement('input')
    expect(k('ArrowLeft', {}, input)).toBeNull()
    expect(k(' ', {}, input)).toBeNull()
  })

  it('spaceOnAButtonOrLink_ActivatesIt_ArrowsStillTurn', () => {
    const button = document.createElement('button')
    expect(k(' ', {}, button)).toBeNull()
    expect(k(' ', {}, document.createElement('a'))).toBeNull()
    expect(k('ArrowRight', {}, button)).toBe('next')
  })
})
