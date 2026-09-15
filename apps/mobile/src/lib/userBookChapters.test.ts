import { describe, it, expect } from 'vitest'
import { userBookChapterSlug } from './userBookChapters'

describe('userBookChapterSlug', () => {
  it('uses the slug when the server sent one', () => {
    expect(userBookChapterSlug({ slug: 'chapter-one', chapterNumber: 1 })).toBe('chapter-one')
  })

  it('falls back to the chapter number, matching the reader route', () => {
    expect(userBookChapterSlug({ slug: null, chapterNumber: 7 })).toBe('chapter-7')
    expect(userBookChapterSlug({ chapterNumber: 0 })).toBe('chapter-0')
  })

  it('treats a blank slug as absent — a download keyed on " " is a cache miss forever', () => {
    expect(userBookChapterSlug({ slug: '   ', chapterNumber: 3 })).toBe('chapter-3')
  })
})
