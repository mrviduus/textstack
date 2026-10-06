import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const readProgress = vi.fn()
vi.mock('../../api/auth', () => ({ readProgress: (...a: unknown[]) => readProgress(...a), upsertProgress: vi.fn() }))
vi.mock('../../api/userBooks', () => ({ readUserBookProgress: vi.fn(async () => null), saveUserBookProgress: vi.fn() }))
const auth = { isAuthenticated: true, isLoading: false }
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth }))

import { useReaderProgress } from '../useReaderProgress'

// R4-4: the tab-return check moves the reader only on proof — the server row's CLIENT stamp
// later than this device's record (shared serverProvablyNewer, skew clamped).
const sig = () => new AbortController().signal
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
  readProgress.mockReset()
  auth.isAuthenticated = true
  auth.isLoading = false
  localStorage.setItem('reading.progress.e1', JSON.stringify({ chapterSlug: 'ch1', locator: 'scroll:ch1:100', updatedAt: T, synced: true }))
})

describe('useReaderProgress.fetchNewerPosition', () => {
  it('another device wrote later → that position', async () => {
    readProgress.mockResolvedValue({ chapterSlug: 'ch1', locator: 'scroll:ch1:900', positionJson: null, clientUpdatedAt: iso(T + 60_000) })
    const { result } = mount()
    expect(await result.current.fetchNewerPosition(sig())).toEqual({ chapterSlug: 'ch1', locator: 'scroll:ch1:900', positionJson: null })
    expect(readProgress.mock.calls[readProgress.mock.calls.length - 1][1]).toBeInstanceOf(AbortSignal)
  })

  it('this device\'s own write echoed back, or no client stamp → false', async () => {
    readProgress.mockResolvedValue({ chapterSlug: 'ch1', locator: 'scroll:ch1:100', clientUpdatedAt: iso(T) })
    const { result } = mount()
    expect(await result.current.fetchNewerPosition(sig())).toBe(false)
    readProgress.mockResolvedValue({ chapterSlug: 'ch1', locator: 'scroll:ch1:900', clientUpdatedAt: null })
    expect(await result.current.fetchNewerPosition(sig())).toBe(false)
  })

  it('no answer (timeout, offline, 5xx — the wrapper says undefined) → null; signed out → false', async () => {
    readProgress.mockResolvedValue(undefined)
    const { result, rerender } = mount()
    expect(await result.current.fetchNewerPosition(sig())).toBeNull()
    auth.isAuthenticated = false
    rerender()
    expect(await result.current.fetchNewerPosition(sig())).toBe(false)
  })

  it('answered with no row → false (settled, nothing newer)', async () => {
    readProgress.mockResolvedValue(null)
    const { result } = mount()
    expect(await result.current.fetchNewerPosition(sig())).toBe(false)
  })
})
