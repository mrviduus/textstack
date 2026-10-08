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

