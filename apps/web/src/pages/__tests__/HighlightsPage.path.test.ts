import { describe, it, expect } from 'vitest'
import { highlightReaderPath } from '../HighlightsPage'
import type { HighlightListItem } from '@textstack/shared'

const h = (over: Partial<HighlightListItem>) => ({
  id: 'h1', editionId: null, editionSlug: null, chapterSlug: null, userBookId: null, userChapterSlug: null, ...over,
}) as HighlightListItem

describe('highlightReaderPath', () => {
  it('upload chapter and chapterless PDF keep /read/', () => {
    expect(highlightReaderPath(h({ userBookId: 'b', userChapterSlug: 'c' }))).toBe('/library/my/b/read/c?direct=1&highlight=h1')
    expect(highlightReaderPath(h({ userBookId: 'b' }))).toBe('/library/my/b/read?direct=1&highlight=h1')
  })
})
