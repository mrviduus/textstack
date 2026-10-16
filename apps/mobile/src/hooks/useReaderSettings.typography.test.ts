// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { renderHook } from '../test/renderHook'
import { useReaderSettings } from './useReaderSettings'

describe('mobile typography preferences', () => {
  it('uses new defaults, preserves stored choices and persists subsequent changes', async () => {
    await AsyncStorage.clear()
    const first = renderHook(() => useReaderSettings(), {})
    await act(async () => {})
    expect(first.result.current.settings).toMatchObject({ fontSize: 20, lineHeight: 1.6, fontFamily: 'serif' })
    expect(first.result.current.resolvedFontFamily).toContain('TextStack')
    first.unmount()

    await AsyncStorage.setItem('reader.settings.v2', JSON.stringify({ fontSize: 24, lineHeight: 1.65, fontFamily: 'dyslexic' }))
    const saved = renderHook(() => useReaderSettings(), {})
    await act(async () => {})
    expect(saved.result.current.settings).toMatchObject({ fontSize: 24, lineHeight: 1.65, fontFamily: 'dyslexic' })
    act(() => saved.result.current.update({ fontFamily: 'sans' }))
    expect(saved.result.current.resolvedFontFamily).toContain('Source Sans 3')
    saved.unmount()

    const remount = renderHook(() => useReaderSettings(), {})
    await act(async () => {})
    expect(remount.result.current.settings).toMatchObject({ fontSize: 24, lineHeight: 1.65, fontFamily: 'sans' })
    remount.unmount()
  })
})
