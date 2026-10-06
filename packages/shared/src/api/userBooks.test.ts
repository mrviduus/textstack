import { describe, expect, it } from 'vitest'
import { toUserBookChapter } from './userBooks'

// Wire shape of GET /me/books/{id}/chapters/{slug} — backend `UserChapterDto`
// names the back link `Previous`, not `Prev` like the catalogue `ChapterDto`.
const wire = {
  id: 'c2', chapterNumber: 2, slug: 'two', title: 'Two', html: '<p/>', wordCount: 10,
  previous: { chapterNumber: 1, slug: 'one', title: 'One' },
  next: { chapterNumber: 3, slug: 'three', title: 'Three' },
}

describe('toUserBookChapter', () => {
  it('maps the wire `previous` onto `prev`, so Prev is enabled in an upload', () => {
    const ch = toUserBookChapter(wire)
    expect(ch.prev).toEqual({ slug: 'one', title: 'One' })
    expect(ch.next).toEqual({ slug: 'three', title: 'Three' })
  })

  it('keeps null links null (first / last chapter)', () => {
    const ch = toUserBookChapter({ ...wire, previous: null, next: null })
    expect(ch.prev).toBeNull()
    expect(ch.next).toBeNull()
  })

  it('falls back to the chapter number when a link has no slug, like web', () => {
    const ch = toUserBookChapter({ ...wire, previous: { chapterNumber: 1, slug: null, title: 'One' } })
    expect(ch.prev).toEqual({ slug: '1', title: 'One' })
  })
})
