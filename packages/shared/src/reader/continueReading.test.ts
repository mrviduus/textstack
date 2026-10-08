import { describe, it, expect } from 'vitest'
import { pickContinueReadingBook, type LocalProgressLite, type UserBookProgressLite } from './continueReading'
import type { UserLibraryItem, ReadingProgressDto, UserBookDto } from '../types/api'

// --- Fixtures ----------------------------------------------------------

const lib = (overrides: Partial<UserLibraryItem> = {}): UserLibraryItem => ({
  editionId: 'ed-1',
  slug: 'dracula',
  title: 'Dracula',
  language: 'en',
  coverPath: '/covers/dracula.jpg',
  createdAt: '2026-01-01T00:00:00Z',
  author: 'Bram Stoker',
  ...overrides,
})

const srvProg = (overrides: Partial<ReadingProgressDto> = {}): ReadingProgressDto => ({
  editionId: 'ed-1',
  chapterId: 'ch-1',
  chapterSlug: 'chapter-1',
  percent: 0.3,
  updatedAt: '2026-05-01T10:00:00Z',
  ...overrides,
} as ReadingProgressDto)

const ub = (overrides: Partial<UserBookDto> = {}): UserBookDto => ({
  id: 'ub-1',
  title: 'Selected Camus',
  author: 'Camus',
  language: 'ru',
  coverPath: null,
  genre: null,
  totalWordCount: 100_000,
  status: 'ready',
  chapterCount: 12,
  createdAt: '2026-04-01T00:00:00Z',
  completedAt: null,
  errorMessage: null,
  progressPercent: 0.25,
  progressUpdatedAt: '2026-05-10T12:00:00Z',
  progressChapterSlug: 'part-3',
  ...overrides,
})

const emptyLocal = new Map<string, LocalProgressLite>()
const emptyUb = new Map<string, UserBookProgressLite>()

// --- Degenerate inputs -------------------------------------------------

describe('pickContinueReadingBook — empty / no-data inputs', () => {
  it('returns null when everything is empty', () => {
    expect(pickContinueReadingBook({
      library: [], serverProgress: [], userBooks: [],
      localCatalogMap: emptyLocal, localUserBookMap: emptyUb,
    })).toBeNull()
  })

  it('returns null when library has books but no progress data', () => {
    expect(pickContinueReadingBook({
      library: [lib()], serverProgress: [], userBooks: [],
      localCatalogMap: emptyLocal, localUserBookMap: emptyUb,
    })).toBeNull()
  })

  it('excludes a finished catalog book, from either source', () => {
    // `ReadingProgress.Percent` now spans the whole book from every writer, so
    // 1.0 means finished. It used to be a chapter fraction from mobile and a
    // book fraction from web, which forced this function to track the source
    // and refuse to trust a server 1.0 — a chapter fraction reaches 1.0 at the
    // bottom of every chapter.
    expect(pickContinueReadingBook({
      library: [lib()], serverProgress: [srvProg({ percent: 1 })], userBooks: [],
      localCatalogMap: emptyLocal, localUserBookMap: emptyUb,
    })).toBeNull()

    const localFinished = new Map<string, LocalProgressLite>([
      ['ed-1', { chapterSlug: 'chapter-1', percent: 1, bookPercent: 1, updatedAt: Date.parse('2026-05-02T10:00:00Z') }],
    ])
    expect(pickContinueReadingBook({
      library: [lib()], serverProgress: [srvProg({ percent: 0.3 })], userBooks: [],
      localCatalogMap: localFinished, localUserBookMap: emptyUb,
    })).toBeNull()
  })

  it('excludes finished user-books', () => {
    expect(pickContinueReadingBook({
      library: [], serverProgress: [], userBooks: [ub({ progressPercent: 1 })],
      localCatalogMap: emptyLocal, localUserBookMap: emptyUb,
    })).toBeNull()
  })

  it('excludes non-ready user-books (status=processing)', () => {
    expect(pickContinueReadingBook({
      library: [], serverProgress: [], userBooks: [ub({ status: 'processing' })],
      localCatalogMap: emptyLocal, localUserBookMap: emptyUb,
    })).toBeNull()
  })

  it('excludes user-books with null progress timestamp', () => {
    expect(pickContinueReadingBook({
      library: [], serverProgress: [], userBooks: [ub({ progressUpdatedAt: null })],
      localCatalogMap: emptyLocal, localUserBookMap: emptyUb,
    })).toBeNull()
  })
})

