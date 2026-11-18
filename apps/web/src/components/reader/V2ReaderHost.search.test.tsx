import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'
import { SEARCH_DEBOUNCE_MS, SEARCH_RENDER_MS } from '../../../../../packages/reader/src/search.mjs'

// #1315: in-book search on the web host, through a fake frame as V2ReaderHost.chrome.test.tsx: the page is asked
// `search(query, id)` and answers `search-results`; a result is a `goTo(cfi, chosen)`.

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
const calls = (name: string) => posted.filter((m) => m.call === name).map((m) => m.args)
const book = (name = 'a.epub'): V2HostBook => ({ bytes: new ArrayBuffer(8), name })
let rerender: (b: V2HostBook) => void
function opened(o: object = { searchable: true }) {
  posted = []
  const r = render(<MemoryRouter><V2ReaderHost book={book()} idleHeading="idle" /></MemoryRouter>)
  rerender = (b) => r.rerender(<MemoryRouter><V2ReaderHost book={b} idleHeading="idle" /></MemoryRouter>)
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Moby-Dick', book: { sha256: 'aa', size: 8, name: '1/a.epub' }, ...o })
}
const CFI = (n: number) => `epubcfi(/6/${n}!/4/2,/1:0,/1:5)`
const hit = (n: number, o: object = {}) => ({ cfi: CFI(n), pre: `before ${n} `, match: 'Whale', post: ` after ${n}`, label: `Chapter ${n}`, ...o })
/** A `search-results` message, and the time the host takes to put streamed results on screen. */
const results = (id: number, list: object[], o: object = {}) => {
  fromPage({ type: 'search-results', key: 'aa', id, results: list, done: false, more: false, ...o })
  act(() => { vi.advanceTimersByTime(SEARCH_RENDER_MS) })
}

const searchButton = () => screen.queryByRole('button', { name: 'Search' })
const dialog = () => screen.queryByRole('dialog', { name: 'Search in this book' })
const input = () => within(dialog()!).getByRole('searchbox', { name: 'Search in this book' }) as HTMLInputElement
const openSearch = () => act(() => {
  searchButton()!.focus()
  fireEvent.click(searchButton()!)
})
const type = (text: string) => act(() => {
  fireEvent.change(input(), { target: { value: text } })
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
})
const rows = () => within(dialog()!).getAllByRole('listitem').map((li) => li.textContent)
const status = () => within(dialog()!).getByRole('status').textContent

