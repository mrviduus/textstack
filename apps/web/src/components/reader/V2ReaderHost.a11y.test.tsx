import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost } from './V2ReaderHost'

// #1267: the V2 reader's keyboard and screen-reader baseline on the web, through a fake frame as
// V2ReaderHost.chrome.test.tsx: the skip link, the settings dialog's trap and Escape. The contents dialog's are in
// V2ReaderHost.toc.test.tsx; names and roles everywhere are axe's (`v2-reader.spec.ts`, `@v2`).

const frame = () => screen.getByTitle('Book text') as HTMLIFrameElement

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}

function opened() {
  render(<MemoryRouter><V2ReaderHost book={{ bytes: new ArrayBuffer(8), name: 'a.epub' }} idleHeading="idle" /></MemoryRouter>)
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation((() => {}) as never)
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

describe('V2ReaderHost accessibility (#1267)', () => {
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
})
