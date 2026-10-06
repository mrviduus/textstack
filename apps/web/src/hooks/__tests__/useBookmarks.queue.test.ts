import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { Bookmark } from '../../lib/bookmarkStore'

// Offline bookmark queue (lib/bookmarkSync) — catalog books and uploads.

// In-memory IndexedDB: each mutateBookmarks call is one atomic step, like the real transaction.
const db = new Map<string, Bookmark>()
const idb = { down: false }
vi.mock('../../lib/bookmarkStore', () => ({
  mutateBookmarks: async (bookId: string, fn: (rows: Bookmark[]) => { put?: Bookmark[]; del?: string[]; result: unknown }) => {
    await Promise.resolve()
    if (idb.down) throw new Error('IndexedDB unavailable')
    const out = fn([...db.values()].filter((b) => b.bookId === bookId).map((b) => ({ ...b })))
    for (const b of out.put ?? []) db.set(b.id, b)
    for (const id of out.del ?? []) db.delete(id)
    return out.result
  },
}))
vi.mock('../../api/userData', () => ({
  getPublicBookmarks: vi.fn(),
  createPublicBookmark: vi.fn(),
  deletePublicBookmark: vi.fn(),
}))
vi.mock('../../api/userBooks', () => ({
  getUserBookBookmarks: vi.fn(),
  createUserBookBookmark: vi.fn(),
  deleteUserBookBookmark: vi.fn(),
}))
vi.mock('../../lib/dataEvents', () => ({ emitDataChange: vi.fn() }))

import { useBookmarks } from '../useBookmarks'
import * as userData from '../../api/userData'
import * as userBooks from '../../api/userBooks'
import { ApiError } from '../../api/client'

const ED = 'eeeeeeee-0000-0000-0000-000000000000'
const CH1 = 'c1c1c1c1-0000-0000-0000-000000000001'
const CH2 = 'c2c2c2c2-0000-0000-0000-000000000002'
const S1 = '51515151-0000-0000-0000-000000000001'
const S2 = '52525252-0000-0000-0000-000000000002'
const UB = 'b0b0b0b0-0000-0000-0000-000000000000'
const offline = () => new ApiError(0, 'offline')

type Srv = { id: string; chapterId: string | null; chapterSlug?: string | null; locator: string; title: string | null; createdAt: string }
const srv = (id: string, slug: string, chapterId = CH1): Srv =>
  ({ id, editionId: ED, chapterId, locator: `chapter:${slug}`, title: slug, createdAt: '2026-10-01T00:00:00Z' }) as Srv

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const userA = { editionId: ED, isAuthenticated: true, userId: 'user-a' }
const ids = (h: { result: { current: { bookmarks: Bookmark[] } } }) => h.result.current.bookmarks.map((b) => b.id)
const slugs = (h: { result: { current: { bookmarks: Bookmark[] } } }) => h.result.current.bookmarks.map((b) => b.chapterSlug)

beforeEach(() => {
  vi.clearAllMocks()
  db.clear()
  idb.down = false
  vi.mocked(userData.getPublicBookmarks).mockResolvedValue([])
  vi.mocked(userBooks.getUserBookBookmarks).mockResolvedValue([])
})

async function mount(opts: Parameters<typeof useBookmarks>[1] = userA, bookId = 'book') {
  const h = renderHook((o: Parameters<typeof useBookmarks>[1]) => useBookmarks(bookId, o), { initialProps: opts })
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  return h
}

