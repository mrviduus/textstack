import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useReaderSettings } from '../useReaderSettings'

describe('reader typography preferences', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => { cleanup(); localStorage.clear() })

  it('starts new readers at 20px with 1.6 spacing', () => {
    const { result } = renderHook(() => useReaderSettings())
    expect(result.current.settings).toMatchObject({ fontSize: 20, lineHeight: 1.6, fontFamily: 'serif' })
  })

  it('preserves existing size, spacing and accessibility font', () => {
    localStorage.setItem('reader.settings.v1', JSON.stringify({ fontSize: 24, lineHeight: 1.65, fontFamily: 'dyslexic' }))
    const { result } = renderHook(() => useReaderSettings())
    expect(result.current.settings).toMatchObject({ fontSize: 24, lineHeight: 1.65, fontFamily: 'dyslexic' })
  })

  it('keeps changed preferences after remount', () => {
    const first = renderHook(() => useReaderSettings())
    act(() => first.result.current.update({ fontSize: 22, lineHeight: 1.8, fontFamily: 'sans' }))
    first.unmount()
    const { result } = renderHook(() => useReaderSettings())
    expect(result.current.settings).toMatchObject({ fontSize: 22, lineHeight: 1.8, fontFamily: 'sans' })
  })
})
