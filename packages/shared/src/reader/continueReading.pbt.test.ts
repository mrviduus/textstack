import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { rankContinueReading, type LocalProgressLite, type UserBookProgressLite } from './continueReading'
import type { UserLibraryItem, ReadingProgressDto, UserBookDto } from '../types/api'

/**
 * Property-based tests for `rankContinueReading` (every entry, not just the head).
 *
 * Hand-crafted tests (`continueReading.test.ts`) cover named scenarios.
 * These tests generate thousands of random input combos and verify
 * INVARIANTS that must hold across all of them — catches the long tail
 * of "weird real-world data" that no human would think to enumerate.
 *
 * Invariants checked:
 *   1. The head has the LATEST updatedAtMs and the list is sorted newest first.
 *   2. No ranked book is finished (percent < 1).
 *   3. Catalog books not in library are never ranked.
 *   4. Non-ready user-books are never ranked.
 *   5. Function never throws on any input shape.
 */

// --- Arbitraries -------------------------------------------------------

const arbIsoDate = fc.integer({ min: 1_577_836_800_000, max: 1_924_991_999_000 }) // 2020..2030
  .map(ms => new Date(ms).toISOString())

const arbLibraryItem = fc.record({
  editionId: fc.uuid(),
  slug: fc.string({ minLength: 3, maxLength: 30 }).filter(s => /^[a-z0-9-]+$/.test(s) || s.length > 0),
  title: fc.string({ minLength: 1, maxLength: 80 }),
  language: fc.constantFrom('en', 'uk', 'ru', 'de'),
  coverPath: fc.option(fc.string({ minLength: 5, maxLength: 50 }), { nil: null }),
  createdAt: arbIsoDate,
  author: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
}) satisfies fc.Arbitrary<UserLibraryItem>

const arbServerProgress = (editionId: string): fc.Arbitrary<ReadingProgressDto> => fc.record({
  editionId: fc.constant(editionId),
  chapterId: fc.uuid(),
  chapterSlug: fc.string({ minLength: 1, maxLength: 30 }),
  percent: fc.float({ min: Math.fround(0), max: Math.fround(0.99), noNaN: true }), // exclude finished
  updatedAt: arbIsoDate,
}) as fc.Arbitrary<ReadingProgressDto>

const arbUserBook = fc.record({
  id: fc.uuid(),
  title: fc.option(fc.string({ minLength: 1, maxLength: 80 }), { nil: null }),
  author: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
  language: fc.constantFrom('en', 'uk', 'ru'),
  coverPath: fc.option(fc.string(), { nil: null }),
  genre: fc.option(fc.string(), { nil: null }),
  totalWordCount: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
  status: fc.constantFrom('ready', 'processing', 'failed', 'uploaded'),
  chapterCount: fc.integer({ min: 0, max: 100 }),
  createdAt: arbIsoDate,
  completedAt: fc.option(arbIsoDate, { nil: null }),
  errorMessage: fc.option(fc.string(), { nil: null }),
  progressPercent: fc.option(fc.float({ min: Math.fround(0), max: Math.fround(1.5), noNaN: true }), { nil: null }), // include >1 + null
  progressUpdatedAt: fc.option(arbIsoDate, { nil: null }),
  progressChapterSlug: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: null }),
}) as fc.Arbitrary<UserBookDto>

const arbLocalProgressLite: fc.Arbitrary<LocalProgressLite> = fc.record({
  chapterSlug: fc.string({ minLength: 1, maxLength: 30 }),
  percent: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
  bookPercent: fc.option(fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }), { nil: undefined }),
  updatedAt: fc.integer({ min: 1_577_836_800_000, max: 1_924_991_999_000 }),
}) as fc.Arbitrary<LocalProgressLite>

const arbUserBookProgressLite: fc.Arbitrary<UserBookProgressLite> = fc.record({
  bookPercent: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
  updatedAt: fc.integer({ min: 1_577_836_800_000, max: 1_924_991_999_000 }),
}) as fc.Arbitrary<UserBookProgressLite>

// --- Tests -------------------------------------------------------------

