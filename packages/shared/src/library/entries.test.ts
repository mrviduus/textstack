import { describe, it, expect } from 'vitest'
import {
  buildLibraryEntries,
  entryKey,
  entryTitle,
  entryAuthor,
  entryProgress,
  entryNeedsAttention,
  matchesStatus,
  filterEntries,
  countEntries,
  sortEntries,
  parseOpenedAt,
  withOpened,
  MAX_OPENED_MARKS,
  FINISHED_THRESHOLD,
  type LibraryEntry,
} from './entries'
import type { UserLibraryItem, UserBookDto, ReadingProgressDto } from '../types/api'

const saved = (o: Partial<UserLibraryItem> = {}): UserLibraryItem => ({
  editionId: 'ed-1',
  slug: 'dracula',
  title: 'Dracula',
  language: 'en',
  coverPath: null,
  createdAt: '2026-01-01T00:00:00Z',
  author: 'Bram Stoker',
  ...o,
})

const upload = (o: Partial<UserBookDto> = {}): UserBookDto => ({
  id: 'ub-1',
  title: 'Designing Data-Intensive Applications',
  author: 'Martin Kleppmann',
  language: 'en',
  coverPath: null,
  genre: null,
  totalWordCount: 210000,
  status: 'ready',
  chapterCount: 12,
  createdAt: '2026-02-01T00:00:00Z',
  completedAt: null,
  errorMessage: null,
  progressPercent: 0.4,
  progressUpdatedAt: '2026-06-01T00:00:00Z',
  progressChapterSlug: 'ch-5',
  ...o,
})

const S = (o?: Partial<UserLibraryItem>): LibraryEntry => ({ kind: 'saved', item: saved(o) })
const U = (o?: Partial<UserBookDto>): LibraryEntry => ({ kind: 'upload', book: upload(o) })

const progress = (
  entries: Record<string, Partial<ReadingProgressDto>> = {},
): Record<string, ReadingProgressDto> => {
  const out: Record<string, ReadingProgressDto> = {}
  for (const [k, v] of Object.entries(entries)) {
    out[k] = { editionId: k, chapterId: 'c', chapterSlug: 's', percent: 0, updatedAt: '2026-01-01T00:00:00Z', ...v } as ReadingProgressDto
  }
  return out
}

const noProgress = progress()

describe('buildLibraryEntries', () => {
  it('interleaves both storage shapes into one list', () => {
    const e = buildLibraryEntries([saved()], [upload()], 'all')
    expect(e.map(x => x.kind)).toEqual(['saved', 'upload'])
  })

  it('applies source as a filter, not as navigation', () => {
    expect(buildLibraryEntries([saved()], [upload()], 'uploads').map(x => x.kind)).toEqual(['upload'])
    expect(buildLibraryEntries([saved()], [upload()], 'catalog').map(x => x.kind)).toEqual(['saved'])
  })

  it('defaults to everything', () => {
    expect(buildLibraryEntries([saved()], [upload()])).toHaveLength(2)
  })
})

describe('entryKey', () => {
  it('prefixes by kind so an edition id cannot collide with a book id', () => {
    // Both lists are now one FlatList; a duplicate key silently drops a row.
    expect(entryKey(S({ editionId: 'x' }))).toBe('saved:x')
    expect(entryKey(U({ id: 'x' }))).toBe('upload:x')
    expect(entryKey(S({ editionId: 'x' }))).not.toBe(entryKey(U({ id: 'x' })))
  })
})

describe('accessors read both shapes', () => {
  it('title and author', () => {
    expect(entryTitle(S())).toBe('Dracula')
    expect(entryTitle(U())).toBe('Designing Data-Intensive Applications')
    expect(entryAuthor(S())).toBe('Bram Stoker')
    expect(entryAuthor(U())).toBe('Martin Kleppmann')
  })

  it('coerces a missing title or author to an empty string, never null', () => {
    expect(entryTitle(U({ title: null }))).toBe('')
    expect(entryAuthor(S({ author: null }))).toBe('')
  })

  it('progress: catalog from the map, upload from the record', () => {
    expect(entryProgress(S(), progress({ 'ed-1': { percent: 0.25 } }))).toBe(0.25)
    expect(entryProgress(U({ progressPercent: 0.8 }), noProgress)).toBe(0.8)
  })

  it('progress is 0, not NaN, when there is no record at all', () => {
    expect(entryProgress(S(), noProgress)).toBe(0)
    expect(entryProgress(U({ progressPercent: null }), noProgress)).toBe(0)
  })
})

