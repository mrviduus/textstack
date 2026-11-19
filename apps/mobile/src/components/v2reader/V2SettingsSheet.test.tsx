// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../../../packages/reader/src/settings.mjs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('react-native', () => {
  type Props = { children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; accessibilityState?: { selected?: boolean; disabled?: boolean }; onPress?: () => void; disabled?: boolean }
  const view = ({ children, accessibilityLabel, accessibilityRole, accessibilityState, onPress, disabled }: Props) =>
    createElement(accessibilityRole === 'button' ? 'button' : 'div', { 'aria-label': accessibilityLabel,
      'aria-pressed': accessibilityState?.selected, disabled, onClick: onPress }, children)
  return { View: view, Text: view, ScrollView: view, Pressable: view, TouchableOpacity: view, Switch: () => null,
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => visible ? children : null,
    StyleSheet: { create: (s: unknown) => s, absoluteFill: {} } }
})
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('../../theme/typography', () => ({ fonts: {} }))
vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ colors: {} }) }))
vi.mock('../../context/LanguageContext', () => ({ useLanguage: () => ({ t: (k: string) => k }) }))
vi.mock('../../hooks/useReduceMotion', () => ({ useReduceMotion: () => false }))
const { V2SettingsSheet } = await import('./V2SettingsSheet')

let unmount: (() => void) | undefined
afterEach(() => { unmount?.(); unmount = undefined })

function show(flow: 'paginated' | 'scrolled' | null, typography = true) {
  const div = document.createElement('div')
  const root = createRoot(div)
  const onFlowChange = vi.fn()
  const render = (value: typeof flow) => act(() => root.render(createElement(V2SettingsSheet, {
    visible: true, onClose: vi.fn(), settings: DEFAULTS, onUpdate: vi.fn(), typography,
    flow: value, onFlowChange, ttsSpeed: 1, onTtsSpeed: vi.fn(),
  })))
  render(flow)
  unmount = () => act(() => root.unmount())
  const button = (mode: 'paginated' | 'scrolled') => Array.from(div.querySelectorAll<HTMLButtonElement>('button')).find((el) => el.textContent === `reader.v2.${mode}`)!
  return { button, onFlowChange, render }
}

describe('mobile reading mode menu', () => {
  it('offers scroll inside book settings and shows the updated selection', () => {
    const menu = show('paginated')
    act(() => menu.button('scrolled').click())
    expect(menu.onFlowChange).toHaveBeenCalledWith('scrolled')
    menu.render('scrolled')
    expect(menu.button('scrolled').getAttribute('aria-pressed')).toBe('true')
    act(() => menu.button('paginated').click())
    expect(menu.onFlowChange).toHaveBeenLastCalledWith('paginated')
  })

  it.each([[null, true], ['paginated', false]] as const)('disables mode changes while loading or fixed-layout (%s, %s)', (flow, typography) => {
    const menu = show(flow, typography)
    expect(menu.button('scrolled').disabled).toBe(true)
    act(() => menu.button('scrolled').click())
    expect(menu.onFlowChange).not.toHaveBeenCalled()
  })
})
