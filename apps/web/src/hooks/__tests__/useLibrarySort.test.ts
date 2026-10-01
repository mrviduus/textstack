import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLibrarySort } from '../useLibrarySort'

describe('useLibrarySort', () => {
  beforeEach(() => { localStorage.clear() })

  it('defaults to "recent" when nothing stored', () => {
    const { result } = renderHook(() => useLibrarySort('saved'))
    expect(result.current.sort).toBe('recent')
  })

  it('persists per-tab and restores on remount', () => {
    const { result, rerender } = renderHook(({ tab }: { tab: 'saved' | 'uploads' }) => useLibrarySort(tab), {
      initialProps: { tab: 'saved' as 'saved' | 'uploads' },
    })
    act(() => result.current.setSort('title'))
    rerender({ tab: 'uploads' })
    expect(result.current.sort).toBe('recent') // uploads tab — separate
    act(() => result.current.setSort('progress'))
    rerender({ tab: 'saved' })
    expect(result.current.sort).toBe('title') // saved tab kept its choice
  })

  it('ignores invalid stored values', () => {
    localStorage.setItem('textstack_library_sort_saved', 'garbage')
    const { result } = renderHook(() => useLibrarySort('saved'))
    expect(result.current.sort).toBe('recent')
  })
})
