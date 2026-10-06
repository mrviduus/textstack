import { describe, it, expect } from 'vitest'
import { chapterSlugForPage, resolvePdfResumePage, chapterEndPage, isFirstPagedChapter } from './pdfResume'

// A 4-chapter PDF. Chapter three is where the reader left off.
const chapters = [
  { slug: 'intro', sourceStartPage: 1 },
  { slug: 'two', sourceStartPage: 20 },
  { slug: 'three', sourceStartPage: 55 },
  { slug: 'four', sourceStartPage: 90 },
]

describe('chapterSlugForPage', () => {
  it('finds the chapter a page falls inside', () => {
    expect(chapterSlugForPage(chapters, 60)).toBe('three')
    expect(chapterSlugForPage(chapters, 20)).toBe('two')
    expect(chapterSlugForPage(chapters, 89)).toBe('three')
    expect(chapterSlugForPage(chapters, 90)).toBe('four')
  })

  it('returns the first chapter for a page before any later start', () => {
    expect(chapterSlugForPage(chapters, 1)).toBe('intro')
    expect(chapterSlugForPage(chapters, 19)).toBe('intro')
  })

  it('returns the last chapter for a page past every start', () => {
    expect(chapterSlugForPage(chapters, 500)).toBe('four')
  })

  it('gives front matter (pages before the first chapter) to the first chapter', () => {
    // Compound Effect: TOC starts at page 5. Page 1 used to map to null → "Start Reading" → chapter
    // one → clamped to page 5 → saved as page:5.
    const book = [{ slug: 'one', sourceStartPage: 5 }, { slug: 'two', sourceStartPage: 40 }]
    expect(chapterSlugForPage(book, 1)).toBe('one')
    expect(chapterSlugForPage(book, 4)).toBe('one')
    expect(chapterSlugForPage([{ slug: 'x', sourceStartPage: null }, ...book], 2)).toBe('one')
  })

  it('returns null when there is nothing to go on', () => {
    expect(chapterSlugForPage([], 10)).toBeNull()
    expect(chapterSlugForPage(chapters, null)).toBeNull()
    expect(chapterSlugForPage(chapters, 0)).toBeNull()
    expect(chapterSlugForPage(chapters, NaN)).toBeNull()
  })

  it('ignores chapters with no measured start page (EPUB, or an older upload)', () => {
    const mixed = [
      { slug: 'a', sourceStartPage: 1 },
      { slug: 'b', sourceStartPage: null },
      { slug: 'c', sourceStartPage: 40 },
    ]
    expect(chapterSlugForPage(mixed, 30)).toBe('a')
    expect(chapterSlugForPage(mixed, 45)).toBe('c')
    expect(chapterSlugForPage([{ slug: 'x', sourceStartPage: null }], 5)).toBeNull()
  })
})

describe('chapterEndPage', () => {
  it('is the next measured start, exclusive', () => {
    expect(chapterEndPage(chapters, 0)).toBe(20)
    expect(chapterEndPage(chapters, 2)).toBe(90)
  })

  it('is null for the last chapter', () => {
    expect(chapterEndPage(chapters, 3)).toBeNull()
  })

  it('skips over unmeasured chapters', () => {
    const mixed = [
      { slug: 'a', sourceStartPage: 1 },
      { slug: 'b', sourceStartPage: null },
      { slug: 'c', sourceStartPage: 40 },
    ]
    expect(chapterEndPage(mixed, 0)).toBe(40)
  })
})

describe('isFirstPagedChapter', () => {
  it('is the first chapter with a measured start, skipping unmeasured ones before it', () => {
    expect(isFirstPagedChapter(chapters, 0)).toBe(true)
    expect(isFirstPagedChapter(chapters, 1)).toBe(false)
    const mixed = [{ slug: 'a', sourceStartPage: null }, { slug: 'b', sourceStartPage: 5 }]
    expect(isFirstPagedChapter(mixed, 1)).toBe(true)
    expect(isFirstPagedChapter(mixed, -1)).toBe(false)
  })
})

