import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { Bookmark } from '../../lib/bookmarkStore'

// H3 / L4: a bookmark that has not reached the server yet is pending. The server
// list must never wipe it, it is replayed, and an offline delete leaves a
// tombstone that is replayed instead of resurrecting the bookmark.

const db = new Map<string, Bookmark>()
vi.mock('../../lib/bookmarkStore', () => ({
  getBookmarksForBook: vi.fn(async (bookId: string) => [...db.values()].filter((b) => b.bookId === bookId)),
  saveBookmark: vi.fn(async (b: Bookmark) => { db.set(b.id, b) }),
  deleteBookmark: vi.fn(async (id: string) => { db.delete(id) }),
}))

const server: { id: string; editionId: string; chapterId: string; locator: string; title: string | null; createdAt: string }[] = []
let offline = false
const netErr = () => Object.assign(new Error('offline'), { status: 0 })
vi.mock('../../api/userData', () => ({
  getPublicBookmarks: vi.fn(async (ed: string) => { if (offline) throw netErr(); return server.filter((r) => r.editionId === ed) }),
  createPublicBookmark: vi.fn(async (d: { editionId: string; chapterId: string; locator: string; title?: string }) => {
    if (offline) throw netErr()
    const row = { id: `aaaaaaaa-0000-0000-0000-00000000000${server.length}`, editionId: d.editionId, chapterId: d.chapterId, locator: d.locator, title: d.title ?? null, createdAt: new Date().toISOString() }
    server.push(row)
    return row
  }),
  deletePublicBookmark: vi.fn(async (id: string) => {
    if (offline) throw netErr()
    const i = server.findIndex((s) => s.id === id)
    if (i >= 0) server.splice(i, 1)
  }),
}))
vi.mock('../../lib/dataEvents', () => ({ emitDataChange: vi.fn() }))

import { useBookmarks } from '../useBookmarks'
import { createPublicBookmark, getPublicBookmarks } from '../../api/userData'

const ED = 'eeeeeeee-0000-0000-0000-000000000000'
const CH = 'cccccccc-0000-0000-0000-000000000000'
const opts = { editionId: ED, isAuthenticated: true }

beforeEach(() => {
  db.clear()
  server.length = 0
  offline = false
  vi.clearAllMocks()
})

