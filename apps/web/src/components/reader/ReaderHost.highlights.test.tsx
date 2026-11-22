import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReaderHost, type HostBook } from './ReaderHost'

// #1312: highlights on the web host (the dev route: notes in memory): the list beside Contents, a tap on a highlight
// opens its editor (recolour, note, delete through the page), the deep link jumps. The production route's session
// wiring is ReaderHost.sync.test.tsx's.

const WIDTH = 1000
const SHA = 'aa'
const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const frame = () => screen.getByTitle('Book text') as HTMLIFrameElement
let posted: { call: string; args: unknown[] }[]

beforeEach(() => {
  localStorage.clear()
  posted = []
})
afterEach(cleanup)

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}
function opened({ highlightId, toc = [] as object[], onHighlightShown }: { highlightId?: string; toc?: object[]; onHighlightShown?: () => void } = {}) {
  const book: HostBook = { bytes: new ArrayBuffer(8), name: 'a.epub' }
  render(<MemoryRouter><ReaderHost book={book} idleHeading="idle" dev highlightId={highlightId} onHighlightShown={onHighlightShown} /></MemoryRouter>)
  Object.defineProperty(frame(), 'clientWidth', { value: WIDTH, configurable: true })
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', lang: 'en', annotatable: true, toc, book: { sha256: SHA, size: 8, name: '1/a.epub' } })
  posted = []
}
const item = (id: string, text: string, color = 'yellow', n = 2) => ({ id, cfi: `epubcfi(/6/${n}!/4/2,/1:0,/1:5)`, color, text, at: 1 })
const list = (highlights: object[], key = SHA) => fromPage({ type: 'highlight-list', key, highlights })
const tap = (id = ID1, x = WIDTH / 2) => fromPage({ type: 'highlight-tap', id, x, y: 100, rect: { x: x - 20, y: 90, w: 40, h: 20 } })
const calls = (name: string) => posted.filter((m) => m.call === name).map((m) => m.args)
const openList = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
  fireEvent.click(screen.getByTestId('v2-highlights-tab'))
  return screen.getByTestId('v2-highlights-list')
}

