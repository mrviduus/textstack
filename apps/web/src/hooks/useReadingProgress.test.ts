import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }))
vi.mock('../api/auth', () => ({ upsertProgress: vi.fn() }))

import { useReadingProgress } from './useReadingProgress'
import * as auth from '../api/auth'

const ED = '11111111-1111-4111-8111-111111111111'
const KEY = `reading.progress.${ED}`

describe('useReadingProgress keepalive flush', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(auth.upsertProgress).mockReset().mockResolvedValue(undefined as never)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a failed final flush is not an ACK: the same position is sent again, not deduped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const { result } = renderHook(() => useReadingProgress('book', 'ch', { editionId: ED, chapterId: 'c1' }))

    act(() => result.current.updateProgress(0.4, undefined, 'scroll:9'))
    act(() => result.current.flushSave())
    await act(() => vi.advanceTimersByTimeAsync(0)) // settle the failed fetch

    act(() => result.current.updateProgress(0.4, undefined, 'scroll:9'))
    expect(JSON.parse(localStorage.getItem(KEY)!).synced).toBeUndefined()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(auth.upsertProgress).toHaveBeenCalledTimes(1)
  })

  it('an ok flush is an ACK: the local entry is marked synced', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }))
    const { result } = renderHook(() => useReadingProgress('book', 'ch', { editionId: ED, chapterId: 'c1' }))

    act(() => result.current.updateProgress(0.4, undefined, 'scroll:9'))
    act(() => result.current.flushSave())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(JSON.parse(localStorage.getItem(KEY)!).synced).toBe(true)
  })
})
