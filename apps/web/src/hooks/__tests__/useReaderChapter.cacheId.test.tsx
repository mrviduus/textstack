import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

// H3: a chapter served from the IndexedDB cache must carry the REAL chapter id.
// It used to carry the cache key "editionId:slug", which a bookmark then POSTed
// as chapterId (500) and a highlight stored as its anchor's chapter.

const ED_ID = '22222222-2222-2222-2222-222222222222'
const ids: Record<string, string> = {
  one: '11111111-1111-1111-1111-111111111111',
  two: '33333333-3333-3333-3333-333333333333',
}
const book = {
  id: ED_ID, title: 'B', slug: 'b', language: 'en',
  chapters: Object.entries(ids).map(([slug, id], i) => ({ id, chapterNumber: i, slug, title: slug, wordCount: 10 })),
}
const getBook = vi.fn(async () => book)
const getChapter = vi.fn(async (_b: string, slug: string) => ({
  id: ids[slug], chapterNumber: 0, slug, title: slug, html: '<p>x</p>', wordCount: 10, prev: null, next: null,
}))

vi.mock('../useApi', () => ({ useApi: () => api }))
const recovery = { markFetchStart: () => {}, wasAbortedDueToWake: () => false }
const api = { getBook, getChapter }
vi.mock('../useNetworkRecovery', () => ({ useNetworkRecovery: () => recovery }))
vi.mock('../../lib/offlineDb', () => ({
  cacheChapter: vi.fn(async () => {}),
  // An old cache row: no chapterId stored.
  getCachedChapter: vi.fn(async (ed: string, slug: string) => slug === 'one' ? {
    key: `${ed}:one`, editionId: ed, chapterSlug: 'one', html: '<p>x</p>', title: 'one',
    wordCount: 10, prev: null, next: null, cachedAt: 0,
  } : null),
}))

import { useReaderChapter } from '../useReaderChapter'
import { cacheChapter } from '../../lib/offlineDb'

describe('useReaderChapter — cache path chapter id', () => {
  it('resolves the real chapter id for a cached chapter', async () => {
    const { result, rerender } = renderHook(
      (slug: string) => useReaderChapter({ mode: 'public', bookSlug: 'b', chapterSlug: slug, isAuthenticated: true }),
      { initialProps: 'two' },
    )
    // First load goes to the network (records the edition id), second is served from cache.
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('two'))
    rerender('one')
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('one'))
    expect(getChapter).toHaveBeenCalledTimes(1)
    expect(result.current.chapter?.id).toBe(ids.one)
    expect(result.current.publicChapter?.id).toBe(ids.one)
  })

  it('backfills the real id into an old cache row once the book list resolves it', async () => {
    const { result, rerender } = renderHook(
      (slug: string) => useReaderChapter({ mode: 'public', bookSlug: 'b', chapterSlug: slug, isAuthenticated: true }),
      { initialProps: 'two' },
    )
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('two'))
    vi.mocked(cacheChapter).mockClear()
    rerender('one')
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('one'))
    await waitFor(() => expect(cacheChapter).toHaveBeenCalledWith(ED_ID, expect.objectContaining({ id: ids.one, slug: 'one' })))
  })
})

describe('useReaderChapter — reload (Try again, #849)', () => {
  it('reload skips the cache once: the chapter comes from the network, without a loading screen', async () => {
    const { result, rerender } = renderHook(
      (slug: string) => useReaderChapter({ mode: 'public', bookSlug: 'b', chapterSlug: slug, isAuthenticated: true }),
      { initialProps: 'two' },
    )
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('two'))
    rerender('one')
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('one'))   // from the cache
    getChapter.mockClear()
    getChapter.mockImplementationOnce(async (_b: string, slug: string) => ({
      id: ids[slug], chapterNumber: 0, slug, title: slug, html: '<p>fresh</p>', wordCount: 10, prev: null, next: null,
    }))
    const loadId = result.current.loadId
    let landed: Promise<boolean> | undefined
    act(() => { landed = result.current.reload() })
    expect(result.current.loading).toBe(false)   // the reader stays on screen
    await waitFor(() => expect(result.current.chapter?.html).toBe('<p>fresh</p>'))
    expect(await landed).toBe(true)
    expect(getChapter).toHaveBeenCalledWith('b', 'one')
    expect(result.current.loadId).toBe(loadId + 1)   // a landed load, even with the same html
  })

  it('a reload that fails (offline) keeps the reader: no page error, the chapter on screen stays', async () => {
    const { result, rerender } = renderHook(
      (slug: string) => useReaderChapter({ mode: 'public', bookSlug: 'b', chapterSlug: slug, isAuthenticated: true }),
      { initialProps: 'two' },
    )
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('two'))
    rerender('one')
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('one'))
    const before = result.current.chapter
    const loadId = result.current.loadId
    getChapter.mockClear()
    getChapter.mockRejectedValueOnce(new Error('offline'))
    let landed: Promise<boolean> | undefined
    act(() => { landed = result.current.reload() })
    await waitFor(() => expect(getChapter).toHaveBeenCalled())
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(await landed).toBe(false)   // Try again says it is still failing
    expect(result.current.error).toBeNull()
    expect(result.current.chapter).toBe(before)
    expect(result.current.loadId).toBe(loadId)   // nothing landed: the in-reader error stays
    expect(result.current.loading).toBe(false)
  })

  it('a failed reload is one load: the next chapter reads the cache again, with its loading screen', async () => {
    const { result, rerender } = renderHook(
      (slug: string) => useReaderChapter({ mode: 'public', bookSlug: 'b', chapterSlug: slug, isAuthenticated: true }),
      { initialProps: 'two' },
    )
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('two'))
    getChapter.mockRejectedValueOnce(new Error('offline'))
    act(() => { void result.current.reload() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    getChapter.mockClear()
    rerender('one')
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('one'))
    expect(getChapter).not.toHaveBeenCalled()   // from the cache
  })
})