describe('useBookmarks — offline queue', () => {
  it('a bookmark added offline stays, and is POSTed when the server is back', async () => {
    vi.mocked(userData.getPublicBookmarks).mockRejectedValue(offline())
    const h = await mount()
    await act(async () => { await h.result.current.addBookmark('one', 'One', CH1) })
    expect(slugs(h)).toEqual(['one'])
    expect(userData.createPublicBookmark).not.toHaveBeenCalled()

    vi.mocked(userData.getPublicBookmarks).mockResolvedValue([])
    vi.mocked(userData.createPublicBookmark).mockResolvedValue(srv(S1, 'one') as never)
    act(() => { window.dispatchEvent(new Event('online')) })

    await waitFor(() => expect(ids(h)).toEqual([S1]))
    expect(userData.createPublicBookmark).toHaveBeenCalledWith({ editionId: ED, chapterId: CH1, locator: 'chapter:one', title: 'One' })
  })

  it('L4: a delete that cannot reach the server is not resurrected by the server list', async () => {
    vi.mocked(userData.getPublicBookmarks).mockResolvedValue([srv(S1, 'one') as never])
    vi.mocked(userData.deletePublicBookmark).mockRejectedValue(offline())
    const h = await mount()
    expect(ids(h)).toEqual([S1])

    await act(async () => { await h.result.current.removeBookmark(S1) })
    await waitFor(() => expect(userData.deletePublicBookmark).toHaveBeenCalledWith(S1))
    expect(ids(h)).toEqual([])

    // Reopen: the server still lists it, the tombstone wins and the delete is replayed.
    h.unmount()
    vi.mocked(userData.deletePublicBookmark).mockResolvedValue(undefined)
    const again = await mount()
    expect(ids(again)).toEqual([])
    await waitFor(() => expect(db.size).toBe(0))
    expect(userData.deletePublicBookmark).toHaveBeenCalledTimes(2)
  })

  it('removed while its POST is in flight: the created server row is deleted, not shown', async () => {
    const post = deferred<Srv>()
    vi.mocked(userData.createPublicBookmark).mockReturnValue(post.promise as never)
    vi.mocked(userData.deletePublicBookmark).mockResolvedValue(undefined)
    const h = await mount()

    let created: Bookmark | null = null
    await act(async () => { created = await h.result.current.addBookmark('one', 'One', CH1) })
    await waitFor(() => expect(userData.createPublicBookmark).toHaveBeenCalled())
    await act(async () => { await h.result.current.removeBookmark(created!.id) })
    expect(ids(h)).toEqual([])

    vi.mocked(userData.getPublicBookmarks).mockResolvedValue([srv(S1, 'one') as never])
    await act(async () => { post.resolve(srv(S1, 'one')) })

    await waitFor(() => expect(userData.deletePublicBookmark).toHaveBeenCalledWith(S1))
    await waitFor(() => expect(db.size).toBe(0))
    expect(ids(h)).toEqual([])
  })

  it('added while a sync is reading the server: not lost, and POSTed', async () => {
    const list = deferred<Srv[]>()
    vi.mocked(userData.getPublicBookmarks).mockReturnValueOnce(list.promise as never)
    vi.mocked(userData.createPublicBookmark).mockImplementation(async () => {
      // From now on the server lists both.
      vi.mocked(userData.getPublicBookmarks).mockResolvedValue([srv(S1, 'one'), srv(S2, 'two', CH2)] as never)
      return srv(S2, 'two', CH2) as never
    })
    const h = renderHook(() => useBookmarks('book', userA))
    await waitFor(() => expect(userData.getPublicBookmarks).toHaveBeenCalled())

    await act(async () => { await h.result.current.addBookmark('two', 'Two', CH2) })
    await act(async () => { list.resolve([srv(S1, 'one') as never]) })

    await waitFor(() => expect(new Set(ids(h))).toEqual(new Set([S1, S2])))
    expect(userData.createPublicBookmark).toHaveBeenCalledTimes(1)
  })

  it('re-added while its DELETE is in flight: it comes back as a new bookmark', async () => {
    const del = deferred<void>()
    vi.mocked(userData.getPublicBookmarks).mockResolvedValue([srv(S1, 'one') as never])
    vi.mocked(userData.deletePublicBookmark).mockReturnValue(del.promise)
    vi.mocked(userData.createPublicBookmark).mockResolvedValue(srv(S2, 'one') as never)
    const h = await mount()

    await act(async () => { await h.result.current.removeBookmark(S1) })
    await waitFor(() => expect(userData.deletePublicBookmark).toHaveBeenCalled())
    await act(async () => { await h.result.current.addBookmark('one', 'One', CH1) })
    vi.mocked(userData.getPublicBookmarks).mockResolvedValue([])
    await act(async () => { del.resolve() })

    await waitFor(() => expect(ids(h)).toEqual([S2]))
    expect(userData.createPublicBookmark).toHaveBeenCalledTimes(1)
  })

  it('never POSTs an offline cache key; resolves it from the chapter list', async () => {
    vi.mocked(userData.createPublicBookmark).mockResolvedValue(srv(S1, 'one') as never)
    const h = await mount()
    await act(async () => { await h.result.current.addBookmark('one', 'One', `${ED}:one`) })
    await act(async () => { await Promise.resolve() })
    expect(userData.createPublicBookmark).not.toHaveBeenCalled()
    expect(slugs(h)).toEqual(['one']) // kept, pending

    h.rerender({ ...userA, chapters: [{ id: CH1, identifier: 'one' }] })
    act(() => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(userData.createPublicBookmark).toHaveBeenCalledWith(expect.objectContaining({ chapterId: CH1 })))
  })
})

