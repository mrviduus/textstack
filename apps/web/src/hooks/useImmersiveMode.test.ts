import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useImmersiveMode } from './useImmersiveMode'

function scrollTo(y: number) {
  act(() => {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true })
    window.dispatchEvent(new Event('scroll'))
  })
}
/** Scroll by `total` px in `step` px events (slow trackpad / finger). */
function scrollBy(total: number, step = 10) {
  const dir = Math.sign(total)
  for (let moved = 0; moved < Math.abs(total); moved += step) scrollTo(window.scrollY + dir * step)
}

function loaded() {
  const hook = renderHook(() => useImmersiveMode(true, false))
  act(() => { vi.advanceTimersByTime(3000) })
  return hook
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true })
})
afterEach(() => vi.useRealTimers())

describe('useImmersiveMode', () => {
  it('hides bars 3s after load', () => {
    const { result } = renderHook(() => useImmersiveMode(true, false))
    expect(result.current.immersiveMode).toBe(false)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(result.current.immersiveMode).toBe(true)
  })

  it('scroll up 6px reveals', () => {
    const { result } = loaded()
    scrollBy(-6, 6)
    expect(result.current.immersiveMode).toBe(false)
  })

  it('slow scroll down after a reveal hides at 48px', () => {
    const { result } = loaded()
    scrollBy(-20)
    expect(result.current.immersiveMode).toBe(false)
    scrollBy(40)
    expect(result.current.immersiveMode).toBe(false)
    scrollBy(10)
    expect(result.current.immersiveMode).toBe(true)
  })

  it('20px down wobble while visible does not hide', () => {
    const { result } = loaded()
    scrollBy(-10)
    scrollBy(20)
    expect(result.current.immersiveMode).toBe(false)
  })

  it('tap showBars keeps bars visible past 3s', () => {
    const { result } = loaded()
    act(() => result.current.showBars())
    act(() => { vi.advanceTimersByTime(5000) })
    expect(result.current.immersiveMode).toBe(false)
    scrollBy(50)
    expect(result.current.immersiveMode).toBe(true)
  })
})