describe('V2ReaderHost in-book search (#1315)', () => {
  it('opened_SearchableStrictlyTrue_OffersSearch_AnythingElse_None', () => {
    opened({ searchable: true })
    expect(searchButton()).not.toBeNull()
    for (const o of [{}, { searchable: false }, { searchable: 'true' }, { searchable: 1 }]) {
      document.body.innerHTML = ''
      opened(o)
      expect(searchButton()).toBeNull()
    }
  })

  it('typing_AskedOnceTheReaderPauses_TrimmedQueryAndAnId_TooShortNotAsked', () => {
    opened()
    openSearch()
    expect(document.activeElement).toBe(input())
    act(() => { fireEvent.change(input(), { target: { value: 'wha' } }) })
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1) })
    expect(calls('search')).toEqual([])
    act(() => { fireEvent.change(input(), { target: { value: '  white   whale ' } }) })
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS) })
    expect(calls('search')).toEqual([['white whale', 1]])
    expect(status()).toBe('Searching…')
    // The same query again (a space typed after it) asks nothing.
    type('white whale ')
    expect(calls('search')).toEqual([['white whale', 1]])
  })

  it('results_Streamed_ListedInOrderWithContextAndSection_ThenCounted', () => {
    opened()
    openSearch()
    type('whale')
    results(1, [hit(2)])
    results(1, [hit(4), hit(6, { label: '' })])
    expect(rows()).toEqual(['Chapter 2before 2 Whale after 2', 'Chapter 4before 4 Whale after 4', 'before 6 Whale after 6'])
    expect(within(dialog()!).getAllByRole('listitem')[0].querySelector('mark')!.textContent).toBe('Whale')
    expect(status()).toBe('Searching…')
    results(1, [], { done: true })
    expect(status()).toBe('Results: 3')
  })

  it('results_NoneFound_SaysSo_Capped_SaysTheFirstAreShown', () => {
    opened()
    openSearch()
    type('zzz')
    results(1, [], { done: true })
    expect(status()).toBe('No results')
    type('whale')
    results(2, [hit(2), hit(4)])
    results(2, [], { done: true, more: true })
    expect(status()).toBe('Showing the first 2 results')
  })

  it('results_Streamed_ShownOncePerInterval_NotPerMessage_TheEndAtOnce', () => {
    opened()
    openSearch()
    type('whale')
    fromPage({ type: 'search-results', key: 'aa', id: 1, results: [hit(2)], done: false, more: false })
    fromPage({ type: 'search-results', key: 'aa', id: 1, results: [hit(4)], done: false, more: false })
    expect(within(dialog()!).queryAllByRole('listitem')).toEqual([])
    act(() => { vi.advanceTimersByTime(SEARCH_RENDER_MS) })
    expect(rows()).toHaveLength(2)
    // The end is not held back.
    fromPage({ type: 'search-results', key: 'aa', id: 1, results: [hit(6)], done: false, more: false })
    fromPage({ type: 'search-results', key: 'aa', id: 1, results: [], done: true, more: false })
    expect(rows()).toHaveLength(3)
    expect(status()).toBe('Results: 3')
  })

  it('status_TypedButTooShort_SaysSo_PartOfTheBookUnread_SaidBesideTheCount', () => {
    opened()
    openSearch()
    expect(status()).toBe('')
    // A query typed, the page not asked yet (the debounce): nothing announced.
    act(() => { fireEvent.change(input(), { target: { value: 'whale' } }) })
    expect(status()).toBe('')
    act(() => { fireEvent.change(input(), { target: { value: '' } }) })
    type('w')
    expect(calls('search')).toEqual([])
    expect(status()).toBe('Type at least 2 characters')
    // One character is a word where words have no spaces between them.
    type('水')
    expect(calls('search')).toEqual([['水', 1]])
    results(1, [hit(2)])
    expect(status()).toBe('Searching…')
    results(1, [], { done: true, incomplete: true })
    expect(status()).toBe('Results: 1 Part of this book could not be searched.')
    type('whale')
    results(2, [hit(2)], { incomplete: true })
    expect(status()).toBe('Searching…')
    results(2, [], { done: true })
    expect(status()).toBe('Results: 1')
  })

  it('results_OfAnOlderSearch_OfAnotherBook_OrMalformed_Dropped', () => {
    opened()
    openSearch()
    type('whale')
    type('ahab')
    expect(calls('search')).toEqual([['whale', 1], ['ahab', 2]])
    // The first search's answer, late.
    results(1, [hit(2)], { done: true })
    expect(within(dialog()!).queryAllByRole('listitem')).toEqual([])
    expect(status()).toBe('Searching…')
    // Another book's (a previous open's), and one that is no result.
    fromPage({ type: 'search-results', key: 'bb', id: 2, results: [hit(4)], done: true, more: false })
    results(2, [hit(6, { cfi: 'javascript:alert(1)' }), hit(8)])
    expect(rows()).toEqual(['Chapter 8before 8 Whale after 8'])
  })

  it('resultChosen_GoesThereAsTheReadersChoice_ClosesTheDrawer_ReopenedOnTheSameResults', () => {
    opened()
    openSearch()
    type('whale')
    results(1, [hit(2), hit(4)], { done: true })
    act(() => { fireEvent.click(within(dialog()!).getAllByRole('button').find((b) => b.textContent?.includes('after 4'))!) })
    expect(calls('goTo')).toEqual([[CFI(4), true]])
    expect(dialog()).toBeNull()
    // Opened again: the same search, nothing asked again; focus on the first result, not the field (no keyboard
    // over the list), and Tab stays in the dialog.
    openSearch()
    expect(input().value).toBe('whale')
    expect(document.activeElement).toBe(within(dialog()!).getAllByRole('listitem')[0].querySelector('button'))
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS) })
    expect(rows()).toHaveLength(2)
    expect(calls('search')).toEqual([['whale', 1]])
  })

  it('cleared_ThePageDropsItsHits_NoResultsLeft', () => {
    opened()
    openSearch()
    type('whale')
    results(1, [hit(2)], { done: true })
    // The clear button goes with the text: focus must not be left on nothing.
    act(() => {
      within(dialog()!).getByRole('button', { name: 'Clear search' }).focus()
      fireEvent.click(within(dialog()!).getByRole('button', { name: 'Clear search' }))
    })
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS) })
    expect(calls('search')).toEqual([['whale', 1], [null, 2]])
    expect(within(dialog()!).queryAllByRole('listitem')).toEqual([])
    expect(status()).toBe('')
    expect(document.activeElement).toBe(input())
    // A late answer of the cleared search changes nothing.
    results(1, [hit(4)])
    results(2, [hit(6)])
    expect(within(dialog()!).queryAllByRole('listitem')).toEqual([])
  })

  it('newOpen_TheSearchEndsWithItsBook_TheNextBooksDrawerStartsEmpty', () => {
    opened()
    openSearch()
    type('whale')
    results(1, [hit(2)], { done: true })
    act(() => rerender(book('b.epub')))
    // The page still shows the first book until the swap: its hits go now.
    expect(calls('search')).toEqual([['whale', 1], [null]])
    expect(dialog()).toBeNull()
    // While the next book opens, the previous book's search is not offered.
    expect(searchButton()).toBeNull()
    fromPage({ type: 'opened', title: 'Walden', book: { sha256: 'bb', size: 8, name: '2/b.epub' }, searchable: true })
    // Closed with the book it searched: the next book does not open on a search drawer.
    expect(dialog()).toBeNull()
    openSearch()
    expect(input().value).toBe('')
    expect(within(dialog()!).queryAllByRole('listitem')).toEqual([])
    // With no search to end, an open asks the page nothing.
    act(() => rerender(book('c.epub')))
    expect(calls('search')).toHaveLength(2)
  })

  it('bookText_ShownAsTextOnly_NeverAsMarkup', () => {
    opened()
    openSearch()
    type('whale')
    const evil = '<img src=x onerror="window.__pwned=1">'
    results(1, [hit(2, { pre: evil, match: '<b>Whale</b>', post: evil, label: evil })], { done: true })
    expect(dialog()!.querySelector('img, b')).toBeNull()
    expect(rows()).toEqual([`${evil}${evil}<b>Whale</b>${evil}`])
  })

  it('dialog_Modal_EscapeCloses_FocusBackOnItsButton_ItsKeysTurnNoPage', () => {
    opened()
    openSearch()
    expect(dialog()!.getAttribute('aria-modal')).toBe('true')
    posted = []
    // The dialog keeps its keys: none reaches the reader's own key handler (page turns, Esc for the bars) on the window.
    const reached = vi.fn()
    window.addEventListener('keydown', reached)
    act(() => { fireEvent.keyDown(input(), { key: 'ArrowRight' }) })
    act(() => { fireEvent.keyDown(within(dialog()!).getByRole('button', { name: 'Close search' }), { key: 'PageDown' }) })
    expect(posted.filter((m) => m.call === 'next' || m.call === 'prev')).toEqual([])
    act(() => { fireEvent.keyDown(input(), { key: 'Escape' }) })
    window.removeEventListener('keydown', reached)
    expect(reached).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(searchButton())
  })
})
