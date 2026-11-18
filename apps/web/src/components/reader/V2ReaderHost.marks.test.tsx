import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'
import type { V2MarkWord } from '../../../../../packages/reader/src/wordMarks.mjs'

// #1271: the host sends the page the reader's saved words (V2ReaderPopups' vocabulary) and the gloss setting (the
// legacy reader's `showInlineTranslations`), driven through a fake frame as V2ReaderHost.settings.test.tsx.

let onMarks: ((w: V2MarkWord[]) => void) | undefined
vi.mock('./V2ReaderPopups', () => ({
  V2ReaderPopups: (p: { onMarks?: (w: V2MarkWord[]) => void }) => { onMarks = p.onMarks; return null },
}))

const LEGACY = 'reader.settings.v1'
const frame = () => screen.getByTitle('Book text') as HTMLIFrameElement
let posted: { call: string; args: unknown[] }[]
const marksSent = () => posted.filter((m) => m.call === 'markWords').map((m) => m.args)
const WORDS: V2MarkWord[] = [{ word: 'keeper', stage: 2, gloss: 'хранитель' }]

beforeEach(() => { localStorage.clear(); posted = []; onMarks = undefined })
afterEach(() => cleanup())

function mount() {
  const book: V2HostBook = { bytes: new ArrayBuffer(8), name: 'a.epub' }
  render(<MemoryRouter><V2ReaderHost book={book} idleHeading="idle" /></MemoryRouter>)
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
}
const fromPage = (m: object) =>
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
function opened(annotatable = true) {
  mount()
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', annotatable, book: { sha256: 'aa', size: 8, name: '1/a.epub' } })
}
const openPanel = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Reading settings' }))
  return within(screen.getByTestId('v2-settings'))
}

describe('V2ReaderHost saved-word marks', () => {
  it('vocabulary_Changes_SentToThePage_WithTheSetting', () => {
    opened()
    act(() => onMarks!(WORDS))
    expect(marksSent()[marksSent().length - 1]).toEqual([WORDS, true])
  })

  it('noWords_NothingSent_WordsThenNone_TheNoneIsSent', () => {
    opened()
    act(() => onMarks!([]))
    fromPage({ type: 'ready' })
    expect(marksSent()).toEqual([])
    act(() => onMarks!(WORDS))
    act(() => onMarks!([]))
    expect(marksSent()).toEqual([[WORDS, true], [[], true]])
  })

  it('newFrame_Ready_TheWordsHeldAreSentAgain', () => {
    opened()
    act(() => onMarks!(WORDS))
    posted = []
    fromPage({ type: 'ready' })
    expect(marksSent()).toEqual([[WORDS, true]])
  })

  it('legacySettingOff_GlossesHidden', () => {
    localStorage.setItem(LEGACY, JSON.stringify({ fontSize: 22, showInlineTranslations: false }))
    opened()
    act(() => onMarks!(WORDS))
    expect(marksSent()[marksSent().length - 1]).toEqual([WORDS, false])
  })

  it('toggle_SentLive_StoredInTheLegacySetting_OtherFieldsKept', () => {
    localStorage.setItem(LEGACY, JSON.stringify({ fontSize: 22 }))
    opened()
    act(() => onMarks!(WORDS))
    posted = []
    const sw = openPanel().getByTestId('v2-glosses')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(marksSent()).toEqual([[WORDS, false]])
    expect(JSON.parse(localStorage.getItem(LEGACY)!)).toEqual({ fontSize: 22, showInlineTranslations: false })
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('aBookWithNoOverlays_NoSwitch', () => {
    opened(false)
    expect(openPanel().queryByTestId('v2-glosses')).toBeNull()
  })
})
