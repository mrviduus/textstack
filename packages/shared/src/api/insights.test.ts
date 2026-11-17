import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initApi } from './client'
import { getBookInsights } from './insights'

describe('getBookInsights', () => {
  beforeEach(() => {
    // Cookie mode, as web runs it.
    initApi({ baseUrl: 'http://api', getAccessToken: async () => null, onUnauthorized: async () => null, credentials: 'include' })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a reader sees the insights saved about their book', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => JSON.stringify([{
        id: 'i1', bookId: 'b1', chapterKey: 'replication', chapterNumber: 5, chapterTitle: 'Replication',
        text: 'Quorums are about overlap.', question: 'why w + r > n?', source: 'mcp',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
      }]),
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await getBookInsights('b1')

    expect(String(fetchMock.mock.calls[0][0])).toContain('/me/v2/books/b1/insights')
    expect(rows).toEqual([{
      id: 'i1', editionId: null, userBookId: 'b1',
      chapterSlug: 'replication', chapterNumber: 5, chapterTitle: 'Replication',
      text: 'Quorums are about overlap.', question: 'why w + r > n?', source: 'mcp',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    }])
  })
})