// --- Catalog books -----------------------------------------------------

describe('pickContinueReadingBook — catalog books', () => {
  it('returns the only in-progress catalog book', () => {
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ percent: 0.35 })],
      userBooks: [],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r?.type).toBe('edition')
    expect(r?.percent).toBeCloseTo(0.35)
    if (r?.type === 'edition') expect(r.slug).toBe('dracula')
  })

  it('prefers an unsynced local record (offline read)', () => {
    const local: LocalProgressLite = {
      chapterSlug: 'chapter-2', percent: 0.6, bookPercent: 0.55,
      updatedAt: Date.parse('2026-05-02T10:00:00Z'), // newer than server
    }
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ percent: 0.3 })],
      userBooks: [],
      localCatalogMap: new Map([['ed-1', local]]),
      localUserBookMap: emptyUb,
    })
    expect(r?.percent).toBeCloseTo(0.55) // prefers bookPercent over percent
    expect(r?.chapterSlug).toBe('chapter-2')
  })

  it('never substitutes the chapter fraction when the cached book percent is missing', () => {
    // `local.percent` is the within-chapter scroll fraction kept for resume. It
    // used to be shown as the book percent whenever `bookPercent` was absent,
    // which is how a book a fifth read could display "60% complete". A cache
    // entry with no book-wide value simply has nothing to show.
    const local: LocalProgressLite = {
      chapterSlug: 'chapter-2', percent: 0.6,
      updatedAt: Date.parse('2026-05-02T10:00:00Z'),
    }
    expect(pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ percent: 0.3 })],
      userBooks: [],
      localCatalogMap: new Map([['ed-1', local]]),
      localUserBookMap: emptyUb,
    })).toBeNull()
  })

  it('prefers server when its CLIENT stamp is newer, even over an unsynced local (web moved on)', () => {
    const local: LocalProgressLite = {
      chapterSlug: 'chapter-OLD', percent: 0.4, bookPercent: 0.35,
      updatedAt: Date.parse('2026-05-01T08:00:00Z'),
    }
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({
        percent: 0.5, chapterSlug: 'chapter-NEW',
        updatedAt: '2026-05-02T12:00:00Z', clientUpdatedAt: '2026-05-02T11:59:59Z',
      })],
      userBooks: [],
      localCatalogMap: new Map([['ed-1', local]]),
      localUserBookMap: emptyUb,
    })
    expect(r?.percent).toBeCloseTo(0.5)
    expect(r?.chapterSlug).toBe('chapter-NEW')
  })

  it('a synced local record never overrides the server percent, even on the same chapter', () => {
    // It used to be swapped in "for better UX" — which showed this device's
    // older value over the one another device had since written.
    const local: LocalProgressLite = {
      chapterSlug: 'chapter-1', percent: 0.4, bookPercent: 0.28,
      updatedAt: Date.parse('2026-05-01T08:00:00Z'), synced: true,
    }
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ percent: 0.5, chapterSlug: 'chapter-1' })],
      userBooks: [],
      localCatalogMap: new Map([['ed-1', local]]),
      localUserBookMap: emptyUb,
    })
    expect(r?.percent).toBeCloseTo(0.5)
  })

  it('compares the local stamp with the server CLIENT stamp, not the server-clock updatedAt', () => {
    // Device clock an hour behind the server: the row's updatedAt (server clock) is
    // "later" than the local record, but the write it holds was recorded before it.
    const local: LocalProgressLite = {
      chapterSlug: 'chapter-2', percent: 0.6, bookPercent: 0.55,
      updatedAt: Date.parse('2026-05-01T09:30:00Z'), synced: true,
    }
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ percent: 0.3, updatedAt: '2026-05-01T10:00:00Z', clientUpdatedAt: '2026-05-01T09:00:00Z' })],
      userBooks: [],
      localCatalogMap: new Map([['ed-1', local]]),
      localUserBookMap: emptyUb,
    })
    expect(r?.percent).toBeCloseTo(0.55)
    expect(r?.chapterSlug).toBe('chapter-2')
  })

  it('does NOT swap in local bookPercent when chapters differ', () => {
    const local: LocalProgressLite = {
      chapterSlug: 'chapter-3', percent: 0.4, bookPercent: 0.7,
      updatedAt: Date.parse('2026-05-01T08:00:00Z'), synced: true,
    }
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ percent: 0.5, chapterSlug: 'chapter-1' })],
      userBooks: [],
      localCatalogMap: new Map([['ed-1', local]]),
      localUserBookMap: emptyUb,
    })
    expect(r?.percent).toBeCloseTo(0.5) // server wins, no chapter match
  })
})

