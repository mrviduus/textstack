// @vitest-environment jsdom
/**
 * The two reader sources — useUserBookReaderSource (uploads) and useEditionReaderSource (catalog) —
 * driven through the real hooks, with the real useReaderPersistence inside them. Faked at the module
 * boundary: the server APIs, SQLite (offlineDb), the downloaded-original cache, AppState. The device
 * record is the real progressStorage on the in-memory AsyncStorage.
 *
 * Pins R2 H1 (an upload's viewer is known before anything is written) and H3 (the foreground check
 * reads the device record as it is now), and the open order: the device restores, the progress
 * request only runs in the background (was progressRestoreOrder.test.ts).
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { renderHook } from '../../test/renderHook'
import { useUserBookReaderSource } from './useUserBookReaderSource'
import { useEditionReaderSource } from './useEditionReaderSource'
import {
  getUserBookIsPdf, getUserBookLocalProgress, saveLocalProgress, saveUserBookLocalProgress, setUserBookIsPdf,
} from '../../lib/progressStorage'
import { forgetChapterPositions } from '../../lib/positionHandoff'

// --- module-boundary fakes ---------------------------------------------------------------------
const appState = vi.hoisted(() => {
  const listeners = new Set<(s: string) => void>()
  return { listeners, current: 'active', set(s: string) { appState.current = s; for (const l of [...listeners]) l(s) } }
})
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() { return appState.current },
    addEventListener: (_: string, fn: (s: string) => void) => {
      appState.listeners.add(fn)
      return { remove: () => appState.listeners.delete(fn) }
    },
  },
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: () => {} }) }))
vi.mock('react-native-webview', () => ({ WebView: {} }))
vi.mock('../../lib/api', () => ({ API_URL: 'https://api.test' }))
const toast = vi.hoisted(() => ({ show: vi.fn((_o: object) => 1), dismiss: vi.fn() }))
vi.mock('../../context/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../../context/LanguageContext', () => ({ useLanguage: () => ({ language: 'en' }) }))

const never = () => new Promise<never>(() => {})
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
// Fresh fakes per test (beforeEach); the module mocks call through to whatever is current.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fakes = Record<string, Mock<(...a: any[]) => any>>
const fx = vi.hoisted(() => {
  const bags = { db: {} as Fakes, files: {} as Fakes, userBooks: {} as Fakes, progress: {} as Fakes }
  const through = (bag: keyof typeof bags, names: string[]) =>
    Object.fromEntries(names.map(n => [n, (...a: unknown[]) => bags[bag][n](...a)]))
  return Object.assign(bags, { through })
})
vi.mock('../../lib/offlineDb', () => fx.through('db', ['getCachedUserChapter', 'refreshCachedUserChapter', 'cacheUserChapter', 'getCachedUserBookMeta', 'listCachedUserChapters', 'getCachedChapter', 'cacheChapter']))
vi.mock('../../lib/originalFileCache', () => fx.through('files', ['getCachedOriginalUri', 'touchOriginal']))
vi.mock('@textstack/shared', async (orig) => ({
  ...(await orig<object>()),
  userBooksApi: fx.through('userBooks', ['getUserBookChapter', 'getUserBook', 'getUserBookBookmarks', 'getUserBookProgress', 'updateUserBookProgress', 'getUserBookFileUrl']),
  readingProgressApi: fx.through('progress', ['getProgress', 'updateProgress']),
}))
// The catalog source's own loaders have their tests (useReaderBook.test.ts); here they just answer.
const EDITION_CHAPTER = { id: 'c1', title: 'One', html: '<p>one</p>', prev: null, next: null, slug: 'ch-1', chapterNumber: 0, wordCount: 100 }
vi.mock('../../hooks/useReaderChapter', () => ({
  useReaderChapter: () => ({ chapter: EDITION_CHAPTER, loading: false, chapterError: null, wordCountRef: { current: 100 } }),
}))
vi.mock('../../hooks/useReaderBook', () => ({
  useReaderBook: ({ editionIdRef }: { editionIdRef: { current: string | null } }) => {
    editionIdRef.current = 'e1'
    return { bookTitle: 'Book', chapters: EDITION_CHAPTERS, editionId: 'e1', chaptersLoading: false }
  },
}))
const EDITION_CHAPTERS = [{ id: 'c1', slug: 'ch-1', title: 'One', chapterNumber: 0, wordCount: 100 }]
vi.mock('../../hooks/useReaderBookmarks', () => ({
  useReaderBookmarks: () => ({ bookmarks: [], setBookmarks: () => {}, toggle: () => {}, remove: () => {} }),
  getSlugFromLocator: () => null,
}))

const CACHED_CH1 = { chapterId: 'c1', chapterSlug: 'ch-1', title: 'One', html: '<p>one</p>', wordCount: 100, prev: null, next: null, sourceStartPage: 5 }
const ROW_CH1 = { chapterSlug: 'ch-1', title: 'One', chapterNumber: 0, wordCount: 100, sourceStartPage: 5 }
const BOOK = (hasOriginalPdf: boolean) => ({
  title: 'Book', language: 'en', hasOriginalPdf, totalWordCount: 100,
  chapters: [{ slug: 'ch-1', title: 'One', chapterNumber: 0, wordCount: 100, sourceStartPage: 5 }],
})
const iso = (ms: number) => new Date(ms).toISOString()
const T0 = Date.now() - 60_000

beforeEach(() => {
  ;(AsyncStorage as unknown as { __reset(): void }).__reset()
  forgetChapterPositions()
  appState.current = 'active'
  toast.show.mockClear()
  fx.db = {
    getCachedUserChapter: vi.fn(async () => CACHED_CH1),
    refreshCachedUserChapter: vi.fn(async () => {}),
    cacheUserChapter: vi.fn(async () => {}),
    getCachedUserBookMeta: vi.fn(async () => null),
    listCachedUserChapters: vi.fn(async () => []),
    getCachedChapter: vi.fn(async () => null),
    cacheChapter: vi.fn(async () => {}),
  }
  fx.files = { getCachedOriginalUri: vi.fn(async () => null), touchOriginal: vi.fn(async () => {}) }
  fx.userBooks = {
    getUserBookChapter: vi.fn(never),
    getUserBook: vi.fn(never),
    getUserBookBookmarks: vi.fn(async () => []),
    getUserBookProgress: vi.fn(never),
    updateUserBookProgress: vi.fn(async () => {}),
    getUserBookFileUrl: vi.fn(() => 'https://api.test/me/books/b1/file'),
  }
  fx.progress = { getProgress: vi.fn(never), updateProgress: vi.fn(async () => {}) }
})

const mounted: (() => void)[] = []
afterEach(() => { for (const u of mounted.splice(0)) u() })

/** Lets the hooks' promise chains (AsyncStorage, the fakes) run out. */
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) })