describe('entryNeedsAttention', () => {
  it('is true only for an upload that is not ready', () => {
    expect(entryNeedsAttention(U({ status: 'Processing' }))).toBe(true)
    expect(entryNeedsAttention(U({ status: 'Failed' }))).toBe(true)
    expect(entryNeedsAttention(U({ status: 'ready' }))).toBe(false)
    expect(entryNeedsAttention(U({ status: 'Completed' }))).toBe(false)
    // A catalog book was parsed long before this user saw it.
    expect(entryNeedsAttention(S())).toBe(false)
  })
})

describe('matchesStatus', () => {
  it('reading means started but not finished, for both kinds', () => {
    expect(matchesStatus(S(), 'reading', progress({ 'ed-1': { percent: 0.3 } }))).toBe(true)
    expect(matchesStatus(U({ progressPercent: 0.3 }), 'reading', noProgress)).toBe(true)
    expect(matchesStatus(S(), 'reading', progress({ 'ed-1': { percent: 0 } }))).toBe(false)
  })

  it('treats the last 5% as finished', () => {
    expect(matchesStatus(S(), 'finished', progress({ 'ed-1': { percent: FINISHED_THRESHOLD } }))).toBe(true)
    expect(matchesStatus(S(), 'reading', progress({ 'ed-1': { percent: FINISHED_THRESHOLD } }))).toBe(false)
  })

  it('honours an explicit completedAt even at low progress', () => {
    expect(matchesStatus(U({ completedAt: '2026-06-02T00:00:00Z', progressPercent: 0.2 }), 'finished', noProgress)).toBe(true)
    expect(matchesStatus(U({ completedAt: '2026-06-02T00:00:00Z', progressPercent: 0.2 }), 'reading', noProgress)).toBe(false)
  })

  it('never reports an unfinished upload as reading while it is still processing', () => {
    expect(matchesStatus(U({ status: 'Processing', progressPercent: 0.5 }), 'reading', noProgress)).toBe(false)
    expect(matchesStatus(U({ status: 'Processing' }), 'notStarted', noProgress)).toBe(false)
  })

  it('failed applies to uploads only — a catalog book cannot fail for a user', () => {
    expect(matchesStatus(U({ status: 'Failed' }), 'failed', noProgress)).toBe(true)
    expect(matchesStatus(S(), 'failed', noProgress)).toBe(false)
  })

  it('all matches everything, including a failed upload', () => {
    expect(matchesStatus(U({ status: 'Failed' }), 'all', noProgress)).toBe(true)
    expect(matchesStatus(S(), 'all', noProgress)).toBe(true)
  })
})

describe('countEntries', () => {
  it('counts across both kinds in one pass', () => {
    const entries = [
      S({ editionId: 'ed-1' }),
      S({ editionId: 'ed-2' }),
      U({ id: 'a', progressPercent: 0.5 }),
      U({ id: 'b', progressPercent: 0 }),
      U({ id: 'c', status: 'Failed' }),
    ]
    const counts = countEntries(entries, progress({ 'ed-1': { percent: 0.6 }, 'ed-2': { percent: 1 } }))
    expect(counts.all).toBe(5)
    expect(counts.reading).toBe(2)   // ed-1, upload a
    expect(counts.finished).toBe(1)  // ed-2
    expect(counts.notStarted).toBe(1)// upload b
    expect(counts.failed).toBe(1)    // upload c
  })

  it('is all zeroes but `all` for an empty library', () => {
    expect(countEntries([], noProgress)).toEqual({ all: 0, reading: 0, finished: 0, notStarted: 0, failed: 0 })
  })

  it('agrees with filterEntries for every status', () => {
    const entries = [S({ editionId: 'ed-1' }), U({ id: 'a', status: 'Failed' }), U({ id: 'b', progressPercent: 0.2 })]
    const map = progress({ 'ed-1': { percent: 0.99 } })
    const counts = countEntries(entries, map)
    for (const status of ['all', 'reading', 'finished', 'notStarted', 'failed'] as const) {
      expect(filterEntries(entries, status, map)).toHaveLength(counts[status])
    }
  })
})

