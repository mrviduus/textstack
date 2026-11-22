import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReaderHost } from './ReaderHost'

// #1267: the V2 reader's keyboard and screen-reader baseline on the web, through a fake frame as
// ReaderHost.chrome.test.tsx: the skip link, the settings dialog's trap and Escape. The contents dialog's are in
// ReaderHost.toc.test.tsx; names and roles everywhere are axe's (`reader.spec.ts`, `@reader`).

const frame = () => screen.getByTitle('Book text') as HTMLIFrameElement

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}

let posted: { call: string; args: unknown[] }[] = []
function opened() {
  posted = []
  render(<MemoryRouter><ReaderHost book={{ bytes: new ArrayBuffer(8), name: 'a.epub' }} idleHeading="idle" /></MemoryRouter>)
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', book: { sha256: 'aa', size: 8, name: '1/a.epub' } })
}
const settingsButton = () => screen.getByRole('button', { name: 'Reading settings' })
const dialog = () => screen.queryByRole('dialog', { name: 'Reading settings' })
const openSettings = () => act(() => {
  settingsButton().focus()
  fireEvent.click(settingsButton())
})
const tab = (shiftKey = false) => act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey }) })

describe('ReaderHost accessibility (#1267)', () => {
  it('skipLink_FirstInTheDocument_TakesFocusToTheBook', () => {
    opened()
    const skip = screen.getByRole('link', { name: 'Skip to the book' })
    expect(document.querySelector('main')!.querySelector('a, button')).toBe(skip)
    expect(skip.getAttribute('href')).toBe(`#${frame().id}`)
    act(() => { fireEvent.click(skip) })
    expect(document.activeElement).toBe(frame())
  })

  it('settings_ADialogThatKeepsTab_EscapeCloses_FocusBackOnItsButton', () => {
    opened()
    openSettings()
    const d = dialog()!
    expect(d.getAttribute('aria-modal')).toBe('true')
    const close = within(d).getByRole('button', { name: 'Close reading settings' })
    // The trap's first stop is the close button; Shift+Tab from it goes round to the last control, Tab back.
    expect(document.activeElement).toBe(close)
    tab(true)
    const last = document.activeElement!
    expect(d.contains(last) && last !== close).toBe(true)
    tab()
    expect(document.activeElement).toBe(close)
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }) })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(settingsButton())
  })

  it('ready_TheLightboxsWordsSentInTheReadersLanguage', () => {
    opened()
    expect(posted.filter((m) => m.call === 'labels').map((m) => m.args)).toEqual([[{ image: 'Image', close: 'Close image' }]])
  })

  it('lightboxOpen_TheBarsStatesAndSkipLinkInert_SoTabNeverReachesThem_ClosedNotInert', () => {
    opened()
    const outside = () => [document.querySelector('.skip-link'), document.querySelector('header'), document.querySelector('footer')]
    expect(outside().map((el) => el!.hasAttribute('inert'))).toEqual([false, false, false])
    fromPage({ type: 'lightbox', open: true })
    expect(outside().map((el) => el!.hasAttribute('inert'))).toEqual([true, true, true])
    expect(document.querySelector('.v2-reader__notices')!.hasAttribute('inert')).toBe(false)
    fromPage({ type: 'lightbox', open: false })
    expect(outside().map((el) => el!.hasAttribute('inert'))).toEqual([false, false, false])
    // A fresh frame (its `ready`) has no lightbox: nothing stays inert.
    fromPage({ type: 'lightbox', open: true })
    fromPage({ type: 'ready' })
    expect(outside().map((el) => el!.hasAttribute('inert'))).toEqual([false, false, false])
  })
})
