import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

const useAuthMock = vi.fn()
const getLibraryShelvesMock = vi.fn()

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}))

vi.mock('@textstack/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@textstack/shared')>()),
  libraryApi: { getLibraryShelves: () => getLibraryShelvesMock() },
}))

import { useLibraryShelves, clearLibraryShelvesCache } from '../useLibraryShelves'

const emptyShelves = () => ({
  continueReading: [],
  recentlyAdded: [],
  quickReads: [],
  finishedThisMonth: [],
})

describe('useLibraryShelves', () => {
  beforeEach(() => {
    useAuthMock.mockReset()
    getLibraryShelvesMock.mockReset()
    clearLibraryShelvesCache()
  })
  afterEach(() => cleanup())

  it('returns null shelves when unauthenticated', async () => {
    useAuthMock.mockReturnValue({ isAuthenticated: false })
    const { result } = renderHook(() => useLibraryShelves())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.shelves).toBeNull()
    expect(getLibraryShelvesMock).not.toHaveBeenCalled()
  })

  it('fetches shelves when authenticated', async () => {
    useAuthMock.mockReturnValue({ isAuthenticated: true })
    const data = emptyShelves()
    getLibraryShelvesMock.mockResolvedValue(data)
    const { result } = renderHook(() => useLibraryShelves())
    await waitFor(() => expect(result.current.shelves).toEqual(data))
    expect(getLibraryShelvesMock).toHaveBeenCalledTimes(1)
  })

  it('reuses cached shelves on second mount within TTL', async () => {
    useAuthMock.mockReturnValue({ isAuthenticated: true })
    getLibraryShelvesMock.mockResolvedValue(emptyShelves())
    const first = renderHook(() => useLibraryShelves())
    await waitFor(() => expect(first.result.current.shelves).not.toBeNull())
    expect(getLibraryShelvesMock).toHaveBeenCalledTimes(1)
    cleanup()

    const second = renderHook(() => useLibraryShelves())
    expect(second.result.current.shelves).not.toBeNull()
    await waitFor(() => expect(second.result.current.loading).toBe(false))
    expect(getLibraryShelvesMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces error message on failure', async () => {
    useAuthMock.mockReturnValue({ isAuthenticated: true })
    getLibraryShelvesMock.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useLibraryShelves())
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.shelves).toBeNull()
  })
})
