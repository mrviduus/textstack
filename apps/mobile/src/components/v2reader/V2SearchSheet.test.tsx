// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_SEARCH, SEARCH_DEBOUNCE_MS, readSearchResults, searchStart, searchTake, type Search } from '../../../../../packages/reader/src/search.mjs'

// #1315: the Android host's search sheet. No React Native renderer here (as readerBars.a11y.test.tsx): react-native's
// views are stubbed as DOM elements carrying their accessible name and press handler.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('react-native', () => {
  type P = { children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; accessibilityLiveRegion?: string; onPress?: () => void }
  const view = ({ children, accessibilityLabel, accessibilityRole, accessibilityLiveRegion, onPress }: P) =>
    createElement('div', { 'aria-label': accessibilityLabel, role: accessibilityRole, 'aria-live': accessibilityLiveRegion, onClick: onPress }, children)
  return {
    View: view,
    Text: view,
    Pressable: view,
    TouchableOpacity: view,
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('section', null, children) : null),
    TextInput: ({ value, onChangeText, accessibilityLabel, maxLength, autoFocus }: { value: string; onChangeText: (t: string) => void; accessibilityLabel?: string; maxLength?: number; autoFocus?: boolean }) =>
      createElement('input', { value, 'aria-label': accessibilityLabel, maxLength, 'data-autofocus': String(!!autoFocus), onChange: (e: { target: { value: string } }) => onChangeText(e.target.value) }),
    FlatList: <T,>({ data, renderItem, keyExtractor, keyboardDismissMode }: { data: T[]; renderItem: (i: { item: T }) => ReactNode; keyExtractor: (i: T) => string; keyboardDismissMode?: string }) =>
      createElement('ul', { 'data-dismiss': keyboardDismissMode }, data.map((item) => createElement('li', { key: keyExtractor(item) }, renderItem({ item })))),
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  }
})
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('../../theme/typography', () => ({ fonts: {} }))
vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ colors: {} }) }))
vi.mock('../../context/LanguageContext', () => ({ useLanguage: () => ({ t: (k: string) => k }) }))
vi.mock('../../hooks/useReduceMotion', () => ({ useReduceMotion: () => false }))

const { V2SearchSheet, searchStatus } = await import('./V2SearchSheet')

const CFI = (n: number) => `epubcfi(/6/${n}!/4/2,/1:0,/1:5)`
const hit = (n: number, o: object = {}) => ({ cfi: CFI(n), pre: `before ${n} `, match: 'Whale', post: ` after ${n}`, label: `Chapter ${n}`, ...o })
/** A search for `query` that the page answered with `hits`. */
const answered = (query: string, hits: object[], o: object = { done: true }): Search => {
  const s = searchStart(NO_SEARCH, query)
  return searchTake(s, readSearchResults({ type: 'search-results', key: 'aa', id: s.id, results: hits, done: false, more: false, ...o })!)
}

let div: HTMLElement
let unmount: () => void
const on = { query: vi.fn(), go: vi.fn(), close: vi.fn() }
function show(search: Search, visible = true) {
  div = document.createElement('div')
  document.body.append(div)
  const root = createRoot(div)
  const el = (s: Search, v: boolean) => createElement(V2SearchSheet, { visible: v, search: s, onQuery: on.query, onGo: on.go, onClose: on.close })
  act(() => root.render(el(search, visible)))
  unmount = () => act(() => root.unmount())
  return (s: Search, v = true) => act(() => root.render(el(s, v)))
}
const input = () => div.querySelector('input')!
const type = (text: string) => act(() => {
  // React tracks an input's value: set it through the element's own setter, then tell React.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text)
  input().dispatchEvent(new Event('input', { bubbles: true }))
})
const rows = () => Array.from(div.querySelectorAll('li')).map((li) => li.textContent)

beforeEach(() => {
  vi.useFakeTimers()
  for (const f of Object.values(on)) f.mockClear()
})
afterEach(() => {
  unmount?.()
  div?.remove()
  vi.useRealTimers()
})