describe('useBookmarks — one store per user', () => {
  it("another account's rows are invisible and never synced", async () => {
    db.set('x', { id: 'x', bookId: 'book', owner: 'user-b', chapterSlug: 'b', chapterTitle: 'B', createdAt: 1, syncStatus: 'pending' })
    const h = await mount()
    expect(ids(h)).toEqual([])
    expect(userData.createPublicBookmark).not.toHaveBeenCalled()
  })

  it('rows made with no session join the account that signs in here', async () => {
    const anon = await mount({ editionId: ED, isAuthenticated: false })
    await act(async () => { await anon.result.current.addBookmark('one', 'One', CH1) })
    expect(userData.createPublicBookmark).not.toHaveBeenCalled()
    anon.unmount()

    vi.mocked(userData.createPublicBookmark).mockResolvedValue(srv(S1, 'one') as never)
    const h = await mount()
    await waitFor(() => expect(ids(h)).toEqual([S1]))
  })

  it('legacy rows (no owner) migrate as synced: kept if the server has them, never re-POSTed', async () => {
    db.set('l1', { id: 'l1', bookId: 'book', chapterSlug: 'one', chapterTitle: 'One', chapterId: CH1, createdAt: 1 })
    db.set('l2', { id: 'l2', bookId: 'book', chapterSlug: 'gone', chapterTitle: 'Gone', chapterId: CH2, createdAt: 2 })
    vi.mocked(userData.getPublicBookmarks).mockResolvedValue([srv(S1, 'one') as never])
    const h = await mount()
    await waitFor(() => expect(ids(h)).toEqual([S1]))
    expect(userData.createPublicBookmark).not.toHaveBeenCalled()
    expect([...db.keys()]).toEqual([S1])
    expect(db.get(S1)?.owner).toBe('user-a')
  })
})

describe('useBookmarks — uploads (same queue)', () => {
  const upload = { userBook: true, isAuthenticated: true, userId: 'user-a' }
  const pageRow = (id: string, page: number) =>
    ({ id, chapterId: null, chapterSlug: null, locator: `page:${page}`, title: `Page ${page}`, createdAt: new Date().toISOString() })

  it('a page bookmark added offline is POSTed with chapterId:null + page:<N> later', async () => {
    vi.mocked(userBooks.getUserBookBookmarks).mockRejectedValue(offline())
    const h = await mount(upload, UB)
    await act(async () => { await h.result.current.addPageBookmark(7) })
    expect(h.result.current.isPageBookmarked(7)).toBe(true)
    expect(h.result.current.isPageBookmarked(8)).toBe(false)

    vi.mocked(userBooks.getUserBookBookmarks).mockResolvedValue([])
    vi.mocked(userBooks.createUserBookBookmark).mockResolvedValue(pageRow('bm1', 7))
    act(() => { window.dispatchEvent(new Event('online')) })

    await waitFor(() => expect(h.result.current.getPageBookmark(7)?.id).toBe('bm1'))
    expect(userBooks.createUserBookBookmark).toHaveBeenCalledWith(UB, { chapterId: null, locator: 'page:7', title: 'Page 7' })
  })

  it('a second add for the same page does not POST again', async () => {
    vi.mocked(userBooks.createUserBookBookmark).mockImplementation(async () => {
      vi.mocked(userBooks.getUserBookBookmarks).mockResolvedValue([pageRow('bm1', 3)])
      return pageRow('bm1', 3)
    })
    const h = await mount(upload, UB)
    await act(async () => { await h.result.current.addPageBookmark(3) })
    await waitFor(() => expect(h.result.current.getPageBookmark(3)?.id).toBe('bm1'))
    await act(async () => { await h.result.current.addPageBookmark(3) })
    await act(async () => { await Promise.resolve() })
    expect(userBooks.createUserBookBookmark).toHaveBeenCalledTimes(1)
    expect(h.result.current.bookmarks).toHaveLength(1)
  })

  it('server page bookmarks load; remove deletes on the server', async () => {
    vi.mocked(userBooks.getUserBookBookmarks).mockResolvedValue([pageRow('bm9', 12)])
    vi.mocked(userBooks.deleteUserBookBookmark).mockResolvedValue(undefined)
    const h = await mount(upload, UB)
    expect(h.result.current.getPageBookmark(12)?.id).toBe('bm9')

    await act(async () => { await h.result.current.removeBookmark('bm9') })
    expect(h.result.current.isPageBookmarked(12)).toBe(false)
    await waitFor(() => expect(userBooks.deleteUserBookBookmark).toHaveBeenCalledWith(UB, 'bm9'))
    await waitFor(() => expect(db.size).toBe(0))
  })
})

