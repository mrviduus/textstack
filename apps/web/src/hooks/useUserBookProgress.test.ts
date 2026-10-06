import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('../api/userBooks', () => ({
  readUserBookProgress: vi.fn(),
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
    vi.mocked(userBooks.readUserBookProgress).mockResolvedValue(server)
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
    vi.mocked(userBooks.readUserBookProgress).mockResolvedValue(null as never)
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
    vi.mocked(userBooks.readUserBookProgress).mockResolvedValue(null as never)
    const { result, rerender } = renderHook(() => useUserBookProgress('b1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const first = result.current
    rerender()
    rerender()
    expect(result.current).toBe(first)
  })
})

describe('useUserBookProgress — the GET is bounded, failures are not answers (R4-2, review #3)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('a hanging GET: after 3 s the local record is the restore, and it is flagged unanswered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    localStorage.clear()
    localStorage.setItem(KEY, JSON.stringify({ chapterSlug: 'ch-2', locator: 'scroll:ch-2:400', percent: 0.2, updatedAt: 1000, synced: true }))
    // The real wrapper resolves undefined when its signal aborts.
    vi.mocked(userBooks.readUserBookProgress).mockImplementation((_id: string, signal?: AbortSignal) =>
      new Promise((resolve) => signal?.addEventListener('abort', () => resolve(undefined))))
    const { result } = renderHook(() => useUserBookProgress('b1'))
    expect(result.current.isLoading).toBe(true)
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.serverUnanswered).toBe(true)
    expect(result.current.savedProgress?.chapterSlug).toBe('ch-2')
  })

  it('a fast failure (offline, 5xx, 401) is unanswered too — not "nothing newer"', async () => {
    localStorage.clear()
    vi.mocked(userBooks.readUserBookProgress).mockResolvedValue(undefined)
    const { result } = renderHook(() => useUserBookProgress('b1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.serverUnanswered).toBe(true)
  })

  it('an answer with no row is an answer', async () => {
    localStorage.clear()
    vi.mocked(userBooks.readUserBookProgress).mockResolvedValue(null)
    const { result } = renderHook(() => useUserBookProgress('b1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.serverUnanswered).toBe(false)
  })

  it('exposes the server row, so a PDF resumes from the same GET (R4-5)', async () => {
    localStorage.clear()
    const row = { chapterSlug: null, locator: 'page:42', percent: 0.3, updatedAt: null, clientUpdatedAt: '2026-10-05T10:00:00Z' }
    vi.mocked(userBooks.readUserBookProgress).mockResolvedValue(row)
    const { result } = renderHook(() => useUserBookProgress('b1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.serverRow).toEqual(row)
    expect(result.current.serverUnanswered).toBe(false)
  })
})
