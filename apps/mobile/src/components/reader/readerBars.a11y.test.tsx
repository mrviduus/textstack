// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

// #1267 review: the bars go out of TalkBack's reach while the V2 reader's image lightbox covers the screen. No React
// Native renderer here: react-native's views are stubbed as divs carrying the two accessibility props as attributes.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('react-native', () => {
  const view = ({ children, importantForAccessibility, accessibilityElementsHidden, accessibilityLabel }: {
    children?: ReactNode; importantForAccessibility?: string; accessibilityElementsHidden?: boolean; accessibilityLabel?: string
  }) => createElement('div', { 'data-ifa': importantForAccessibility, 'data-hidden': accessibilityElementsHidden ? 'true' : undefined, 'aria-label': accessibilityLabel }, children)
  return {
    Animated: { View: view },
    View: view,
    Text: view,
    TouchableOpacity: view,
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  }
})
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('../../theme/typography', () => ({ fonts: {} }))
vi.mock('../../context/LanguageContext', () => ({ useLanguage: () => ({ t: (k: string) => k }) }))

const { ReaderTopBar } = await import('./ReaderTopBar')
const { ReaderFooter } = await import('./ReaderFooter')

const bar = { barBg: '#fff', barText: '#000', barsAnim: {} as never, barsVisible: true }
const top = { ...bar, topBarTranslateY: {} as never, topInset: 0, bookTitle: 'Walden', chapterTitle: '', sessionWordCount: 0, isAuthenticated: true, hasChapters: true, isCurrentBookmarked: false, onExit: () => {}, onTocPress: () => {} }
const foot = { ...bar, trackColor: '#eee', footerTranslateY: {} as never, bottomInset: 0, bookProgress: 0.5, chapterTitle: '', currentChapterIndex: -1, totalChapters: 0, timeLeftLabel: null, hasPrev: true, hasNext: true, onPrev: () => {}, onNext: () => {}, onHeight: () => {} }

function rootOf(el: ReturnType<typeof createElement>) {
  const div = document.createElement('div')
  const root = createRoot(div)
  act(() => root.render(el))
  return { first: div.firstElementChild as HTMLElement, div, unmount: () => act(() => root.unmount()) }
}

describe('reader bars and the lightbox (#1267)', () => {
  it.each([
    ['ReaderTopBar', (h?: boolean) => createElement(ReaderTopBar, { ...top, hiddenFromAccessibility: h })],
    ['ReaderFooter', (h?: boolean) => createElement(ReaderFooter, { ...foot, hiddenFromAccessibility: h })],
  ])('%s_HiddenFromAccessibility_NoHideDescendantsOnItsRoot_OtherwiseAuto', (_, make) => {
    const shown = rootOf(make())
    expect([shown.first.dataset.ifa, shown.first.dataset.hidden]).toEqual(['auto', undefined])
    shown.unmount()
    const hidden = rootOf(make(true))
    expect([hidden.first.dataset.ifa, hidden.first.dataset.hidden]).toEqual(['no-hide-descendants', 'true'])
    hidden.unmount()
  })

  it('topBarAndFooter_LabelsDefaultThroughT', () => {
    const t = rootOf(createElement(ReaderTopBar, top))
    expect(Array.from(t.div.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label'))).toEqual(['reader.chrome.back', 'reader.chrome.contents'])
    t.unmount()
    const f = rootOf(createElement(ReaderFooter, foot))
    expect(Array.from(f.div.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label'))).toEqual(['reader.chapterEnd.prevUntitled', 'reader.chapterEnd.nextUntitled'])
    f.unmount()
  })
})
