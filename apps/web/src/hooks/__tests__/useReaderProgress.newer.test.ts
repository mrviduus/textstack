import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const getProgress = vi.fn()
vi.mock('../../api/auth', () => ({ getProgress: (...a: unknown[]) => getProgress(...a), upsertProgress: vi.fn() }))
vi.mock('../../api/userBooks', () => ({ getUserBookProgress: vi.fn(async () => null), saveUserBookProgress: vi.fn() }))
const auth = { isAuthenticated: true, isLoading: false }
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth }))

import { useReaderProgress } from '../useReaderProgress'

// R4-4: the tab-return check moves the reader only on proof — the server row's CLIENT stamp
// later than this device's record (shared serverProvablyNewer, skew clamped).
const T = Date.parse('2026-10-05T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

function mount() {
  return renderHook(() => useReaderProgress({
    mode: 'public', bookSlug: 'b', chapterSlug: 'ch1', userBookId: undefined,
    publicBook: { id: 'e1', chapters: [] } as never, publicChapter: null, book: null,
  }))
}

beforeEach(() => {
  localStorage.clear()
  getProgress.mockReset()
  auth.isAuthenticated = true
  auth.isLoading = false
  localStorage.setItem('reading.progress.e1', JSON.stringify({ chapterSlug: 'ch1', locator: 'scroll:ch1:100', updatedAt: T, synced: true }))
})

describe('useReaderProgress.fetchNewerPosition', () => {
  it('another device wrote later → that position', async () => {
    getProgress.mockResolvedValue({ chapterSlug: 'ch1', locator: 'scroll:ch1:900', positionJson: null, clientUpdatedAt: iso(T + 60_000) })
    const { result } = mount()
    expect(await result.current.fetchNewerPosition(3000)).toEqual({ chapterSlug: 'ch1', locator: 'scroll:ch1:900', positionJson: null })
    expect(getProgress.mock.calls[getProgress.mock.calls.length - 1][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('this device\'s own write echoed back, or no client stamp → false', async () => {
    getProgress.mockResolvedValue({ chapterSlug: 'ch1', locator: 'scroll:ch1:100', clientUpdatedAt: iso(T) })
    const { result } = mount()
    expect(await result.current.fetchNewerPosition(3000)).toBe(false)
    getProgress.mockResolvedValue({ chapterSlug: 'ch1', locator: 'scroll:ch1:900', clientUpdatedAt: null })
    expect(await result.current.fetchNewerPosition(3000)).toBe(false)
  })

  it('timed out → null (unknown, ask again); signed out → false (nothing to ask)', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort())
    getProgress.mockResolvedValue(null)
    const { result, rerender } = mount()
    expect(await result.current.fetchNewerPosition(3000)).toBeNull()
    vi.restoreAllMocks()
    auth.isAuthenticated = false
    rerender()
    expect(await result.current.fetchNewerPosition(3000)).toBe(false)
  })
})