describe('ReaderHost highlights', () => {
  it('list_ABookWithNoContents_TheHighlightsTabAlone_InThePagesOrder_TapJumpsThere', () => {
    opened()
    list([item(ID2, 'first in the book', 'green', 2), item(ID1, 'later', 'blue', 4)])
    const ul = openList()
    expect(within(ul).getAllByRole('button').map((b) => b.textContent)).toEqual(['first in the book', 'later'])
    fireEvent.click(within(ul).getByText('later'))
    // The reader's choice: saved where it lands (`chosen`).
    expect(calls('goTo')).toEqual([[item(ID1, 'later', 'blue', 4).cfi, true]])
    expect(screen.queryByTestId('v2-highlights-list')).toBeNull()
  })

  it('list_AnotherBooksList_Dropped_AMalformedItemDropped', () => {
    opened()
    list([item(ID2, 'kept'), { ...item(ID1, 'bad'), cfi: 'javascript:alert(1)' }])
    // A previous open's list, arriving late, replaces nothing.
    list([item(ID1, 'other book')], 'bb')
    expect(within(openList()).getAllByRole('button').map((b) => b.textContent)).toEqual(['kept'])
  })

  it('anotherBooksRemoval_ThisBooksNoteKept', () => {
    opened()
    list([item(ID1, 'by the pond')])
    tap()
    fireEvent.change(screen.getByPlaceholderText('Add a note...'), { target: { value: 'kept' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fromPage({ type: 'highlight-removed', key: 'bb', id: ID1 })
    tap()
    expect(screen.getByPlaceholderText('Add a note...')).toHaveValue('kept')
  })

  it('note_Long_SavedWhole_Trimmed', () => {
    opened()
    list([item(ID1, 'by the pond')])
    tap()
    fireEvent.change(screen.getByPlaceholderText('Add a note...'), { target: { value: `  ${'x'.repeat(6000)}  ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    tap()
    expect(screen.getByPlaceholderText('Add a note...')).toHaveValue('x'.repeat(6000))
  })

  it('untrustedTextAndNote_RenderedAsText', () => {
    opened()
    list([item(ID1, '<img src=x onerror=alert(1)>')])
    tap()
    fireEvent.change(screen.getByPlaceholderText('Add a note...'), { target: { value: '<b>bold</b>' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const ul = openList()
    expect(ul).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(ul).toHaveTextContent('<b>bold</b>')
    expect(ul.querySelector('img, b')).toBeNull()
  })

  it('tapOnAHighlight_TheEditor_RecolourAndDeleteGoThroughThePage', () => {
    opened()
    list([item(ID1, 'by the pond')])
    tap()
    expect(document.querySelector('.pdf-hl-popup')).toHaveTextContent('by the pond')
    fireEvent.click(screen.getByRole('button', { name: 'green' }))
    expect(calls('recolorHighlight')).toEqual([[ID1, 'green']])
    fireEvent.click(screen.getByRole('button', { name: 'Delete highlight' }))
    expect(calls('removeHighlight')).toEqual([[ID1]])
    expect(document.querySelector('.pdf-hl-popup')).toBeNull()
  })

  it('note_SavedTrimmed_ShownInTheListAndTheNextEditor_RemovedWithItsHighlight', () => {
    opened()
    list([item(ID1, 'by the pond')])
    tap()
    fireEvent.change(screen.getByPlaceholderText('Add a note...'), { target: { value: '  a thought  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(document.querySelector('.pdf-hl-popup')).toBeNull()
    tap()
    expect(screen.getByPlaceholderText('Add a note...')).toHaveValue('a thought')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(openList()).toHaveTextContent('a thought')
    fireEvent.click(screen.getByRole('button', { name: 'Close contents' }))
    fromPage({ type: 'highlight-removed', key: SHA, id: ID1 })
    list([item(ID1, 'by the pond')])
    tap()
    expect(screen.getByPlaceholderText('Add a note...')).toHaveValue('')
  })

  it('tapOnAHighlightOnAnEdge_TurnsThePage_NoEditor', () => {
    opened()
    list([item(ID1, 'by the pond')])
    tap(ID1, WIDTH - 10)
    expect(calls('next')).toHaveLength(1)
    expect(document.querySelector('.pdf-hl-popup')).toBeNull()
  })

  it('deepLink_JumpsOnceTheHighlightIsListed_Once_TheRouteToldToDropTheParameter', () => {
    const shown = vi.fn()
    opened({ highlightId: ID1, onHighlightShown: shown })
    list([item(ID2, 'not it')])
    expect(calls('goTo')).toEqual([])
    expect(shown).not.toHaveBeenCalled()
    list([item(ID2, 'not it'), item(ID1, 'it', 'pink', 6)])
    expect(calls('goTo')).toEqual([[item(ID1, 'it', 'pink', 6).cfi, true]])
    expect(shown).toHaveBeenCalledTimes(1)
    list([item(ID1, 'it', 'blue', 6)])
    expect(calls('goTo')).toHaveLength(1)
    expect(shown).toHaveBeenCalledTimes(1)
  })

  // #1312 review: whatever closes the editor, a changed note is kept; Cancel and Delete discard it.
  it('noteTyped_ThenATapInTheBookClosesTheEditor_TheNoteSavedAnyway', () => {
    opened()
    list([item(ID1, 'by the pond')])
    tap()
    expect(screen.getByPlaceholderText('Add a note...')).not.toHaveAttribute('maxLength')
    fireEvent.change(screen.getByPlaceholderText('Add a note...'), { target: { value: 'typed, never saved by hand' } })
    fromPage({ type: 'tap', x: WIDTH / 2, y: 10 })
    expect(document.querySelector('.pdf-hl-popup')).toBeNull()
    tap()
    expect(screen.getByPlaceholderText('Add a note...')).toHaveValue('typed, never saved by hand')
  })

  it('noteTyped_ThenCancel_OrDelete_NotSaved', () => {
    opened()
    list([item(ID1, 'by the pond'), item(ID2, 'other', 'green', 4)])
    tap()
    fireEvent.change(screen.getByPlaceholderText('Add a note...'), { target: { value: 'dropped' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    tap()
    expect(screen.getByPlaceholderText('Add a note...')).toHaveValue('')
    fireEvent.change(screen.getByPlaceholderText('Add a note...'), { target: { value: 'dropped too' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete highlight' }))
    tap()
    expect(screen.getByPlaceholderText('Add a note...')).toHaveValue('')
  })
})