type Runtime = ReturnType<typeof useUserBookReaderSource>
function harness(useSource: () => Runtime) {
  const injected: string[] = []
  const renders: { original: boolean | undefined; startPage: number | null | undefined }[] = []
  const h = renderHook(() => {
    const rt = useSource()
    ;(rt.webViewRef as { current: unknown }).current = { injectJavaScript: (js: string) => { injected.push(js) } }
    renders.push({ original: rt.original, startPage: rt.originalInitialPage })
    return rt
  }, {})
  let gone = false
  const unmount = () => { if (!gone) { gone = true; h.unmount() } }
  mounted.push(unmount)
  const rt = () => h.result.current
  return {
    rt, renders, injected, unmount,
    restores: () => injected.flatMap(js => {
      const m = js.match(/__textstackRestoreScroll\((\d+), (\d+)\)/)
      return m ? [{ offset: Number(m[1]), id: Number(m[2]) }] : []
    }),
    /** ReaderShell's onLoadEnd, the persistence half. */
    loadEnd: () => act(() => { rt().onWebViewLoaded() }),
    land: (id: number, scrollY: number) => act(() => { rt().onRestoreLanded(id, scrollY) }),
    /** The WebView reported a place; then a save (the debounce / unmount flush call the same one). */
    readTo: (scrollY: number, percent: number) => act(() => {
      rt().scrollOffsetRef.current = scrollY
      rt().progressRef.current = percent
      rt().currentChapterSlugRef.current = 'ch-1'
      rt().saveProgress()
    }),
  }
}
const mountUpload = () => harness(() => useUserBookReaderSource({ bookId: 'b1', chapterSlug: 'ch-1', showToast: () => {} }))
const mountEdition = () => harness(() => useEditionReaderSource({
  bookSlug: 'book', chapterSlug: 'ch-1', language: 'en', isAuthenticated: true, showToast: () => {},
}) as Runtime)

