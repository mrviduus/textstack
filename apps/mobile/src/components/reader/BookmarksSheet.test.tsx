// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

// #1314: the Android bookmarks sheet. No React Native renderer here (readerBars.a11y.test.tsx's way): its views are
// stubbed as DOM elements, a press is a click.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('react-native', () => {
  type P = { children?: ReactNode; onPress?: () => void; testID?: string; accessibilityLabel?: string; accessibilityState?: { selected?: boolean } }
  const view = ({ children }: P) => createElement('div', null, children)
  const press = ({ children, onPress, testID, accessibilityLabel, accessibilityState }: P) =>
    createElement('button', { onClick: onPress, 'data-testid': testID, 'aria-label': accessibilityLabel, 'aria-selected': accessibilityState?.selected }, children)
  return {
    View: view,
    Text: view,
    Pressable: view,
    TouchableOpacity: press,
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { role: 'dialog' }, children) : null),
    FlatList: <T,>({ data, renderItem, keyExtractor }: { data: T[]; renderItem: (i: { item: T }) => ReactNode; keyExtractor: (i: T) => string }) =>
      createElement('ul', null, data.map((item) => createElement('li', { key: keyExtractor(item) }, renderItem({ item })))),
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  }
})
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('../../theme/typography', () => ({ fonts: {} }))
vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ colors: {} }) }))
vi.mock('../../context/LanguageContext', () => ({ useLanguage: () => ({ t: (k: string) => k }) }))
vi.mock('../../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../../lib/readerColors', () => ({ HIGHLIGHT_BG: {} }))

const { BookmarksSheet } = await import('./ReaderToc')

const A = { id: 'a', cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:5)', text: 'First words', at: 1 }
const B = { id: 'b', cfi: 'epubcfi(/6/8!/4/2,/1:0,/1:5)', text: '<b>Later</b> words', at: 2 }

function sheet(props: Partial<Parameters<typeof BookmarksSheet>[0]> = {}) {
  const on = { onToggle: vi.fn(), onGo: vi.fn(), onRemove: vi.fn(), onClose: vi.fn() }
  const div = document.createElement('div')
  act(() => createRoot(div).render(createElement(BookmarksSheet, { visible: true, items: [A, B], here: null, can: true, placing: false, ...on, ...props })))
  const toggle = () => div.querySelector<HTMLElement>('[data-testid="v2-bookmark-toggle"]')
  const rows = () => [...div.querySelectorAll<HTMLElement>('[data-testid="v2-bookmark-row"]')]
  const removes = () => [...div.querySelectorAll<HTMLElement>('[data-testid="v2-bookmark-remove"]')]
  return { div, on, toggle, rows, removes }
}

describe('BookmarksSheet (#1314)', () => {
  it('noneHere_TheButton_OneConstantName_NotSelected_ItsPressToggles', () => {
    const s = sheet()
    expect(s.toggle()!.textContent).toBe('reader.chrome.bookmark')
    expect(s.toggle()!.getAttribute('aria-selected')).toBe('false')
    act(() => s.toggle()!.click())
    expect(s.on.onToggle).toHaveBeenCalledTimes(1)
    expect(s.on.onClose).not.toHaveBeenCalled()
  })

  it('oneHere_TheSameName_ItsStateSelected_ItsRowIsMarked', () => {
    const s = sheet({ here: 'b', can: false })
    expect(s.toggle()!.textContent).toBe('reader.chrome.bookmark')
    expect(s.toggle()!.getAttribute('aria-selected')).toBe('true')
    expect(s.rows().map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  it('nothingToBookmarkAndNoneHere_NoButton_TheListStays', () => {
    const s = sheet({ can: false })
    expect(s.toggle()).toBeNull()
    expect(s.rows()).toHaveLength(2)
  })

  it('rows_InTheOrderGiven_BookTextAsText_ATapGoesThereAndCloses', () => {
    const s = sheet()
    expect(s.rows().map((r) => r.textContent)).toEqual(['First words', '<b>Later</b> words'])
    expect(s.div.querySelector('b')).toBeNull()
    act(() => s.rows()[1].click())
    expect(s.on.onGo.mock.calls).toEqual([[B]])
    expect(s.on.onClose).toHaveBeenCalledTimes(1)
  })

  it('empty_SaysHowToAddOne_TheButtonAdds', () => {
    const s = sheet({ items: [] })
    expect(s.div.textContent).toContain('reader.chrome.bookmarksEmpty')
    expect(s.toggle()!.textContent).toBe('reader.chrome.bookmark')
  })

  it('empty_NothingCanBeBookmarkedHere_SaysThat_NoButton', () => {
    const s = sheet({ items: [], can: false })
    expect(s.div.textContent).toContain('reader.chrome.bookmarksNotHere')
    expect(s.div.textContent).not.toContain('reader.chrome.bookmarksEmpty')
    expect(s.toggle()).toBeNull()
  })

  it('row_ItsRemoveButton_NamedByTheBookmarksWords_RemovesThatOne_TheSheetStaysOpen', () => {
    // Neither is the one here (further down the screen, elsewhere in the book): each is removed by its own row.
    const s = sheet()
    expect(s.removes().map((b) => b.getAttribute('aria-label'))).toEqual(['reader.chrome.removeBookmark: First words', 'reader.chrome.removeBookmark: <b>Later</b> words'])
    act(() => s.removes()[1].click())
    expect(s.on.onRemove.mock.calls).toEqual([['b']])
    expect(s.on.onGo).not.toHaveBeenCalled()
    expect(s.on.onClose).not.toHaveBeenCalled()
  })

  it('empty_StillBeingPlaced_SaysLoading_NeverThatThisPageTakesNone', () => {
    const s = sheet({ items: [], can: false, placing: true })
    expect(s.div.textContent).toContain('reader.chrome.bookmarksLoading')
    expect(s.div.textContent).not.toContain('reader.chrome.bookmarksNotHere')
  })

  it('notVisible_Nothing', () => {
    expect(sheet({ visible: false }).div.textContent).toBe('')
  })
})
