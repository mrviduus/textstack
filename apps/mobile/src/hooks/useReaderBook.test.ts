// @vitest-environment jsdom
/**
 * The catalog reader's book and chapter loaders offline, through the real hooks: the server
 * (createBooksApi) and SQLite (offlineDb) faked at the module boundary. Pins C1 (the edition id does
 * not wait on the network), R2 H2 / M2 (offline chapter changes) and the offline title (review of
 * #717) — pins that used to be source-text guards. Each test uses its own book slug: the
 * slug → edition id memory (editionIds.ts) is process-wide by design.
 */
import { act, useRef } from 'react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { renderHook } from '../test/renderHook'
import { useReaderBook } from './useReaderBook'
import { useReaderChapter } from './useReaderChapter'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fakes = Record<string, Mock<(...a: any[]) => any>>
const fx = vi.hoisted(() => ({ db: {} as Fakes, api: {} as Fakes }))
vi.mock('../lib/offlineDb', () => Object.fromEntries(
  ['getAllCachedBooks', 'isBookFullyCached', 'listCachedChapters', 'getCachedChapter', 'refreshCachedChapter']
    .map(n => [n, (...a: unknown[]) => fx.db[n](...a)]),
))
vi.mock('@textstack/shared', async (orig) => ({
  ...(await orig<object>()),
  createBooksApi: () => ({ getBook: (...a: unknown[]) => fx.api.getBook(...a), getChapter: (...a: unknown[]) => fx.api.getChapter(...a) }),
  bookmarksApi: { getBookmarks: async () => [] },
}))

const noop = () => {}   // stable: setBookmarks is an effect dependency
const never = () => new Promise<never>(() => {})
const offline = () => Promise.reject(new TypeError('Network request failed'))
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) })
const CACHED_ROWS = [
  { slug: 'one', title: 'One', chapterId: 'c1', wordCount: 100 },
  { slug: 'two', title: 'Two', chapterId: 'c2', wordCount: 300 },
]

beforeEach(() => {
  fx.db = {
    getAllCachedBooks: vi.fn(async () => []),
    isBookFullyCached: vi.fn(async () => true),
    listCachedChapters: vi.fn(async () => CACHED_ROWS),
    getCachedChapter: vi.fn(async () => null),
    refreshCachedChapter: vi.fn(async () => {}),
  }
  fx.api = { getBook: vi.fn(never), getChapter: vi.fn(never) }
})

function mountBook(bookSlug: string) {
  return renderHook((p: { bookSlug: string }) => {
    const editionIdRef = useRef<string | null>(null)
    const bookTitleRef = useRef<string | null>(null)
    const totalWordCountRef = useRef(0)
    const book = useReaderBook({ ...p, language: 'en', isAuthenticated: false, editionIdRef, bookTitleRef, totalWordCountRef, setBookmarks: noop })
    return { ...book, editionIdRef, totalWordCountRef }
  }, { bookSlug })
}

function mountChapter(bookSlug: string, chapterSlug: string) {
  return renderHook((p: { bookSlug: string; chapterSlug: string }) => {
    const editionIdRef = useRef<string | null>(null)
    return useReaderChapter({ ...p, language: 'en', editionIdRef })
  }, { bookSlug, chapterSlug })
}

describe('C1 — the edition id does not wait on the network', () => {
  it('a downloaded book has its id from the device while the book request hangs', async () => {
    fx.db.getAllCachedBooks.mockResolvedValue([{ slug: 'c1-book', editionId: 'e-c1', title: 'Dracula' }])
    const h = mountBook('c1-book')
    await settle()
    expect(h.result.current.editionId).toBe('e-c1')
    expect(h.result.current.editionIdRef.current).toBe('e-c1')
  })
})

describe('H2 — the next mount resolves the edition id this process already knew', () => {
  it('a book read online, never downloaded: offline, the next chapter is read from SQLite by that id', async () => {
    fx.api.getBook.mockResolvedValue({ id: 'e-h2', title: 'Online book', chapters: [] })
    const book = mountBook('h2-book')
    await settle()
    expect(book.result.current.editionId).toBe('e-h2')
    book.unmount()
    fx.db.getAllCachedBooks.mockClear()

    // router.replace remounted the screen; the signal is gone and the book is in no cached list.
    fx.api.getChapter.mockImplementation(offline)
    fx.db.getCachedChapter.mockResolvedValue({ chapterId: 'c2', chapterSlug: 'two', title: 'Two', html: '<p>two</p>', wordCount: 300, prev: null, next: null })
    const chapter = mountChapter('h2-book', 'two')
    await settle()
    expect(fx.db.getCachedChapter).toHaveBeenCalledWith('e-h2', 'two')
    expect(fx.db.getAllCachedBooks).not.toHaveBeenCalled()
    expect(chapter.result.current.chapter?.title).toBe('Two')
    expect(chapter.result.current.chapterError).toBeNull()

    // And the book loader takes the remembered id too, though the request fails.
    fx.api.getBook.mockImplementation(offline)
    const again = mountBook('h2-book')
    await settle()
    expect(again.result.current.editionId).toBe('e-h2')
  })
})

describe('M2 — offline table of contents of a downloaded catalog book', () => {
  it('comes from the device, with the book word count', async () => {
    fx.db.getAllCachedBooks.mockResolvedValue([{ slug: 'm2-book', editionId: 'e-m2', title: 'Downloaded' }])
    fx.api.getBook.mockImplementation(offline)
    const h = mountBook('m2-book')
    await settle()
    expect(h.result.current.chapters.map(c => c.slug)).toEqual(['one', 'two'])
    expect(h.result.current.totalWordCountRef.current).toBe(400)
    expect(h.result.current.chaptersLoading).toBe(false)
  })

  it('waits for the device id when the request fails first (review #2)', async () => {
    let answerDevice!: (v: unknown[]) => void
    fx.db.getAllCachedBooks.mockReturnValue(new Promise(r => { answerDevice = r }))
    fx.api.getBook.mockImplementation(offline)
    const h = mountBook('m2-race')
    await settle()                                            // the request has failed; the device has not answered
    await act(async () => { answerDevice([{ slug: 'm2-race', editionId: 'e-race', title: 'Downloaded' }]) })
    await settle()
    expect(h.result.current.chapters.map(c => c.slug)).toEqual(['one', 'two'])
  })

  it('a partial download gives no table of contents (its total would be wrong)', async () => {
    fx.db.getAllCachedBooks.mockResolvedValue([{ slug: 'm2-partial', editionId: 'e-partial', title: 'Half' }])
    fx.db.isBookFullyCached.mockResolvedValue(false)
    fx.api.getBook.mockImplementation(offline)
    const h = mountBook('m2-partial')
    await settle()
    expect(h.result.current.chapters).toEqual([])
  })
})

describe('offline title after a chapter turn (review of #717)', () => {
  it('the device still sets the title when the id was already known in memory', async () => {
    fx.api.getBook.mockResolvedValue({ id: 'e-717', title: 'Known', chapters: [] })
    const first = mountBook('t-book')
    await settle()
    first.unmount()

    fx.api.getBook.mockImplementation(offline)
    fx.db.getAllCachedBooks.mockResolvedValue([{ slug: 't-book', editionId: 'e-717', title: 'Title from the device' }])
    const h = mountBook('t-book')
    await settle()
    expect(h.result.current.bookTitle).toBe('Title from the device')
  })
})