describe('resolvePdfResumePage — pages outside every chapter are honoured, not clamped', () => {
  it('front matter: page 1 with the first chapter at 5 → 1', () => {
    expect(resolvePdfResumePage({ chapterStartPage: 5, chapterEndPage: 40, firstChapter: true, resumePage: 1 })).toBe(1)
    expect(resolvePdfResumePage({ chapterStartPage: 5, chapterEndPage: 40, firstChapter: true, resumePage: 4 })).toBe(4)
  })

  it('front matter is not claimed by a later chapter picked from the TOC', () => {
    expect(resolvePdfResumePage({ chapterStartPage: 40, chapterEndPage: 90, firstChapter: false, resumePage: 2 })).toBe(40)
  })

  it('beyond the last chapter: clamped to the page count only', () => {
    expect(resolvePdfResumePage({ chapterStartPage: 150, chapterEndPage: null, resumePage: 200, pageCount: 195 })).toBe(195)
    expect(resolvePdfResumePage({ chapterStartPage: 150, chapterEndPage: null, resumePage: 190, pageCount: 195 })).toBe(190)
    expect(resolvePdfResumePage({ chapterStartPage: null, resumePage: 200, pageCount: 195 })).toBe(195)
  })

  it('a page between measured chapters (an unmeasured one in the gap) → itself', () => {
    const book = [{ slug: 'a', sourceStartPage: 5 }, { slug: 'b', sourceStartPage: null }, { slug: 'c', sourceStartPage: 40 }]
    // Routed to b (no start page) or to a (whose range runs to c) — either way, page 30.
    expect(resolvePdfResumePage({ chapterStartPage: null, resumePage: 30, pageCount: 195 })).toBe(30)
    expect(resolvePdfResumePage({ chapterStartPage: 5, chapterEndPage: chapterEndPage(book, 0), firstChapter: true, resumePage: 30 })).toBe(30)
  })
})

describe('resolvePdfResumePage', () => {
  it('opens the saved page when it lives inside the chapter being opened', () => {
    // Tapping Continue routes to the chapter holding the saved page, so this
    // is the resume case: land exactly where the reader stopped.
    expect(resolvePdfResumePage({ chapterStartPage: 55, chapterEndPage: 90, resumePage: 71 })).toBe(71)
  })

  it('opens the chapter when the saved page is somewhere else', () => {
    // The reader tapped a chapter in the table of contents. They asked for that
    // chapter, not for wherever they were before.
    expect(resolvePdfResumePage({ chapterStartPage: 90, chapterEndPage: null, resumePage: 71 })).toBe(90)
    expect(resolvePdfResumePage({ chapterStartPage: 20, chapterEndPage: 55, resumePage: 71 })).toBe(20)
  })

  it('does not let chapter one page one swallow a saved page deep in the book', () => {
    // The exact regression: every PDF opened at chapter one, whose start page is
    // 1, and the chapter-beats-resume rule discarded page 87 every time.
    expect(resolvePdfResumePage({ chapterStartPage: 1, chapterEndPage: 20, resumePage: 87 })).toBe(1)
    // ...but when Continue correctly routes into the chapter holding page 87:
    expect(resolvePdfResumePage({ chapterStartPage: 55, chapterEndPage: 90, resumePage: 87 })).toBe(87)
  })

  it('treats the last chapter as open-ended', () => {
    expect(resolvePdfResumePage({ chapterStartPage: 90, chapterEndPage: null, resumePage: 140 })).toBe(140)
  })

  it('falls back to the saved page when the chapter has no measured start', () => {
    expect(resolvePdfResumePage({ chapterStartPage: null, resumePage: 33 })).toBe(33)
  })

  it('falls back to page one when it knows nothing', () => {
    expect(resolvePdfResumePage({})).toBe(1)
    expect(resolvePdfResumePage({ chapterStartPage: null, resumePage: null })).toBe(1)
    expect(resolvePdfResumePage({ chapterStartPage: NaN, resumePage: NaN })).toBe(1)
  })

  it('never returns a page below one', () => {
    expect(resolvePdfResumePage({ chapterStartPage: -5, resumePage: -9 })).toBe(1)
    expect(resolvePdfResumePage({ chapterStartPage: 0, resumePage: 0 })).toBe(1)
  })

  it('floors fractional input rather than handing a float to the viewer', () => {
    expect(resolvePdfResumePage({ chapterStartPage: 55, chapterEndPage: 90, resumePage: 71.8 })).toBe(71)
  })
})
