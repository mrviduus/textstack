import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

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
