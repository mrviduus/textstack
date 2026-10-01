import { describe, it, expect } from 'vitest'
import {
  filterLibraryItems,
  filterUserBooks,
  countsForLibrary,
  countsForUploads,
} from '../useLibraryFilter'
import type { LibraryItem, ReadingProgressDto } from '../../api/auth'
import type { UserBook } from '../../api/userBooks'

const lib = (editionId: string, title: string): LibraryItem => ({
  editionId, slug: title.toLowerCase(), title, language: 'en', coverPath: null,
  createdAt: '2026-04-01T00:00:00Z', author: null,
})
const prog = (editionId: string, percent: number): ReadingProgressDto => ({
  editionId, chapterId: 'c1', chapterSlug: 'ch1', locator: '{}', percent, updatedAt: '2026-04-25T00:00:00Z',
})
const ub = (id: string, opts: Partial<UserBook> = {}): UserBook => ({
  id, title: id, slug: id, description: null, author: null, status: 'Ready', chapterCount: 1,
  createdAt: '2026-04-01T00:00:00Z', completedAt: null, errorMessage: null,
  language: 'en', coverPath: null, genre: null, totalWordCount: null,
  progressPercent: null, progressUpdatedAt: null, progressChapterSlug: null,
  ...opts,
})

describe('filterLibraryItems', () => {
  const items = [lib('a', 'A'), lib('b', 'B'), lib('c', 'C'), lib('d', 'D')]
  const pm: Record<string, ReadingProgressDto> = {
    a: prog('a', 0),       // not started
    b: prog('b', 0.5),     // reading
    c: prog('c', 0.99),    // finished
    // d: no entry → 0 → not started
  }

  it('all returns full list', () => {
    expect(filterLibraryItems(items, 'all', pm).map(i => i.editionId)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('reading: 0 < p < 0.95', () => {
    expect(filterLibraryItems(items, 'reading', pm).map(i => i.editionId)).toEqual(['b'])
  })
  it('finished: p >= 0.95', () => {
    expect(filterLibraryItems(items, 'finished', pm).map(i => i.editionId)).toEqual(['c'])
  })
  it('notStarted: p === 0 (incl. missing)', () => {
    expect(filterLibraryItems(items, 'notStarted', pm).map(i => i.editionId)).toEqual(['a', 'd'])
  })
  it('failed: empty (saved books cannot fail)', () => {
    expect(filterLibraryItems(items, 'failed', pm)).toEqual([])
  })
})

describe('filterUserBooks', () => {
  const books: UserBook[] = [
    ub('1', { status: 'Ready', progressPercent: 0 }),
    ub('2', { status: 'Ready', progressPercent: 0.5 }),
    ub('3', { status: 'Ready', progressPercent: 0.99 }),
    ub('4', { status: 'Ready', completedAt: '2026-04-20T00:00:00Z', progressPercent: 1 }),
    ub('5', { status: 'Failed', errorMessage: 'parse error' }),
    ub('6', { status: 'Processing' }),
  ]

  it('reading excludes Failed/Processing/Finished', () => {
    expect(filterUserBooks(books, 'reading').map(b => b.id)).toEqual(['2'])
  })
  it('finished includes completedAt OR p>=0.95', () => {
    expect(filterUserBooks(books, 'finished').map(b => b.id).sort()).toEqual(['3', '4'])
  })
  it('notStarted: Ready, not completed, p=0', () => {
    expect(filterUserBooks(books, 'notStarted').map(b => b.id)).toEqual(['1'])
  })
  it('failed: status Failed only', () => {
    expect(filterUserBooks(books, 'failed').map(b => b.id)).toEqual(['5'])
  })
})

describe('counts', () => {
  it('countsForLibrary always reflects full list', () => {
    const items = [lib('a', 'A'), lib('b', 'B'), lib('c', 'C')]
    const pm = { a: prog('a', 0.5), b: prog('b', 0.99), c: prog('c', 0) }
    expect(countsForLibrary(items, pm)).toEqual({ all: 3, reading: 1, finished: 1, notStarted: 1, failed: 0 })
  })
  it('countsForUploads reflects full list incl. failed', () => {
    const books: UserBook[] = [
      ub('1', { status: 'Ready', progressPercent: 0.5 }),
      ub('2', { status: 'Failed' }),
      ub('3', { status: 'Ready', completedAt: '2026-04-20T00:00:00Z', progressPercent: 1 }),
    ]
    expect(countsForUploads(books)).toEqual({ all: 3, reading: 1, finished: 1, notStarted: 0, failed: 1 })
  })
})
