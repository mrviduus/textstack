import { describe, it, expect } from 'vitest'
import { highlightReaderPath } from '../HighlightsPage'
import type { HighlightListItem } from '../../api/userData'

const h = (over: Partial<HighlightListItem>) => ({
  id: 'h1', editionId: null, editionSlug: null, chapterSlug: null, userBookId: null, userChapterSlug: null, ...over,
}) as HighlightListItem

describe('highlightReaderPath', () => {
  it('catalog: /books/:slug/:chapter — no /read/ segment (was a 404)', () => {
    expect(highlightReaderPath(h({ editionId: 'e', editionSlug: 'dials', chapterSlug: 'clocks' })))
      .toBe('/books/dials/clocks?direct=1&highlight=h1')
  })
  it('catalog without chapter → book page', () => {
    expect(highlightReaderPath(h({ editionId: 'e', editionSlug: 'dials' }))).toBe('/books/dials')
  })
  it('upload chapter and chapterless PDF keep /read/', () => {
    expect(highlightReaderPath(h({ userBookId: 'b', userChapterSlug: 'c' }))).toBe('/library/my/b/read/c?direct=1&highlight=h1')
    expect(highlightReaderPath(h({ userBookId: 'b' }))).toBe('/library/my/b/read?direct=1&highlight=h1')
  })
})
