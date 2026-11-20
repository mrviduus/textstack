// @vitest-environment jsdom
import { createElement, act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const translation = vi.hoisted(() => ({ run: vi.fn(), peek: vi.fn() }))
vi.mock('react-native', () => {
  const view = ({ children, onPress, accessibilityRole, accessibilityLabel, disabled, numberOfLines }: { children?: ReactNode; onPress?: () => void; accessibilityRole?: string; accessibilityLabel?: string; disabled?: boolean; numberOfLines?: number }) =>
    createElement(accessibilityRole === 'button' ? 'button' : 'div', { onClick: onPress, 'aria-label': accessibilityLabel, disabled, 'data-lines': numberOfLines }, children)
  return { View: view, Text: view, TouchableOpacity: view, ScrollView: ({ children, scrollEnabled }: { children?: ReactNode; scrollEnabled?: boolean }) => createElement('div', { 'data-scroll-enabled': scrollEnabled }, children),
    useWindowDimensions: () => ({ width: 420, height: 860 }), ActivityIndicator: () => createElement('span', null, 'loading'), StyleSheet: { create: (s: unknown) => s } }
})
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('../../theme/typography', () => ({ fonts: {} }))
vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ colors: {} }) }))
vi.mock('../../context/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock('../../hooks/useTargetLanguage', () => ({ useTargetLanguage: () => ({ fromLang: 'en', translationTarget: 'uk' }) }))
vi.mock('../../hooks/useNeedsNativeLanguage', () => ({ useNeedsNativeLanguage: () => false }))
vi.mock('../../lib/translateCache', () => ({ cachedTranslate: translation.run, peekTranslation: translation.peek }))
vi.mock('@textstack/shared', () => ({ MAX_VOCABULARY_TEXT: 200, savedTranslationOffer: () => null }))
const { SelectionActionBar } = await import('../SelectionActionBar')

let dispose: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  translation.run.mockReset().mockImplementation(async (text: string) => ({ translation: `translated: ${text}` }))
  translation.peek.mockReset().mockReturnValue(undefined)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers() })

function show(text: string) {
  const element = document.createElement('div')
  const root = createRoot(element)
  const save = vi.fn()
  const quote = vi.fn()
  const render = (selectedText: string) => act(() => root.render(createElement(SelectionActionBar, {
    selectedText, sentence: 'The surrounding sentence.', onTranslate: vi.fn(), onSaveWord: save, onSaveQuote: quote,
    tooLong: selectedText.length > 500,
  })))
  render(text)
  dispose = () => act(() => root.unmount())
  const button = (key: string) => element.querySelector<HTMLButtonElement>(`button[aria-label="reader.actionBar.${key}"]`)!
  return { element, render, button, save, quote }
}

describe('one card for any selection', () => {
  it('expands and scrolls the complete translation, then collapses again for a new selection', async () => {
    const text = 'A long translation. '.repeat(30)
    translation.run.mockResolvedValue({ translation: text })
    const card = show('take into account')
    await act(async () => { vi.advanceTimersByTime(200) })
    const translated = () => [...card.element.querySelectorAll('div')].find(x => x.textContent === text)!
    expect(translated().getAttribute('data-lines')).toBe('4')
    act(() => card.button('showFullTranslation').click())
    expect(translated().hasAttribute('data-lines')).toBe(false)
    expect(card.element.querySelector('[data-scroll-enabled="true"]')).not.toBeNull()
    act(() => card.button('collapseTranslation').click())
    expect(translated().getAttribute('data-lines')).toBe('4')
    act(() => card.button('showFullTranslation').click())
    card.render('account')
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(translated().getAttribute('data-lines')).toBe('4')
  })
  it('translates words and expressions in place, with the same vocabulary and quotation actions', async () => {
    const card = show('account')
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(card.element.textContent).toContain('translated: account')
    card.render('take into account')
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(card.element.textContent).toContain('translated: take into account')
    act(() => card.button('saveSelection').click())
    act(() => card.button('saveQuote').click())
    expect(card.save).toHaveBeenCalledOnce()
    expect(card.save).toHaveBeenCalledWith('translated: take into account')
    expect(card.quote).toHaveBeenCalledOnce()
  })

  it('settles selection changes and never replaces a phrase translation with an older response', async () => {
    const resolvers = new Map<string, (value: { translation: string }) => void>()
    translation.run.mockImplementation((text: string) => new Promise(resolve => { resolvers.set(text, resolve) }))
    const card = show('take')
    await act(async () => { vi.advanceTimersByTime(200) })
    card.render('take into')
    card.render('take into account')
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(translation.run.mock.calls.map(x => x[0])).toEqual(['take', 'take into account'])
    await act(async () => resolvers.get('take into account')!({ translation: 'phrase result' }))
    await act(async () => resolvers.get('take')!({ translation: 'stale word result' }))
    expect(card.element.textContent).toContain('phrase result')
    expect(card.element.textContent).not.toContain('stale word result')
  })

  it('shows the real vocabulary limit without truncating the text or blocking quotation saving', () => {
    const text = 'long expression '.repeat(20)
    const card = show(text)
    expect(card.button('saveTooLong').disabled).toBe(true)
    act(() => card.button('saveTooLong').click())
    expect(card.save).not.toHaveBeenCalled()
    expect(card.button('saveQuote').disabled).toBe(false)
    expect(card.element.textContent).toContain(text)
  })

  it('retries a failed translation in the same card', async () => {
    translation.run.mockRejectedValueOnce(new Error('offline'))
    const card = show('take into account')
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(card.element.textContent).toContain('reader.actionBar.translateFailed')
    act(() => card.button('retryTranslation').click())
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(card.element.textContent).toContain('translated: take into account')
    expect(translation.run).toHaveBeenCalledTimes(2)
  })
})
