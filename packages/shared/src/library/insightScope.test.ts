import { describe, it, expect } from 'vitest'
import { insightChapterLabel } from './insightScope'

describe('insightChapterLabel', () => {
  it('returns null for a book-level insight, so the caller supplies its own words', () => {
    expect(insightChapterLabel({ chapterSlug: null, chapterTitle: null })).toBeNull()
  })

  it('prefers the resolved chapter title', () => {
    expect(insightChapterLabel({ chapterSlug: '5-replication', chapterTitle: 'Replication' }))
      .toBe('Replication')
  })

  it('falls back to the slug when a re-ingest left the title unresolvable', () => {
    // The conclusion is still worth reading; it just cannot be placed. Dropping
    // the row would lose work that a chapter rename had nothing to do with.
    expect(insightChapterLabel({ chapterSlug: '5-replication', chapterTitle: null }))
      .toBe('5-replication')
  })

  it('never mentions a chapter number', () => {
    // chapterNumber orders; it does not display. Production has editions based at
    // 0 and uploads based at 2, and the two clients compensate differently — so a
    // number printed here is off by one on exactly one of them.
    const label = insightChapterLabel({ chapterSlug: '5-replication', chapterTitle: 'Replication' })
    expect(label).not.toMatch(/\d/)
  })
})