describe('H1 — an upload never writes scroll: over page: while its viewer is unknown', () => {
  it('waits (loading, no write) until the device or the server says whether it is a PDF', async () => {
    const book = deferred<ReturnType<typeof BOOK>>()
    fx.userBooks.getUserBook.mockReturnValue(book.promise)
    const r = mountUpload()
    await settle()
    expect(r.rt().loading).toBe(true)
    r.loadEnd()
    r.readTo(400, 0.2)
    await settle()
    expect(await getUserBookLocalProgress('b1')).toBeNull()

    await act(async () => { book.resolve(BOOK(false)) })
    await settle()
    expect(r.rt().loading).toBe(false)
  })

  it('a book this device knows is not a PDF opens at once, without the server (the answer is remembered)', async () => {
    fx.userBooks.getUserBook.mockResolvedValue(BOOK(false))
    const first = mountUpload()
    await settle()
    expect(await getUserBookIsPdf('b1')).toBe(false)
    first.unmount()

    fx.userBooks.getUserBook.mockImplementation(never)
    const next = mountUpload()
    await settle()
    expect(next.rt().loading).toBe(false)
    expect(next.rt().original).toBe(false)
  })

  it('a downloaded original opens in Original from the device, at the chapter start page from its first frame (review #1)', async () => {
    fx.files.getCachedOriginalUri.mockResolvedValue('file:///b1.pdf')
    fx.db.listCachedUserChapters.mockResolvedValue([ROW_CH1])
    const r = mountUpload()
    await settle()
    expect(r.rt().original).toBe(true)
    expect(r.rt().originalFileUrl).toBe('file:///b1.pdf')
    const originalFrames = r.renders.filter(f => f.original)
    expect(originalFrames.length).toBeGreaterThan(0)
    expect(originalFrames.every(f => f.startPage === 5)).toBe(true)
  })

  it('offline (the book request fails), the downloaded copy supplies the start pages too', async () => {
    fx.userBooks.getUserBook.mockRejectedValue(new TypeError('Network request failed'))
    fx.db.getCachedUserBookMeta.mockResolvedValue({ title: 'Book', language: 'en', isPdf: true, totalWordCount: 100 })
    // Not yet on disk when the device layout is asked; there by the offline fallback.
    fx.files.getCachedOriginalUri.mockResolvedValueOnce(null).mockResolvedValue('file:///b1.pdf')
    fx.db.listCachedUserChapters.mockResolvedValue([ROW_CH1])
    const r = mountUpload()
    await settle()
    expect(r.rt().original).toBe(true)
    expect(r.rt().originalInitialPage).toBe(5)
  })

  it('a PDF read as text offline keeps the page the Original viewer resumes from', async () => {
    await saveUserBookLocalProgress('b1', { updatedAt: T0, chapterSlug: null, page: 42, bookPercent: 0.3 })
    fx.userBooks.getUserBook.mockRejectedValue(new TypeError('Network request failed'))
    fx.db.getCachedUserBookMeta.mockResolvedValue({ title: 'Book', language: 'en', isPdf: true, totalWordCount: 100 })
    fx.db.listCachedUserChapters.mockResolvedValue([ROW_CH1])
    const r = mountUpload()
    await settle()
    expect(r.rt().original).toBe(false)
    r.loadEnd()
    r.readTo(300, 0.2)
    await settle()
    expect(await getUserBookLocalProgress('b1')).toMatchObject({ chapterSlug: 'ch-1', scrollOffset: 300, page: 42 })
  })

  it('the server naming the book a PDF after a reflow open stops every reflow write', async () => {
    await setUserBookIsPdf('b1', false)   // stale: the device thought it was text
    const book = deferred<ReturnType<typeof BOOK>>()
    fx.userBooks.getUserBook.mockReturnValue(book.promise)
    const r = mountUpload()
    await settle()
    r.loadEnd()
    r.readTo(300, 0.2)
    await settle()
    const written = fx.userBooks.updateUserBookProgress.mock.calls.length
    const record = await getUserBookLocalProgress('b1')

    await act(async () => { book.resolve(BOOK(true)) })
    await settle()
    expect(r.rt().original).toBe(true)
    r.readTo(900, 0.6)
    r.unmount()
    await settle()
    expect(fx.userBooks.updateUserBookProgress).toHaveBeenCalledTimes(written)
    expect(await getUserBookLocalProgress('b1')).toEqual(record)
  })
})

