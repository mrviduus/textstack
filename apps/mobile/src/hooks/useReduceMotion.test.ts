// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderHook } from '../test/renderHook'
import { useReduceMotion } from './useReduceMotion'

const rn = vi.hoisted(() => ({ listener: null as ((r: boolean) => void) | null, removed: false }))
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(true),
    addEventListener: (_: string, fn: (r: boolean) => void) => {
      rn.listener = fn
      return { remove: () => { rn.removed = true } }
    },
  },
}))

describe('useReduceMotion (#1267)', () => {
  it('systemSettingOn_True_ThenFollowsItsChanges', async () => {
    const h = renderHook(() => useReduceMotion(), {})
    expect(h.result.current).toBe(false)
    await act(async () => {})
    expect(h.result.current).toBe(true)
    act(() => rn.listener?.(false))
    expect(h.result.current).toBe(false)
    h.unmount()
    expect(rn.removed).toBe(true)
  })
})
