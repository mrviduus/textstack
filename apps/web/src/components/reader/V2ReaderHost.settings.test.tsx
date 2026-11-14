import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost, hostNavKey, type V2HostBook } from './V2ReaderHost'

// #1260: the V2 reader's settings on the web, driven through a fake frame as V2ReaderHost.chrome.test.tsx.

const KEY = 'v2reader.settings'
const DEFAULTS = { fontSize: 20, lineHeight: 1.6, fontFamily: 'serif', textAlign: 'book', theme: 'light' }
const frame = () => screen.getByTitle('V2 reader') as HTMLIFrameElement
let posted: { call: string; args: unknown[] }[]
const sent = () => posted.filter((m) => m.call === 'settings').map((m) => m.args[0])

beforeEach(() => {
  localStorage.clear()
  posted = []
})

function mount() {
  const book: V2HostBook = { bytes: new ArrayBuffer(8), name: 'a.epub' }
  const view = render(<MemoryRouter><V2ReaderHost book={book} idleHeading="idle" /></MemoryRouter>)
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  return view
}
function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}
function opened(reflowable = true) {
  const view = mount()
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', reflowable, book: { sha256: 'aa', size: 8, name: '1/a.epub' } })
  return view
}
const openPanel = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Reading settings' }))
  return within(screen.getByTestId('v2-settings'))
}

describe('V2ReaderHost settings', () => {
  it('ready_NothingStored_SendsTheDefaultsBeforeTheOpen', () => {
    mount()
    fromPage({ type: 'ready' })
    expect(sent()).toEqual([DEFAULTS])
    expect(posted.findIndex((m) => m.call === 'settings')).toBeLessThan(posted.findIndex((m) => m.call === 'openBytes'))
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('ready_StoredChoices_Restored_ThemeOnTheBars', () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'dark', fontSize: 24 }))
    mount()
    fromPage({ type: 'ready' })
    expect(sent()).toEqual([{ ...DEFAULTS, theme: 'dark', fontSize: 24 }])
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it.each([['{'], ['"dark"'], [JSON.stringify({ theme: 'neon', fontSize: '24', fontFamily: 'system', ttsVoiceEn: 'x' })]])('ready_Stored%s_MalformedOrOlder_Defaults', (stored) => {
    localStorage.setItem(KEY, stored)
    mount()
    fromPage({ type: 'ready' })
    expect(sent()).toEqual([DEFAULTS])
  })

  it('beforeReady_NothingIsSent', () => {
    mount()
    expect(sent()).toEqual([])
  })

  it('change_AppliedLive_StoredAsTheChoiceOnly', () => {
    opened()
    posted = []
    const panel = openPanel()
    fireEvent.click(panel.getByRole('button', { name: 'Dark' }))
    fireEvent.click(panel.getByRole('button', { name: 'Larger text' }))
    expect(sent()).toEqual([{ ...DEFAULTS, theme: 'dark' }, { ...DEFAULTS, theme: 'dark', fontSize: 22 }])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ theme: 'dark', fontSize: 22 })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(panel.getByTestId('v2-font-size').textContent).toBe('22px')
    fireEvent.click(panel.getByRole('button', { name: 'Dyslexic' }))
    fireEvent.click(panel.getByRole('button', { name: '1.8' }))
    fireEvent.click(panel.getByRole('button', { name: 'Justify' }))
    expect(sent().slice(-1)[0]).toEqual({ fontSize: 22, lineHeight: 1.8, fontFamily: 'dyslexic', textAlign: 'justify', theme: 'dark' })
    // Nothing of the legacy reader's dead settings is offered.
    expect(panel.queryByText(/tts|voice|auto-save/i)).toBeNull()
  })

  it('fontSize_StopsAtItsEnds', () => {
    localStorage.setItem(KEY, JSON.stringify({ fontSize: 28 }))
    opened()
    const panel = openPanel()
    expect((panel.getByRole('button', { name: 'Larger text' }) as HTMLButtonElement).disabled).toBe(true)
    expect((panel.getByRole('button', { name: 'Smaller text' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('fixedLayout_TypographyDisabled_ThemeStillApplies', () => {
    opened(false)
    posted = []
    const panel = openPanel()
    expect((panel.getByTestId('v2-settings-typography') as HTMLFieldSetElement).disabled).toBe(true)
    fireEvent.click(panel.getByRole('button', { name: 'Sepia' }))
    expect(sent()).toEqual([{ ...DEFAULTS, theme: 'sepia' }])
  })

  it('reflowable_TypographyEnabled', () => {
    opened()
    expect((openPanel().getByTestId('v2-settings-typography') as HTMLFieldSetElement).disabled).toBe(false)
  })

  it('escapeOrClose_ClosesThePanel', () => {
    opened()
    fireEvent.keyDown(openPanel().getByRole('button', { name: 'Dark' }), { key: 'Escape' })
    expect(screen.queryByTestId('v2-settings')).toBeNull()
    fireEvent.click(openPanel().getByRole('button', { name: 'Close reading settings' }))
    expect(screen.queryByTestId('v2-settings')).toBeNull()
  })

  // #1260 review: the panel is modal; a page key on one of its buttons must not turn (and save) the page behind it.
  it('panelOpen_PageKeysOnItsControls_DoNotTurnThePage_EscapeStillCloses', () => {
    opened()
    posted = []
    const panel = openPanel()
    for (const key of ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp']) fireEvent.keyDown(panel.getByRole('button', { name: 'Dark' }), { key })
    expect(posted.filter((m) => m.call === 'next' || m.call === 'prev')).toEqual([])
    fireEvent.keyDown(panel.getByRole('button', { name: 'Dark' }), { key: 'Escape' })
    expect(screen.queryByTestId('v2-settings')).toBeNull()
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(posted.filter((m) => m.call === 'next' || m.call === 'prev').map((m) => m.call)).toEqual(['next'])
  })

  it('hostNavKey_InsideAnyDialog_EscapeOnly', () => {
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    const button = dialog.appendChild(document.createElement('button'))
    const at = (key: string) => hostNavKey({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, target: button })
    for (const key of ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', 'Home', 'End']) expect(at(key)).toBeNull()
    expect(at('Escape')?.key).toBe('Escape')
    dialog.remove()
  })

  it('unmount_TheThemeLeavesTheDocument', () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'sepia' }))
    const view = mount()
    expect(document.documentElement.dataset.theme).toBe('sepia')
    view.unmount()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})
