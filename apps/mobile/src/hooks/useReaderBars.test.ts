// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderHook } from '../test/renderHook'
import { useReaderBars } from './useReaderBars'

vi.mock('react-native', () => {
  class Value {
    constructor(public v: number) {}
    interpolate() { return this }
  }
  return {
    Animated: { Value, timing: () => ({ start: () => {} }) },
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(false),
      addEventListener: () => ({ remove: () => {} }),
    },
  }
})

const props = { topBarHeight: 56, footerHeight: 60, autoHideTrigger: 1 as boolean | number }

describe('useReaderBars auto-hide (#1263)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shownAgainWithANewTrigger_AutoHidesAgain', () => {
    const h = renderHook(useReaderBars, props)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(h.result.current.barsVisible).toBe(false)
    // A reopen while already in the book: the host shows the bars and bumps the trigger.
    act(() => h.result.current.showBars())
    h.rerender({ autoHideTrigger: 2 })
    expect(h.result.current.barsVisible).toBe(true)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(h.result.current.barsVisible).toBe(false)
    h.unmount()
  })

  it('triggerOff_NoAutoHide', () => {
    const h = renderHook(useReaderBars, { ...props, autoHideTrigger: 0 })
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(h.result.current.barsVisible).toBe(true)
    h.unmount()
  })
})