// --- User books --------------------------------------------------------

describe('pickContinueReadingBook — user books', () => {
  it('returns the only in-progress user book', () => {
    const r = pickContinueReadingBook({
      library: [], serverProgress: [],
      userBooks: [ub({ progressPercent: 0.42 })],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r?.type).toBe('userbook')
    expect(r?.percent).toBeCloseTo(0.42)
  })

  it('prefers an unsynced local bookPercent', () => {
    const ubMs = Date.parse('2026-05-10T12:00:00Z')
    const localUb: UserBookProgressLite = {
      bookPercent: 0.31,
      updatedAt: ubMs - 30_000, // 30s earlier — within 60s grace
    }
    const r = pickContinueReadingBook({
      library: [], serverProgress: [],
      userBooks: [ub({ progressPercent: 0.5 })], // chapter % from server
      localCatalogMap: emptyLocal,
      localUserBookMap: new Map([['ub-1', localUb]]),
    })
    expect(r?.percent).toBeCloseTo(0.31) // local wins
  })

  it('RES-1: a winning local record supplies the locator (its page), not the server row', () => {
    const T = Date.parse('2026-05-10T12:00:00Z')
    const pick = (local: UserBookProgressLite) => pickContinueReadingBook({
      library: [], serverProgress: [],
      userBooks: [ub({ progressChapterSlug: null, progressLocator: 'page:10' })],
      localCatalogMap: emptyLocal,
      localUserBookMap: new Map([['ub-1', local]]),
    })
    const p1 = pick({ bookPercent: 0.4, updatedAt: T, page: 75 })
    expect(p1?.type === 'userbook' && p1.locator).toBe('page:75')
    // No page on the local record → the server locator stays.
    const p2 = pick({ bookPercent: 0.4, updatedAt: T })
    expect(p2?.type === 'userbook' && p2.locator).toBe('page:10')
    // Local loses (synced) → server locator.
    const p3 = pick({ bookPercent: 0.4, updatedAt: T, page: 75, synced: true })
    expect(p3?.type === 'userbook' && p3.locator).toBe('page:10')
  })

  it('RES-1: a winning local record in text mode resumes at its chapterSlug; a page-mode one at its page', () => {
    const T = Date.parse('2026-05-10T12:00:00Z')
    const pick = (local: UserBookProgressLite) => pickContinueReadingBook({
      library: [], serverProgress: [],
      userBooks: [ub({ progressChapterSlug: 'ch-1', progressLocator: 'page:10' })],
      localCatalogMap: emptyLocal,
      localUserBookMap: new Map([['ub-1', local]]),
    })
    // Text mode (a chapter slug; a kept page beside it is the Original viewer's, not this record's).
    const text = pick({ bookPercent: 0.4, updatedAt: T, chapterSlug: 'ch-4', page: 75 })
    expect(text?.type === 'userbook' && text.chapterSlug).toBe('ch-4')
    expect(text?.type === 'userbook' && text.locator).toBeNull()
    // Page mode (no slug) → the local page, never the server's stale chapter.
    const page = pick({ bookPercent: 0.4, updatedAt: T, chapterSlug: null, page: 75 })
    expect(page?.type === 'userbook' && page.chapterSlug).toBeNull()
    expect(page?.type === 'userbook' && page.locator).toBe('page:75')
    // Local loses → the server's chapter and locator.
    const lost = pick({ bookPercent: 0.4, updatedAt: T, chapterSlug: 'ch-4', synced: true })
    expect(lost?.type === 'userbook' && lost.chapterSlug).toBe('ch-1')
  })

  it('falls back to server progressPercent when the local record is synced', () => {
    const ubMs = Date.parse('2026-05-10T12:00:00Z')
    const localUb: UserBookProgressLite = {
      bookPercent: 0.31,
      updatedAt: ubMs + 90_000, // ahead of the server clock — irrelevant, it is not compared
      synced: true,
    }
    const r = pickContinueReadingBook({
      library: [], serverProgress: [],
      userBooks: [ub({ progressPercent: 0.5 })],
      localCatalogMap: emptyLocal,
      localUserBookMap: new Map([['ub-1', localUb]]),
    })
    expect(r?.percent).toBeCloseTo(0.5)
  })

  it('a fast clock does not let a synced local record beat its own clamped server row', () => {
    const T = Date.parse('2026-05-10T12:00:00Z')
    const localUb: UserBookProgressLite = { bookPercent: 0.31, updatedAt: T + 3_600_000, synced: true }
    const r = pickContinueReadingBook({
      library: [], serverProgress: [],
      userBooks: [ub({
        progressPercent: 0.5,
        progressUpdatedAt: new Date(T).toISOString(),
        progressClientUpdatedAt: new Date(T + 5 * 60_000).toISOString(),
      })],
      localCatalogMap: emptyLocal,
      localUserBookMap: new Map([['ub-1', localUb]]),
    })
    expect(r?.percent).toBeCloseTo(0.5)
  })

  it('a newer write from another device beats an unsynced local record', () => {
    const localUb: UserBookProgressLite = { bookPercent: 0.31, updatedAt: Date.parse('2026-05-10T11:00:00Z') }
    const r = pickContinueReadingBook({
      library: [], serverProgress: [],
      userBooks: [ub({ progressPercent: 0.5, progressClientUpdatedAt: '2026-05-10T11:30:00Z' })],
      localCatalogMap: emptyLocal,
      localUserBookMap: new Map([['ub-1', localUb]]),
    })
    expect(r?.percent).toBeCloseTo(0.5)
  })

  it('falls back to server when no local cache exists', () => {
    const r = pickContinueReadingBook({
      library: [], serverProgress: [],
      userBooks: [ub({ progressPercent: 0.5 })],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r?.percent).toBeCloseTo(0.5)
  })

  it('preserves null title with Untitled fallback', () => {
    const r = pickContinueReadingBook({
      library: [], serverProgress: [],
      userBooks: [ub({ title: null })],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r?.title).toBe('Untitled')
  })
})

// --- Mixed: catalog vs user-book ---------------------------------------

describe('pickContinueReadingBook — mixed sources', () => {
  it('returns the most-recently-updated book across both sources (catalog wins)', () => {
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ updatedAt: '2026-06-01T10:00:00Z', percent: 0.3 })],
      userBooks: [ub({ progressUpdatedAt: '2026-05-10T12:00:00Z' })],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r?.type).toBe('edition')
  })

  it('returns the most-recently-updated book across both sources (user-book wins)', () => {
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ updatedAt: '2026-05-01T10:00:00Z', percent: 0.3 })],
      userBooks: [ub({ progressUpdatedAt: '2026-06-15T12:00:00Z' })],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r?.type).toBe('userbook')
  })

  it('returns the more-recent of multiple catalog books', () => {
    const r = pickContinueReadingBook({
      library: [lib(), lib({ editionId: 'ed-2', slug: 'ulysses', title: 'Ulysses' })],
      serverProgress: [
        srvProg({ editionId: 'ed-1', updatedAt: '2026-05-01T10:00:00Z', percent: 0.3 }),
        srvProg({ editionId: 'ed-2', updatedAt: '2026-06-01T10:00:00Z', percent: 0.7 }),
      ],
      userBooks: [],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r?.type).toBe('edition')
    if (r?.type === 'edition') expect(r.slug).toBe('ulysses')
  })

  it('books not in library are ignored even if they have progress', () => {
    // Server may have stale progress rows for books the user removed
    // from library — never surface those.
    const r = pickContinueReadingBook({
      library: [], // empty library
      serverProgress: [srvProg({ percent: 0.5 })],
      userBooks: [],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r).toBeNull()
  })

  it('books in library but with no progress in any source → not picked', () => {
    const r = pickContinueReadingBook({
      library: [lib({ editionId: 'ed-NEVER-READ' })],
      serverProgress: [],
      userBooks: [],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r).toBeNull()
  })
})

describe('pickContinueReadingBook — malformed timestamps', () => {
  it('treats unparseable user-book timestamp as never-updated', () => {
    // Date.parse returns NaN for garbage — must not crash, must not be picked.
    const r = pickContinueReadingBook({
      library: [],
      serverProgress: [],
      userBooks: [ub({ progressUpdatedAt: 'not-a-date' })],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r).toBeNull()
  })

  it('treats unparseable catalog server.updatedAt as never-updated', () => {
    // Same defense for catalog path — server may return garbage on a
    // corrupted row or under partial outages. picker must not pick it.
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ updatedAt: 'not-a-date' as unknown as string })],
      userBooks: [],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r).toBeNull()
  })

  it('falls through to local when server timestamp is unparseable', () => {
    // Catalog has bad server timestamp BUT valid local — local should win
    // because parseDate(server) = 0 < parseDate(local).
    const local: LocalProgressLite = {
      chapterSlug: 'chapter-3', percent: 0.4, bookPercent: 0.4,
      updatedAt: Date.parse('2026-05-15T10:00:00Z'),
    }
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ updatedAt: 'corrupt-date' as unknown as string, percent: 0.5 })],
      userBooks: [],
      localCatalogMap: new Map([['ed-1', local]]),
      localUserBookMap: emptyUb,
    })
    expect(r?.percent).toBeCloseTo(0.4)
    expect(r?.chapterSlug).toBe('chapter-3')
  })

  it('empty-string server timestamp behaves the same as missing', () => {
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ updatedAt: '' as unknown as string })],
      userBooks: [],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r).toBeNull()
  })

  it('accepts numeric epoch ms timestamps (backend serializer drift)', () => {
    // Some backend serializers emit DateTime as epoch ms (.NET via
    // certain System.Text.Json converters). The picker must not silently
    // ignore those — parseEpochMs handles both string and number forms.
    const ts = Date.parse('2026-06-01T10:00:00Z')
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ updatedAt: ts as unknown as string, percent: 0.42 })],
      userBooks: [],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r?.percent).toBeCloseTo(0.42)
    expect(r?.updatedAtMs).toBe(ts)
  })

  it('rejects zero / negative epoch ms numbers', () => {
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ updatedAt: 0 as unknown as string })],
      userBooks: [],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r).toBeNull()
  })

  it('rejects NaN / Infinity epoch ms numbers', () => {
    const r = pickContinueReadingBook({
      library: [lib()],
      serverProgress: [srvProg({ updatedAt: Infinity as unknown as string })],
      userBooks: [],
      localCatalogMap: emptyLocal,
      localUserBookMap: emptyUb,
    })
    expect(r).toBeNull()
  })
})