describe('useBookmarks — pending bookmarks survive the server list', () => {
  it('a bookmark the server rejected stays local, is not wiped on reload, and is replayed', async () => {
    vi.mocked(createPublicBookmark).mockRejectedValueOnce(Object.assign(new Error('500'), { status: 500 }))
    const first = renderHook(() => useBookmarks('book', opts))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    await act(async () => { await first.result.current.addBookmark('one', 'One', CH) })
    expect(first.result.current.bookmarks).toHaveLength(1)
    first.unmount()

    // Reload: the server has nothing, the local pending row must survive and be sent.
    const second = renderHook(() => useBookmarks('book', opts))
    await waitFor(() => expect(server).toHaveLength(1))
    await waitFor(() => expect(second.result.current.bookmarks.map((b) => b.id)).toEqual([server[0].id]))
    expect([...db.values()].map((b) => b.id)).toEqual([server[0].id])
  })

  it('an offline delete is not resurrected by the next server load', async () => {
    server.push({ id: 'bbbbbbbb-0000-0000-0000-000000000000', editionId: ED, chapterId: CH, locator: 'chapter:one', title: 'One', createdAt: new Date().toISOString() })
    const first = renderHook(() => useBookmarks('book', opts))
    await waitFor(() => expect(first.result.current.bookmarks).toHaveLength(1))
    offline = true
    await act(async () => { await first.result.current.removeBookmark('bbbbbbbb-0000-0000-0000-000000000000') })
    expect(first.result.current.bookmarks).toHaveLength(0)
    first.unmount()

    offline = false
    const second = renderHook(() => useBookmarks('book', opts))
    await waitFor(() => expect(server).toHaveLength(0))
    await waitFor(() => expect(second.result.current.loading).toBe(false))
    expect(second.result.current.bookmarks).toHaveLength(0)
    expect(db.size).toBe(0)
  })

  it('never POSTs a non-GUID chapter id (the old cache key)', async () => {
    const h = renderHook(() => useBookmarks('book', opts))
    await waitFor(() => expect(h.result.current.loading).toBe(false))
    await act(async () => { await h.result.current.addBookmark('one', 'One', `${ED}:one`) })
    expect(createPublicBookmark).not.toHaveBeenCalled()
    expect(h.result.current.bookmarks).toHaveLength(1)
  })

  // Review of #719 ---------------------------------------------------------

  it('a book switch during an in-flight sync still shows the new book, never the old one', async () => {
    const ED2 = 'eeeeeeee-0000-0000-0000-000000000002'
    server.push({ id: 'bbbbbbbb-0000-0000-0000-00000000000a', editionId: ED, chapterId: CH, locator: 'chapter:a', title: 'A', createdAt: new Date().toISOString() })
    server.push({ id: 'bbbbbbbb-0000-0000-0000-00000000000b', editionId: ED2, chapterId: CH, locator: 'chapter:b', title: 'B', createdAt: new Date().toISOString() })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    vi.mocked(getPublicBookmarks).mockImplementationOnce(async (ed: string) => { await gate; return server.filter((r) => r.editionId === ed) })
    const h = renderHook((p: { book: string; ed: string }) => useBookmarks(p.book, { editionId: p.ed, isAuthenticated: true }), { initialProps: { book: 'A', ed: ED } })
    await waitFor(() => expect(getPublicBookmarks).toHaveBeenCalledTimes(1))
    h.rerender({ book: 'B', ed: ED2 })
    release()
    await waitFor(() => expect(h.result.current.bookmarks.map((b) => b.chapterSlug)).toEqual(['b']))
    await new Promise((r) => setTimeout(r, 50))
    expect(h.result.current.bookmarks.map((b) => b.chapterSlug)).toEqual(['b'])
  })

  it('removing a pending bookmark while its create is in flight deletes it on the server too', async () => {
    db.set('1-local', { id: '1-local', bookId: 'book', chapterSlug: 'one', chapterTitle: 'One', chapterId: CH, createdAt: 1, syncStatus: 'pending' })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const real = vi.mocked(createPublicBookmark).getMockImplementation()!
    vi.mocked(createPublicBookmark).mockImplementationOnce(async (d) => { await gate; return real(d) })
    const h = renderHook(() => useBookmarks('book', opts))
    await waitFor(() => expect(createPublicBookmark).toHaveBeenCalledTimes(1))
    await act(async () => { await h.result.current.removeBookmark('1-local') })
    release()
    await waitFor(() => expect(h.result.current.loading).toBe(false))
    await new Promise((r) => setTimeout(r, 50))
    expect(server).toHaveLength(0)
    expect(h.result.current.bookmarks).toHaveLength(0)
    expect([...db.values()].filter((b) => !b.deleted)).toHaveLength(0)
  })

  it('a legacy local row (fresh id, no status) deleted offline does not resurrect its server twin', async () => {
    server.push({ id: 'bbbbbbbb-0000-0000-0000-000000000000', editionId: ED, chapterId: CH, locator: 'chapter:one', title: 'One', createdAt: new Date().toISOString() })
    db.set('123-legacy', { id: '123-legacy', bookId: 'book', chapterSlug: 'one', chapterTitle: 'One', chapterId: CH, createdAt: 1 })
    offline = true
    const first = renderHook(() => useBookmarks('book', opts))
    await waitFor(() => expect(first.result.current.bookmarks).toHaveLength(1))
    await act(async () => { await first.result.current.removeBookmark('123-legacy') })
    first.unmount()
    offline = false
    const second = renderHook(() => useBookmarks('book', opts))
    await waitFor(() => expect(server).toHaveLength(0))
    await waitFor(() => expect(second.result.current.loading).toBe(false))
    expect(second.result.current.bookmarks).toHaveLength(0)
  })

  it('a pending row saved under a cache key replays with the id resolved from the chapter list', async () => {
    db.set('1-local', { id: '1-local', bookId: 'book', chapterSlug: 'one', chapterTitle: 'One', chapterId: `${ED}:one`, createdAt: 1, syncStatus: 'pending' })
    renderHook(() => useBookmarks('book', { ...opts, chapters: [{ id: CH, identifier: 'one' }] }))
    await waitFor(() => expect(server).toHaveLength(1))
    expect(server[0].chapterId).toBe(CH)
  })

  it('re-adding a chapter after deleting its pending row keeps the new bookmark', async () => {
    db.set('9-old', { id: '9-old', bookId: 'book', chapterSlug: 'one', chapterTitle: 'One', chapterId: CH, createdAt: 1, syncStatus: 'pending', deleted: true })
    offline = true // the tombstone survives the first load
    const first = renderHook(() => useBookmarks('book', { ...opts }))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    offline = false
    await act(async () => { await first.result.current.addBookmark('one', 'One', CH) })
    expect(server).toHaveLength(1)
    first.unmount()
    const second = renderHook(() => useBookmarks('book', opts))
    await waitFor(() => expect(second.result.current.loading).toBe(false))
    await new Promise((r) => setTimeout(r, 50))
    expect(server).toHaveLength(1)
    expect(second.result.current.bookmarks).toHaveLength(1)
  })
})