describe('V2SearchSheet (#1315)', () => {
  it('searchStatus_NothingAsked_Searching_None_Counted_OrTheFirstShown', () => {
    const t = (k: string) => ({ 'reader.v2.searchCount': 'Results: {count}', 'reader.v2.searchMore': 'First {count}' }[k] ?? k)
    expect(searchStatus(NO_SEARCH, '', t)).toBe('')
    expect(searchStatus(searchStart(NO_SEARCH, 'w'), 'w', t)).toBe('reader.v2.searchTooShort')
    expect(searchStatus(searchStart(NO_SEARCH, 'whale'), 'whale', t)).toBe('reader.v2.searching')
    expect(searchStatus(answered('whale', [hit(2)], {}), 'whale', t)).toBe('reader.v2.searching')
    expect(searchStatus(answered('whale', []), 'whale', t)).toBe('reader.v2.searchNone')
    expect(searchStatus(answered('whale', [hit(2), hit(4)]), 'whale', t)).toBe('Results: 2')
    expect(searchStatus(answered('whale', [hit(2), hit(4)], { done: true, more: true }), 'whale', t)).toBe('First 2')
    // Part of the book could not be read: said once the search ended, never while it runs.
    expect(searchStatus(answered('whale', [hit(2)], { done: true, incomplete: true }), 'whale', t)).toBe('Results: 1 reader.v2.searchIncomplete')
    expect(searchStatus(answered('whale', [], { done: true, incomplete: true }), 'whale', t)).toBe('reader.v2.searchNone reader.v2.searchIncomplete')
    expect(searchStatus(answered('whale', [hit(2)], { incomplete: true }), 'whale', t)).toBe('reader.v2.searching')
  })

  it('results_ListedInOrder_SectionThenContextAroundTheHit_AsText', () => {
    const evil = '<img src=x onerror="window.__pwned=1">'
    show(answered('whale', [hit(2), hit(4, { label: '' }), hit(6, { pre: evil, match: '<b>W</b>', post: evil, label: evil })]))
    expect(rows()).toEqual(['Chapter 2before 2 Whale after 2', 'before 4 Whale after 4', `${evil}${evil}<b>W</b>${evil}`])
    expect(div.querySelector('img, b')).toBeNull()
    expect(div.querySelector('[aria-live="polite"]')!.textContent).toBe('reader.v2.searchCount')
  })

  it('typing_AskedOnceTheReaderPauses_TheSameQueryNotAskedAgain', () => {
    const update = show(NO_SEARCH)
    // An empty sheet opens with the keyboard up.
    expect(input().dataset.autofocus).toBe('true')
    type('wha')
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1) })
    type('whale')
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1) })
    expect(on.query).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(on.query.mock.calls).toEqual([['whale']])
    // The host asked the page: the same query typed again (a trailing space) asks nothing.
    update(searchStart(NO_SEARCH, 'whale'))
    type('whale ')
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS) })
    expect(on.query.mock.calls).toEqual([['whale']])
  })

  it('opened_OnASearchAlreadyMade_ShowsItsQuery_AsksNothing_KeyboardStaysDown_AndGoesWhenTheListIsDragged', () => {
    show(answered('whale', [hit(2)]))
    expect(input().value).toBe('whale')
    // The rows under the keyboard are reachable: no focus on a sheet reopened on its results, and a drag puts it away.
    expect(input().dataset.autofocus).toBe('false')
    expect(div.querySelector('ul')!.dataset.dismiss).toBe('on-drag')
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS) })
    expect(on.query).not.toHaveBeenCalled()
  })

  it('clear_EmptiesTheField_AndAsksForNoSearch', () => {
    show(answered('whale', [hit(2)]))
    act(() => { (div.querySelector('[aria-label="reader.v2.searchClear"]') as HTMLElement).click() })
    expect(input().value).toBe('')
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS) })
    expect(on.query.mock.calls).toEqual([['']])
    // Nothing typed: no clear button.
    expect(div.querySelector('[aria-label="reader.v2.searchClear"]')).toBeNull()
  })

  it('resultPressed_GoesToThatResult_AndCloses', () => {
    show(answered('whale', [hit(2), hit(4)]))
    act(() => { (div.querySelectorAll('li [role="button"]')[1] as HTMLElement).click() })
    expect(on.go.mock.calls).toEqual([[hit(4)]])
    expect(on.close).toHaveBeenCalledTimes(1)
  })

  it('controls_Named_TheFieldCapped_HiddenSheetRendersNothing', () => {
    show(answered('whale', [hit(2)]))
    expect(Array.from(div.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label'))).toEqual(['reader.v2.searchLabel', 'reader.v2.searchClear', 'reader.v2.searchClose'])
    expect(input().maxLength).toBe(100)
    unmount()
    show(answered('whale', [hit(2)]), false)
    expect(div.textContent).toBe('')
  })
})