describe('useBookmarks — review fixes', () => {
  it('a tombstone whose server row is gone does not delete a new bookmark for the same chapter', async () => {
    // Deleted S1 offline here; meanwhile another device deleted S1 and bookmarked the chapter again as S2.
    db.set(S1, { id: S1, bookId: 'book', owner: 'user-a', chapterSlug: 'one', chapterTitle: 'One', createdAt: 1, syncStatus: 'synced', deleted: true })
    vi.mocked(userData.getPublicBookmarks).mockResolvedValue([srv(S2, 'one') as never])
    const h = await mount()
    await waitFor(() => expect(ids(h)).toEqual([S2]))
    expect(userData.deletePublicBookmark).not.toHaveBeenCalled()
    expect(db.has(S1)).toBe(false)
  })

  it('re-added after a DELETE whose response was lost: created again, not dropped', async () => {
    vi.mocked(userData.getPublicBookmarks).mockResolvedValue([srv(S1, 'one') as never])
    vi.mocked(userData.deletePublicBookmark).mockImplementation(async () => {
      vi.mocked(userData.getPublicBookmarks).mockResolvedValue([]) // it did land
      throw offline()
    })
    vi.mocked(userData.createPublicBookmark).mockImplementation(async () => {
      vi.mocked(userData.getPublicBookmarks).mockResolvedValue([srv(S2, 'one') as never])
      return srv(S2, 'one') as never
    })
    const h = await mount()
    await act(async () => { await h.result.current.removeBookmark(S1) })
    await waitFor(() => expect(userData.deletePublicBookmark).toHaveBeenCalled())
    await act(async () => { await h.result.current.addBookmark('one', 'One', CH1) })
    await waitFor(() => expect(ids(h)).toEqual([S2]))
  })

  it("a guest's offline bookmark survives signing in to an existing account (new user id)", async () => {
    vi.mocked(userData.getPublicBookmarks).mockRejectedValue(offline())
    const guest = await mount({ editionId: ED, isAuthenticated: true, userId: 'guest-1', isGuest: true })
    await act(async () => { await guest.result.current.addBookmark('one', 'One', CH1) })
    guest.unmount()

    vi.mocked(userData.getPublicBookmarks).mockResolvedValue([])
    vi.mocked(userData.createPublicBookmark).mockImplementation(async () => {
      vi.mocked(userData.getPublicBookmarks).mockResolvedValue([srv(S1, 'one') as never])
      return srv(S1, 'one') as never
    })
    const h = await mount()
    await waitFor(() => expect(ids(h)).toEqual([S1]))
  })

  it('no IndexedDB: lists from the server and adds/removes against it', async () => {
    idb.down = true
    const upload = { userBook: true, isAuthenticated: true, userId: 'user-a' }
    vi.mocked(userBooks.getUserBookBookmarks).mockResolvedValue([
      { id: 'bm9', chapterId: null, chapterSlug: null, locator: 'page:12', title: 'Page 12', createdAt: '2026-10-01T00:00:00Z' },
    ])
    vi.mocked(userBooks.createUserBookBookmark).mockResolvedValue(
      { id: 'bm4', chapterId: null, chapterSlug: null, locator: 'page:4', title: 'Page 4', createdAt: '2026-10-02T00:00:00Z' },
    )
    vi.mocked(userBooks.deleteUserBookBookmark).mockResolvedValue(undefined)
    const h = await mount(upload, UB)
    await waitFor(() => expect(h.result.current.isPageBookmarked(12)).toBe(true))

    await act(async () => { await h.result.current.addPageBookmark(4) })
    expect(userBooks.createUserBookBookmark).toHaveBeenCalledWith(UB, { chapterId: null, locator: 'page:4', title: 'Page 4' })
    expect(h.result.current.isPageBookmarked(4)).toBe(true)

    await act(async () => { await h.result.current.removeBookmark('bm9') })
    expect(userBooks.deleteUserBookBookmark).toHaveBeenCalledWith(UB, 'bm9')
    expect(h.result.current.isPageBookmarked(12)).toBe(false)
    expect(h.result.current.error).toBe(null)
  })

  it('no IndexedDB and the server fails too: the error is surfaced, not swallowed', async () => {
    idb.down = true
    vi.mocked(userBooks.createUserBookBookmark).mockRejectedValue(offline())
    const h = await mount({ userBook: true, isAuthenticated: true, userId: 'user-a' }, UB)
    await act(async () => { await h.result.current.addPageBookmark(4) })
    expect(h.result.current.error).toBe('bookmark_failed')
    expect(h.result.current.bookmarks).toHaveLength(0)
  })
})