describe('rankContinueReading — property-based invariants', () => {
  it('never throws on any input shape', () => {
    fc.assert(
      fc.property(
        fc.array(arbLibraryItem, { maxLength: 10 }),
        fc.array(arbUserBook, { maxLength: 10 }),
        (library, userBooks) => {
          // serverProgress arbitrarily tied (or not) to library
          const serverProgress: ReadingProgressDto[] = []
          for (const lib of library) {
            // 50% chance of having server progress for each lib item
            if (Math.random() < 0.5) {
              serverProgress.push({
                editionId: lib.editionId,
                chapterId: 'ch-1',
                chapterSlug: 'chapter-1',
                percent: Math.random(),
                updatedAt: new Date(Date.now() - Math.random() * 1e10).toISOString(),
              } as ReadingProgressDto)
            }
          }
          // Call should never throw
          expect(() => rankContinueReading({
            library, serverProgress, userBooks,
            localCatalogMap: new Map(),
            localUserBookMap: new Map(),
          })).not.toThrow()
        },
      ),
      { numRuns: 200 },
    )
  })

  it('no ranked book is finished (percent < 1)', () => {
    fc.assert(
      fc.property(
        fc.array(arbLibraryItem, { minLength: 1, maxLength: 8 }),
        fc.array(arbUserBook, { maxLength: 8 }),
        arbLocalProgressLite,
        (library, userBooks, localProg) => {
          const localMap = new Map<string, LocalProgressLite>()
          // Put local progress on the first library item
          localMap.set(library[0].editionId, localProg)
          const ranked = rankContinueReading({
            library, serverProgress: [], userBooks,
            localCatalogMap: localMap, localUserBookMap: new Map(),
          })
          for (const p of ranked) expect(p.percent).toBeLessThan(1)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('catalog books not in library are never ranked, even with server progress', () => {
    fc.assert(
      fc.property(
        fc.array(arbLibraryItem, { maxLength: 5 }),
        fc.array(fc.uuid(), { minLength: 1, maxLength: 5 }),
        (library, orphanEditionIds) => {
          // Server progress rows for edition IDs that don't exist in library
          const serverProgress: ReadingProgressDto[] = orphanEditionIds.map(id => ({
            editionId: id,
            chapterId: 'ch-1',
            chapterSlug: 'chapter-1',
            percent: 0.5,
            updatedAt: new Date().toISOString(),
          } as ReadingProgressDto))
          const ranked = rankContinueReading({
            library, serverProgress, userBooks: [],
            localCatalogMap: new Map(), localUserBookMap: new Map(),
          })
          for (const p of ranked) {
            // Must be in library
            if (p.type === 'edition') expect(library.some(l => l.slug === p.slug)).toBe(true)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('non-ready user-books are never ranked', () => {
    fc.assert(
      fc.property(
        fc.array(arbUserBook, { minLength: 1, maxLength: 10 }),
        (userBooks) => {
          const ranked = rankContinueReading({
            library: [], serverProgress: [], userBooks,
            localCatalogMap: new Map(), localUserBookMap: new Map(),
          })
          for (const p of ranked) {
            if (p.type !== 'userbook') continue
            const pickedBook = userBooks.find(ub => ub.id === p.id)
            expect(pickedBook?.status.toLowerCase()).toBe('ready')
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('head.updatedAtMs is the MAX and the list is sorted newest first', () => {
    // Build a scenario with multiple candidate user books — picked one
    // must have the largest progressUpdatedAt timestamp.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            ts: fc.integer({ min: 1_577_836_800_000, max: 1_924_991_999_000 }),
            percent: fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true }),
          }),
          { minLength: 2, maxLength: 10 },
        ),
        (items) => {
          const userBooks: UserBookDto[] = items.map(({ id, ts, percent }) => ({
            id, title: `book-${id}`, author: null, language: 'en',
            coverPath: null, genre: null, totalWordCount: 1000,
            status: 'ready', chapterCount: 5,
            createdAt: new Date(ts - 1000).toISOString(),
            completedAt: null, errorMessage: null,
            progressPercent: percent,
            progressUpdatedAt: new Date(ts).toISOString(),
            progressChapterSlug: 'ch-1',
          }))
          const ranked = rankContinueReading({
            library: [], serverProgress: [], userBooks,
            localCatalogMap: new Map(), localUserBookMap: new Map(),
          })
          const maxTs = Math.max(...items.map(i => i.ts))
          expect(ranked[0].updatedAtMs).toBe(maxTs)
          const stamps = ranked.map(p => p.updatedAtMs)
          expect(stamps).toEqual([...stamps].sort((a, b) => b - a))
        },
      ),
      { numRuns: 100 },
    )
  })
})
