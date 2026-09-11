import { describe, it, expect, vi, afterEach } from 'vitest'
import { getBookInsights } from '../insights'

/**
 * The shape on the wire, pinned.
 *
 * <p>`BookInsightsSection` mocks this module wholesale, so its own tests pass against any shape at
 * all — which is how a client that unwrapped a `.items` the server never sends reached `main`. The
 * component then stored `undefined` and threw on `.length` at the next render, on every signed-in
 * book page. This test talks to the client, not the component, and asserts against what
 * `InsightsEndpoints` actually returns: a bare array.</p>
 */
describe('getBookInsights', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const row = {
    id: 'i1', editionId: null, userBookId: 'b1',
    chapterSlug: 'replication', chapterNumber: 5, chapterTitle: 'Replication',
    text: 'Quorums are about overlap.', question: 'why w + r > n?', source: 'mcp',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  }

  it('returns the array the server sends, not an envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => JSON.stringify([row]),
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await getBookInsights({ userBookId: 'b1' })

    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0].chapterTitle).toBe('Replication')
  })

  it('returns an empty array when the reader has no insights yet', async () => {
    // The common case by far — 0 insights exist in production — and the one where a wrong unwrap
    // still looks like "nothing to show" instead of a crash. It must be an array, not undefined.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => '[]',
    }))

    await expect(getBookInsights({ editionId: 'e1' })).resolves.toEqual([])
  })

  it('sends the id as the query the endpoint switches on, with cookies', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => '[]',
    })
    vi.stubGlobal('fetch', fetchMock)

    await getBookInsights({ editionId: 'e-1' })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/me/insights?editionId=e-1')
    expect(opts.credentials).toBe('include')
  })
})
