import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChapterEngineFailure } from './useChapterEngineFailure'

describe('useChapterEngineFailure (#849)', () => {
  it('fail on A, go to B, return to A: A is not failed, so its section mounts and opens again', () => {
    const { result, rerender } = renderHook(({ chapter }) => useChapterEngineFailure(chapter), { initialProps: { chapter: 'a' } })
    act(() => result.current.onEngineError('a'))
    expect(result.current.failed).toBe(true)
    rerender({ chapter: 'b' })
    expect(result.current.failed).toBe(false)
    rerender({ chapter: 'a' })
    expect(result.current.failed).toBe(false)
  })

  it('an open that lands on the failed chapter clears it', () => {
    const { result } = renderHook(() => useChapterEngineFailure('a'))
    act(() => result.current.onEngineError('a'))
    act(() => result.current.onEngineOpened('a'))
    expect(result.current.failed).toBe(false)
  })
})
