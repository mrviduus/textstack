import { describe, it, expect } from 'vitest'
import { resumeRoute } from './bookRoutes'
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

  it('keeps the user-book segments in route order: bookId then chapterSlug', () => {
    // These were once swapped, so expo-router could not match the path and
    // silently fell back to the detail screen — Continue Reading looked broken
    // for every uploaded book.
    expect(resumeRoute(userbook())).toBe('/my-books/read/ub-1/chapter-5')
  })

  it('opens the reader with no chapter too (a PDF at a page, a book never opened): no network, no detour (#1522)', () => {
    // The reader ignores the slug and opens the book at its synced place.
    expect(resumeRoute(userbook({ chapterSlug: null, locator: 'page:42' }))).toBe('/my-books/read/ub-1/start')
  })

  it('sends a catalog pick (retired at M6) to the front door', () => {
    expect(resumeRoute(edition())).toBe('/')
  })
})
