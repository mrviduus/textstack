import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('../api/userBooks', () => ({
  getUserBookProgress: vi.fn(),
  saveUserBookProgress: vi.fn(),
}))

import { useUserBookProgress } from './useUserBookProgress'
import * as userBooks from '../api/userBooks'

const KEY = 'userbook.progress.b1'
// Server clock far AHEAD of the local one: a timestamp compare would always pick it.
const server = { chapterSlug: 'ch-9', locator: 'scroll:1', percent: 0.9, updatedAt: '2099-01-01T00:00:00Z' }

describe('useUserBookProgress restore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(userBooks.getUserBookProgress).mockResolvedValue(server)
  })

  it('keeps an unsynced local write even when the server clock says newer', async () => {
    localStorage.setItem(KEY, JSON.stringify({ chapterSlug: 'ch-2', percent: 0.2, updatedAt: 1000 }))
    const { result } = renderHook(() => useUserBookProgress('b1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.savedProgress?.chapterSlug).toBe('ch-2')
  })

  it('takes the server once the local write was acknowledged', async () => {
    localStorage.setItem(KEY, JSON.stringify({ chapterSlug: 'ch-2', percent: 0.2, updatedAt: Date.parse('2100-01-01'), synced: true }))
    const { result } = renderHook(() => useUserBookProgress('b1'))
    await waitFor(() => expect(result.current.savedProgress?.chapterSlug).toBe('ch-9'))
  })
})

describe('useUserBookProgress keepalive flush', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(userBooks.getUserBookProgress).mockResolvedValue(null as never)
    vi.mocked(userBooks.saveUserBookProgress).mockReset().mockResolvedValue(undefined as never)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a failed final flush is not an ACK: the same position is sent again, not deduped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const { result } = renderHook(() => useUserBookProgress('b1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    vi.useFakeTimers()

    act(() => result.current.saveProgress('ch-3', 0, 0.3, 'scroll:5'))
    act(() => result.current.flushSave())
    await act(() => vi.advanceTimersByTimeAsync(0)) // settle the failed fetch

    act(() => result.current.saveProgress('ch-3', 0, 0.3, 'scroll:5'))
    expect(JSON.parse(localStorage.getItem(KEY)!).synced).toBeUndefined()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(userBooks.saveUserBookProgress).toHaveBeenCalledTimes(1)
  })
})

describe('useUserBookProgress identity (M4)', () => {
  it('returns the same object across re-renders when nothing changed', async () => {
    localStorage.clear()
    vi.mocked(userBooks.getUserBookProgress).mockResolvedValue(null as never)
    const { result, rerender } = renderHook(() => useUserBookProgress('b1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const first = result.current
    rerender()
    rerender()
    expect(result.current).toBe(first)
  })
})
