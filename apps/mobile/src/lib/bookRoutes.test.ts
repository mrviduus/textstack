import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { heroResumeRoute, resumeRoute } from './bookRoutes'
import type { ContinueReadingPick } from '@textstack/shared'

describe('resumeRoute', () => {
  const edition = (o: Partial<Extract<ContinueReadingPick, { type: 'edition' }>> = {}) => ({
    type: 'edition' as const,
    slug: 'dracula',
    title: 'Dracula',
    coverPath: null,
    percent: 0.4,
    chapterSlug: 'chapter-4',
    updatedAtMs: 1,
    ...o,
  })
  const userbook = (o: Partial<Extract<ContinueReadingPick, { type: 'userbook' }>> = {}) => ({
    type: 'userbook' as const,
    id: 'ub-1',
    title: 'DDIA',
    coverPath: null,
    percent: 0.6,
    chapterSlug: 'chapter-5',
    updatedAtMs: 2,
    ...o,
  })

  it('opens the reader at the saved chapter', () => {
    expect(resumeRoute(edition())).toBe('/reader/dracula/chapter-4')
  })

  it('keeps the user-book segments in route order: bookId then chapterSlug', () => {
    // These were once swapped, so expo-router could not match the path and
    // silently fell back to the detail screen — Continue Reading looked broken
    // for every uploaded book.
    expect(resumeRoute(userbook())).toBe('/my-books/read/ub-1/chapter-5')
  })

  it('falls back to the detail screen when there is no chapter to resume', () => {
    expect(resumeRoute(edition({ chapterSlug: null }))).toBe('/book/dracula')
    expect(resumeRoute(userbook({ chapterSlug: null }))).toBe('/my-books/ub-1')
  })
})

