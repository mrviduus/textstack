import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// H3: a chapter loaded from an old offline-cache row may only know the cache key
// "editionId:slug". The server takes a GUID; that POST was a 500 and the local
// row was then wiped by the server list. It must never be sent.

vi.mock('../../api/userData', () => ({
  getPublicBookmarks: vi.fn(async () => []),
  createPublicBookmark: vi.fn(),
  deletePublicBookmark: vi.fn(),
}))
vi.mock('../../lib/dataEvents', () => ({ emitDataChange: vi.fn() }))

import { useBookmarks } from '../useBookmarks'
import { createPublicBookmark } from '../../api/userData'

const ED = 'eeeeeeee-0000-0000-0000-000000000000'

describe('useBookmarks — chapter id guard', () => {
  it('never POSTs (or keeps) a bookmark whose chapter id is not a server id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = renderHook(() => useBookmarks('book', { editionId: ED, isAuthenticated: true }))
    await waitFor(() => expect(h.result.current.loading).toBe(false))
    await act(async () => { await h.result.current.addBookmark('one', 'One', `${ED}:one`) })
    expect(createPublicBookmark).not.toHaveBeenCalled()
    expect(h.result.current.bookmarks).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
  })
})
