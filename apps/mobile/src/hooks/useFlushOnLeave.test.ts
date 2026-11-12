// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderHook } from '../test/renderHook'
import { useFlushOnLeave } from './useFlushOnLeave'

const appState = vi.hoisted(() => ({ listeners: new Set<(s: string) => void>() }))
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_: string, fn: (s: string) => void) => {
      appState.listeners.add(fn)
      return { remove: () => appState.listeners.delete(fn) }
    },
  },
}))
const goTo = (s: string) => act(() => { for (const fn of appState.listeners) fn(s) })

describe('useFlushOnLeave (V2 reader position, #1264)', () => {
  it('background_Flushes', () => {
    const flush = vi.fn()
    const h = renderHook(useFlushOnLeave, flush)
    goTo('active')
    expect(flush).not.toHaveBeenCalled()
    goTo('background')
    expect(flush).toHaveBeenCalledTimes(1)
    h.unmount()
  })

  it('unmount_Flushes', () => {
    const flush = vi.fn()
    const h = renderHook(useFlushOnLeave, flush)
    h.unmount()
    expect(flush).toHaveBeenCalledTimes(1)
    goTo('background') // the listener went with the screen
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
