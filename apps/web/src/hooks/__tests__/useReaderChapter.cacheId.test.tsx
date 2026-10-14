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
const recovery = { markFetchStart: () => {}, wasAbortedDueToWake: vi.fn(() => false) }
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

describe('useReaderChapter — retryChapter (Try again, #849)', () => {
  const fresh = (slug: string) => ({ id: ids[slug], chapterNumber: 0, slug, title: slug, html: '<p>fresh</p>', wordCount: 10, prev: null, next: null })
  /** 'two' from the network, then 'one' from the cache: the reader is on a cached chapter. */
  async function onCachedChapter() {
    const hook = renderHook(
      (slug: string) => useReaderChapter({ mode: 'public', bookSlug: 'b', chapterSlug: slug, isAuthenticated: true }),
      { initialProps: 'two' },
    )
    await waitFor(() => expect(hook.result.current.chapter?.identifier).toBe('two'))
    hook.rerender('one')
    await waitFor(() => expect(hook.result.current.chapter?.identifier).toBe('one'))
    getChapter.mockClear()
    vi.mocked(cacheChapter).mockClear()
    return hook
  }

  it('fetches the chapter from the network first, then shows it and caches it; no loading screen', async () => {
    const { result } = await onCachedChapter()
    getChapter.mockResolvedValueOnce(fresh('one'))
    let landed!: Promise<boolean>
    act(() => { landed = result.current.retryChapter() })
    expect(result.current.loading).toBe(false)
    expect(await act(() => landed)).toBe(true)
    expect(getChapter).toHaveBeenCalledWith('b', 'one')
    expect(result.current.chapter?.html).toBe('<p>fresh</p>')
    expect(cacheChapter).toHaveBeenCalledWith(ED_ID, expect.objectContaining({ html: '<p>fresh</p>' }))
  })

  it('offline: nothing changes, no page error, the cache stays; resolves false', async () => {
    const { result } = await onCachedChapter()
    const before = result.current.chapter
    getChapter.mockRejectedValueOnce(new Error('offline'))
    let landed!: Promise<boolean>
    act(() => { landed = result.current.retryChapter() })
    expect(await act(() => landed)).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.chapter).toBe(before)
    expect(cacheChapter).not.toHaveBeenCalled()
  })

  it('the reader goes to another chapter during the retry: the retry is dropped, nothing leaks into it', async () => {
    const { result, rerender } = await onCachedChapter()
    let answer!: (c: unknown) => void
    getChapter.mockImplementationOnce(() => new Promise((r) => { answer = r }) as never)
    let landed!: Promise<boolean>
    act(() => { landed = result.current.retryChapter() })
    rerender('two')
    await waitFor(() => expect(result.current.chapter?.identifier).toBe('two'))
    answer(fresh('one'))
    expect(await act(() => landed)).toBe(false)
    expect(result.current.chapter?.identifier).toBe('two')
    expect(cacheChapter).not.toHaveBeenCalledWith(ED_ID, expect.objectContaining({ html: '<p>fresh</p>' }))
  })

  it('a wake from sleep aborts the fetch: that is no answer, the retry asks again', async () => {
    const { result } = await onCachedChapter()
    getChapter.mockRejectedValueOnce(new DOMException('aborted', 'AbortError')).mockResolvedValueOnce(fresh('one'))
    recovery.wasAbortedDueToWake.mockReturnValueOnce(true)
    let landed!: Promise<boolean>
    act(() => { landed = result.current.retryChapter() })
    expect(await act(() => landed)).toBe(true)
    expect(result.current.chapter?.html).toBe('<p>fresh</p>')
  })
})
