import { describe, it, expect } from 'vitest'
import { editionStartRoute, resumeRoute, userBookReadRoute } from './bookRoutes'
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

describe('editionStartRoute — Continue on a catalog book with no saved place (QA-007)', () => {
  it('opens the reader at the first chapter', () => {
    expect(editionStartRoute('dracula', [{ slug: 'chapter-1' }, { slug: 'chapter-2' }])).toBe('/reader/dracula/chapter-1')
  })

  it('falls back to the book screen when there is no chapter list', () => {
    expect(editionStartRoute('dracula', [])).toBe('/book/dracula')
  })
})

describe('userBookReadRoute — Continue on an upload the pick could not place (QA-007)', () => {
  const chapters = [
    { slug: 'part-1', chapterNumber: 2, sourceStartPage: 1 },
    { slug: 'part-2', chapterNumber: 3, sourceStartPage: 10 },
  ]

  it('a chapterless PDF opens the reader at the chapter holding its saved page, not the detail screen', () => {
    expect(userBookReadRoute('ub-1', { chapterSlug: null, locator: 'page:12' }, chapters)).toBe('/my-books/read/ub-1/part-2')
  })

  it('a book with no usable position starts at the first chapter', () => {
    expect(userBookReadRoute('ub-1', null, chapters)).toBe('/my-books/read/ub-1/part-1')
  })

  it('falls back to the detail screen only when there is no chapter at all', () => {
    expect(userBookReadRoute('ub-1', { chapterSlug: null, locator: 'page:3' }, [])).toBe('/my-books/ub-1')
  })
})