/** The hero's Continue on a page:N upload (QA-007 RES-1); the screen wiring is pinned in the source. */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('heroResumeRoute', () => {
  // A test that fails on fake timers must not leave them to the next one.
  afterEach(() => { vi.useRealTimers() })

  it('QA-007 RES-1: Continue on a page:N upload opens the reader at the chapter holding the page; lookup failure → detail', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:42', updatedAtMs: 1 }
    const chapters = [
      { slug: 'intro', chapterNumber: 0, sourceStartPage: 1 },
      { slug: null, chapterNumber: 1, sourceStartPage: 30 },
      { slug: 'end', chapterNumber: 2, sourceStartPage: 60 },
    ]
    const none = async () => ({ chapters: [], totalChapters: 0 })
    expect(await heroResumeRoute(pick, { device: none, server: async () => chapters })).toBe('/my-books/read/ub1/chapter-1')
    expect(await heroResumeRoute(pick, { device: none, server: async () => { throw new Error('offline') } })).toBe('/my-books/ub1')
    expect(await heroResumeRoute(pick, { device: async () => { throw new Error('db') }, server: async () => { throw new Error('offline') } })).toBe('/my-books/ub1')
    // No lookup for anything else.
    const load = vi.fn()
    const loaders = { device: load, server: load }
    expect(await heroResumeRoute({ ...pick, chapterSlug: 'intro', locator: null }, loaders)).toBe('/my-books/read/ub1/intro')
    expect(await heroResumeRoute({ ...pick, locator: null }, loaders)).toBe('/my-books/ub1')
    expect(await heroResumeRoute({ type: 'edition', slug: 'dracula', title: 'D', coverPath: null, percent: 0.1, chapterSlug: null, updatedAtMs: 1 }, loaders)).toBe('/book/dracula')
    expect(load).not.toHaveBeenCalled()
    // The PDF reader restores the page itself when Continue opens the chapter holding it.
    expect(read('src/components/reader/useReaderPdf.ts')).toContain('resumePage: originalNewerPage?.page ?? originalResumePage')
    // Repeat taps ignored while the lookup runs (component-local).
    const hero = read('src/components/library/ResumeButton.tsx')
    expect(hero).toMatch(/if \(busyRef\.current\) return/)
    expect(hero).toContain('heroResumeRoute(pick')
  })

  it('QA-007 RES-1: a page:N locator beats a stale chapterSlug', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.5, chapterSlug: 'ch-2', locator: 'page:300', updatedAtMs: 1 }
    // ch-2 is stale (written earlier in reflow); page 300 lives in chapter 9.
    const chapters = Array.from({ length: 12 }, (_, i) => ({ slug: `ch-${i}`, sourceStartPage: i * 35 + 1 }))
    chapters[9].sourceStartPage = 290 // ch-9: 290..350
    expect(await heroResumeRoute(pick, { device: async () => ({ chapters, totalChapters: 12 }), server: vi.fn() })).toBe('/my-books/read/ub1/ch-9')
  })

  it('QA-007 RES-1: a failed lookup opens the detail screen, never a stale chapterSlug', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.5, chapterSlug: 'ch-2', locator: 'page:300', updatedAtMs: 1 }
    const failing = { device: async () => ({ chapters: [], totalChapters: 0 }), server: async () => { throw new Error('offline') } }
    expect(await heroResumeRoute(pick, failing)).toBe('/my-books/ub1')
  })

  it('QA-007 RES-1: the device answers first — chapters on the phone open the reader without asking the server', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:42', updatedAtMs: 1 }
    const server = vi.fn(async () => [])
    const device = vi.fn(async () => ({ chapters: [{ slug: 'intro', sourceStartPage: 1 }, { slug: 'chapter-1', sourceStartPage: 30 }], totalChapters: 2 }))
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/chapter-1')
    expect(device).toHaveBeenCalledWith('ub1')
    expect(server).not.toHaveBeenCalled()
    // ResumeButton wires the device loader to SQLite: chapters + the cached book meta's count.
    const hero = read('src/components/library/ResumeButton.tsx')
    expect(hero).toMatch(/listCachedUserChapterPages\(id\)/)
    expect(hero).toMatch(/getCachedUserBookMeta\(id\)/)
  })

  it('QA-007 RES-1: a partial device cache is not trusted — the server names the chapter', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:75', updatedAtMs: 1 }
    // Only ch0, ch1 downloaded of 4; page 75 lives in ch3.
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'ch1', sourceStartPage: 20 }], totalChapters: 4 })
    const server = vi.fn(async () => [
      { slug: 'ch0', chapterNumber: 0, sourceStartPage: 1 },
      { slug: 'ch1', chapterNumber: 1, sourceStartPage: 20 },
      { slug: 'ch2', chapterNumber: 2, sourceStartPage: 40 },
      { slug: 'ch3', chapterNumber: 3, sourceStartPage: 70 },
    ])
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch3')
    expect(server).toHaveBeenCalledWith('ub1')
  })

  it('QA-007 RES-1: the server lookup has a 3 s deadline → detail screen; the button shows busy meanwhile', async () => {
    vi.useFakeTimers()
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:75', updatedAtMs: 1 }
    const route = heroResumeRoute(pick, { device: async () => ({ chapters: [], totalChapters: 0 }), server: () => new Promise(() => {}) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await route).toBe('/my-books/ub1')
    vi.useRealTimers()
    const hero = read('src/components/library/ResumeButton.tsx')
    expect(hero).toMatch(/accessibilityState=\{\{ busy \}\}/)
    expect(hero).toMatch(/\{busy \? <ActivityIndicator/)
  })

  it('QA-007 RES-1: a device cache without page numbers falls through to the server', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:12', updatedAtMs: 1 }
    // Complete download, but rows cached from the chapter endpoint, which sends no sourceStartPage.
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: null }, { slug: 'ch1', sourceStartPage: null }], totalChapters: 2 })
    const server = vi.fn(async () => [{ slug: 'ch0', chapterNumber: 0, sourceStartPage: 1 }, { slug: 'ch1', chapterNumber: 1, sourceStartPage: 10 }])
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).toHaveBeenCalledWith('ub1')
  })

  it('QA-007 RES-1: caching an upload stores sourceStartPage from the chapter list, so the device alone places page N', async () => {
    // The download task carries the list's start page; the chapter endpoint does not send one.
    const dl = read('src/context/DownloadContext.tsx')
    expect(dl).toMatch(/number: ch\.chapterNumber,\s*sourceStartPage: ch\.sourceStartPage \?\? null,/)
    expect(dl).toContain('cacheUserChapter(info.editionId, { ...chapter, sourceStartPage: chapter.sourceStartPage ?? task.sourceStartPage ?? null }, task.number)')
    // The reader's own pre-cache does the same from its chapter list.
    expect(read('src/components/reader/useUserBookReaderSource.ts')).toMatch(/cacheUserChapter\(bookId, \{ \.\.\.ch, sourceStartPage: ch\.sourceStartPage \?\? row\?\.sourceStartPage \?\? null \}/)
    // A refresh from the chapter endpoint must not wipe the stored page.
    expect(read('src/lib/offlineDb.ts')).toContain('source_start_page = COALESCE(?, source_start_page)')
    // Those rows then answer the hero alone.
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:12', updatedAtMs: 1 }
    const server = vi.fn()
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'ch1', sourceStartPage: 10 }], totalChapters: 2 })
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).not.toHaveBeenCalled()
  })

  it('QA-007 RES-1: no navigation once the Continue button has lost focus or unmounted', () => {
    const hero = read('src/components/library/ResumeButton.tsx')
    expect(hero).toMatch(/useFocusEffect\(useCallback\(\(\) => \{\s*focusedRef\.current = true\s*return \(\) => \{ focusedRef\.current = false \}/)
    expect(hero).toMatch(/if \(focusedRef\.current\) router\.push\(route as never\)/)
  })

  it('QA-007 RES-1: a server lookup writes the start pages into the device cache, so the next offline Continue works', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:12', updatedAtMs: 1 }
    // A download made before start pages were stored: complete, no pages.
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: null }, { slug: 'chapter-1', sourceStartPage: null }], totalChapters: 2 })
    const server = async () => [{ slug: 'ch0', chapterNumber: 0, sourceStartPage: 1 }, { slug: null, chapterNumber: 1, sourceStartPage: 10 }]
    const remember = vi.fn(async () => {})
    expect(await heroResumeRoute(pick, { device, server, remember })).toBe('/my-books/read/ub1/chapter-1')
    expect(remember).toHaveBeenCalledWith('ub1', [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'chapter-1', sourceStartPage: 10 }])
    // A failing write never blocks the Continue.
    expect(await heroResumeRoute(pick, { device, server, remember: async () => { throw new Error('db') } })).toBe('/my-books/read/ub1/chapter-1')
    // The device answering alone writes nothing.
    remember.mockClear()
    await heroResumeRoute(pick, { device: async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }], totalChapters: 1 }), server, remember })
    expect(remember).not.toHaveBeenCalled()
    // Wiring: the hero hands them to SQLite, which only fills, never clears.
    expect(read('src/components/library/ResumeButton.tsx')).toMatch(/remember: storeCachedUserChapterStartPages/)
    expect(read('src/lib/offlineDb.ts')).toMatch(/UPDATE user_chapters SET source_start_page = \? WHERE book_id = \? AND chapter_slug = \? AND source_start_page IS NULL/)
    expect(read('src/lib/offlineDb.web.ts')).toContain('export async function storeCachedUserChapterStartPages')
  })

  it('QA-007 RES-1: unmeasured back matter on a complete download does not force the network — the device places page N', async () => {
    // Review r8: the server has null for these rows too, so asking it cannot do better, and offline it fails.
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:50', updatedAtMs: 1 }
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'ch1', sourceStartPage: 40 }, { slug: 'index', sourceStartPage: null }], totalChapters: 3 })
    const server = vi.fn(async () => { throw new Error('offline') })
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).not.toHaveBeenCalled()
  })

  it('QA-007 RES-1: a device cache with a chapter lacking a start page between paged ones asks the server', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:50', updatedAtMs: 1 }
    // Mixed old/new rows: ch1 cached before start pages were stored; page 50 lives in ch1 (starts 40).
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'ch1', sourceStartPage: null }, { slug: 'ch2', sourceStartPage: 80 }], totalChapters: 3 })
    const server = vi.fn(async () => [
      { slug: 'ch0', chapterNumber: 0, sourceStartPage: 1 },
      { slug: 'ch1', chapterNumber: 1, sourceStartPage: 40 },
      { slug: 'ch2', chapterNumber: 2, sourceStartPage: 80 },
    ])
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).toHaveBeenCalledWith('ub1')
  })

  it('QA-007 RES-1: unmeasured front matter on a complete download does not force the network — the device places page N', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:50', updatedAtMs: 1 }
    const server = vi.fn(async () => [])
    const device = async () => ({ chapters: [{ slug: 'cover', sourceStartPage: null }, { slug: 'ch0', sourceStartPage: 3 }, { slug: 'ch1', sourceStartPage: 40 }], totalChapters: 3 })
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).not.toHaveBeenCalled()
    // A complete download with no measured row at all still asks the server.
    const none = async () => ({ chapters: [{ slug: 'a', sourceStartPage: null }], totalChapters: 1 })
    await heroResumeRoute(pick, { device: none, server })
    expect(server).toHaveBeenCalledWith('ub1')
  })

  it('QA-007 RES-1: the hero reads only slug + start page from SQLite, with a web no-op twin', () => {
    const db = read('src/lib/offlineDb.ts')
    expect(db).toMatch(/export async function listCachedUserChapterPages\(bookId: string\)/)
    expect(db).toMatch(/SELECT chapter_slug, source_start_page FROM user_chapters WHERE book_id = \? ORDER BY COALESCE\(chapter_number, 999999\) ASC, cached_at ASC/)
    expect(read('src/lib/offlineDb.web.ts')).toContain('export async function listCachedUserChapterPages')
  })

  it('QA-007 RES-1: storing start pages is one transaction and skips rows that already have one', () => {
    const db = read('src/lib/offlineDb.ts')
    const fn = db.slice(db.indexOf('export async function storeCachedUserChapterStartPages'), db.indexOf('export async function listCachedUserChapters'))
    expect(fn).toMatch(/withTransactionAsync/)
    expect(fn).toMatch(/AND source_start_page IS NULL/)
    expect(fn).toMatch(/if \(c\.sourceStartPage == null\) continue/)
  })
})