describe('sortEntries', () => {
  it('pins books that need attention to the top, whatever the sort key', () => {
    // A failed upload the reader never sees is a failed upload they never retry.
    const entries = [
      U({ id: 'ok', title: 'AAA', status: 'ready' }),
      U({ id: 'bad', title: 'ZZZ', status: 'Failed' }),
    ]
    for (const key of ['recent', 'added', 'title', 'author', 'progress'] as const) {
      expect(sortEntries(entries, key, noProgress)[0].kind === 'upload'
        && (sortEntries(entries, key, noProgress)[0] as any).book.id).toBe('bad')
    }
  })

  it('sorts by title across both kinds', () => {
    const entries = [U({ title: 'Zebra' }), S({ title: 'Apple' })]
    expect(sortEntries(entries, 'title', noProgress).map(entryTitle)).toEqual(['Apple', 'Zebra'])
  })

  it('sends unknown authors to the end instead of clustering them first', () => {
    const entries = [S({ editionId: 'a', author: null }), S({ editionId: 'b', author: 'Borges' })]
    expect(sortEntries(entries, 'author', noProgress).map(entryAuthor)).toEqual(['Borges', ''])
  })

  it('sorts by most-recently-active across both kinds', () => {
    const entries = [
      S({ editionId: 'ed-old' }),
      U({ id: 'fresh', progressUpdatedAt: '2026-07-01T00:00:00Z' }),
    ]
    const map = progress({ 'ed-old': { updatedAt: '2026-03-01T00:00:00Z' } })
    expect(sortEntries(entries, 'recent', map).map(entryKey)).toEqual(['upload:fresh', 'saved:ed-old'])
  })

  it('a reader reopens an older upload on this device: it is first in Recently opened, no write needed', () => {
    const entries = [
      U({ id: 'newer', progressUpdatedAt: '2026-07-01T00:00:00Z' }),
      U({ id: 'reopened', progressUpdatedAt: '2026-03-01T00:00:00Z' }),
    ]
    const marks = parseOpenedAt(withOpened('{"x": "junk"}', 'reopened', Date.parse('2026-08-01T00:00:00Z')))
    expect(sortEntries(entries, 'recent', noProgress, marks).map(entryKey)).toEqual(['upload:reopened', 'upload:newer'])
  })

  it('opening more books than the marks keep forgets the oldest opens', () => {
    let json: string | null = null
    for (let i = 0; i <= MAX_OPENED_MARKS; i++) json = withOpened(json, `b${i}`, 1_000 + i)
    const marks = parseOpenedAt(json)
    expect(Object.keys(marks)).toHaveLength(MAX_OPENED_MARKS)
    expect(marks.b0).toBeUndefined()
    expect(marks[`b${MAX_OPENED_MARKS}`]).toBe(1_000 + MAX_OPENED_MARKS)
  })

  it('falls back to created time for a book never opened', () => {
    const entries = [
      S({ editionId: 'ed-new', createdAt: '2026-08-01T00:00:00Z' }),
      U({ id: 'ub-old', progressUpdatedAt: null, createdAt: '2026-01-01T00:00:00Z' }),
    ]
    expect(sortEntries(entries, 'recent', noProgress).map(entryKey)).toEqual(['saved:ed-new', 'upload:ub-old'])
  })

  it('sorts by progress descending', () => {
    const entries = [U({ id: 'low', progressPercent: 0.1 }), U({ id: 'high', progressPercent: 0.9 })]
    expect(sortEntries(entries, 'progress', noProgress).map(entryKey)).toEqual(['upload:high', 'upload:low'])
  })

  it('does not mutate its input', () => {
    const entries = [U({ id: 'b', title: 'B' }), U({ id: 'a', title: 'A' })]
    const before = entries.map(entryKey)
    sortEntries(entries, 'title', noProgress)
    expect(entries.map(entryKey)).toEqual(before)
  })

  it('tolerates unparseable timestamps rather than producing NaN ordering', () => {
    const entries = [U({ id: 'junk', progressUpdatedAt: 'not-a-date', createdAt: 'also-bad' }), U({ id: 'good' })]
    expect(sortEntries(entries, 'recent', noProgress).map(entryKey)).toEqual(['upload:good', 'upload:junk'])
  })
})