describe('the open restores from the device; the progress request only runs in the background', () => {
  it.each([
    ['upload', mountUpload, () => saveUserBookLocalProgress('b1', { updatedAt: T0, chapterSlug: 'ch-1', scrollOffset: 900 })],
    ['catalog', mountEdition, () => saveLocalProgress('e1', { chapterId: 'c1', chapterSlug: 'ch-1', locator: 'scroll:ch-1:900', percent: 0.3, updatedAt: T0 })],
  ] as const)('%s: a progress request that never answers does not hold the restore', async (_kind, mount, seed) => {
    await setUserBookIsPdf('b1', false)
    await seed()
    const r = mount()
    await settle()
    r.loadEnd()
    expect(r.restores()).toEqual([{ offset: 900, id: 1 }])
  })

  it('a downloaded PDF opens at the device page while the request hangs', async () => {
    await saveUserBookLocalProgress('b1', { updatedAt: T0, chapterSlug: null, page: 12 })
    fx.files.getCachedOriginalUri.mockResolvedValue('file:///b1.pdf')
    fx.db.listCachedUserChapters.mockResolvedValue([ROW_CH1])
    const r = mountUpload()
    await settle()
    expect(fx.userBooks.getUserBookProgress).toHaveBeenCalled()
    expect(r.rt().originalResumeReady).toBe(true)
    expect(r.rt().originalResumePage).toBe(12)
  })
})

describe('H3 — the foreground check compares against the device record as it is at the return', () => {
  // Opened from a record at T0; this device has since saved at T0+5s. The server holds a row from
  // T0+2s — newer than the open, older than the device's own latest write: not another device's.
  it.each([
    ['upload', mountUpload,
      () => saveUserBookLocalProgress('b1', { updatedAt: T0, chapterSlug: 'ch-1', scrollOffset: 900 }),
      () => saveUserBookLocalProgress('b1', { updatedAt: T0 + 5000, chapterSlug: 'ch-1', scrollOffset: 900 }),
      (row: object) => fx.userBooks.getUserBookProgress.mockResolvedValue(row)],
    ['catalog', mountEdition,
      () => saveLocalProgress('e1', { chapterId: 'c1', chapterSlug: 'ch-1', locator: 'scroll:ch-1:900', percent: 0.3, updatedAt: T0 }),
      () => saveLocalProgress('e1', { chapterId: 'c1', chapterSlug: 'ch-1', locator: 'scroll:ch-1:900', percent: 0.3, updatedAt: T0 + 5000 }),
      (row: object) => fx.progress.getProgress.mockResolvedValue(row)],
  ] as const)('%s: the device\'s own later write is not offered back as "newer elsewhere"', async (_kind, mount, seed, laterWrite, server) => {
    await setUserBookIsPdf('b1', false)
    await seed()
    server({ chapterSlug: 'ch-1', locator: 'scroll:ch-1:900', clientUpdatedAt: iso(T0 - 1000) })   // the open's check: older
    const r = mount()
    await settle()
    r.loadEnd()
    r.land(r.restores()[0].id, 900)
    await settle()

    await laterWrite()
    server({ chapterSlug: 'ch-1', locator: 'scroll:ch-1:5000', clientUpdatedAt: iso(T0 + 2000) })
    act(() => appState.set('background'))
    act(() => appState.set('active'))
    await settle()
    expect(r.restores().map(x => x.offset)).toEqual([900])
    expect(toast.show).not.toHaveBeenCalled()
  })

  it('PDF: a page found on the return is an offer marked onReturn (its "moved" is measured from the page at return)', async () => {
    await saveUserBookLocalProgress('b1', { updatedAt: T0, chapterSlug: null, page: 10 })
    fx.files.getCachedOriginalUri.mockResolvedValue('file:///b1.pdf')
    fx.db.listCachedUserChapters.mockResolvedValue([ROW_CH1])
    fx.userBooks.getUserBookProgress.mockResolvedValue({ locator: 'page:10', clientUpdatedAt: iso(T0 - 1000) })
    const r = mountUpload()
    await settle()
    expect(r.rt().originalNewerPage).toBeNull()

    fx.userBooks.getUserBookProgress.mockResolvedValue({ locator: 'page:30', clientUpdatedAt: iso(T0 + 2000) })
    act(() => appState.set('background'))
    act(() => appState.set('active'))
    await settle()
    expect(r.rt().originalNewerPage).toMatchObject({ page: 30, onReturn: true })
  })
})
