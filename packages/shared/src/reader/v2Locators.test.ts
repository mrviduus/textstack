import { describe, it, expect } from 'vitest'
import { placeToV2Locator, v2LocatorToPlace, anchorToV2Locator, v2LocatorToAnchor } from './v2Locators'
import { clip } from './textAnchor'
import { chapterAtFraction } from './bookProgress'

const position = { v: 1, chapterSlug: 'two', anchor: { prefix: 'a', exact: 'quote', suffix: 'b', startOffset: 3, endOffset: 8 }, charOffset: 3, chapterFraction: 0.4 }
const text = { prefix: 'before ', exact: 'the quote', suffix: ' after', startOffset: 7, endOffset: 16, chapterId: '2-the-woods' }
const pdf = { v: 1 as const, kind: 'pdf' as const, page: 3, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }], exact: 'on page three' }

describe('a reading place on V2', () => {
  it("is the reader's TextPosition as textstack-position-v1, never a CFI, and a PDF page as pdf-page", () => {
    expect(placeToV2Locator({ chapterSlug: 'two', positionJson: JSON.stringify(position) })).toEqual({ version: 1, scheme: 'textstack-position-v1', value: position })
    expect(placeToV2Locator({ chapterSlug: null, locator: 'page:12' })).toEqual({ version: 1, scheme: 'pdf-page', value: { page: 12 } })
    expect(placeToV2Locator({ chapterSlug: 'two' })).toEqual({ version: 1, scheme: 'textstack-position-v1', value: { v: 1, chapterSlug: 'two', chapterFraction: 0 } })
    expect(placeToV2Locator({ chapterSlug: null })).toBeNull()
  })

  it('reads back as the legacy place: page:N, the chapter with its TextPosition, nothing for an epub-cfi', () => {
    expect(v2LocatorToPlace({ version: 1, scheme: 'pdf-page', value: { page: 12 } })).toEqual({ chapterSlug: null, locator: 'page:12', positionJson: null })
    expect(v2LocatorToPlace({ version: 1, scheme: 'textstack-position-v1', value: position })).toEqual({ chapterSlug: 'two', locator: null, positionJson: JSON.stringify(position) })
    expect(v2LocatorToPlace({ version: 1, scheme: 'textstack-position-v1', value: { v: 1, chapterSlug: 'two', chapterFraction: 0 } })?.positionJson).toBeNull()
    expect(v2LocatorToPlace({ version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)', quote: 'q' })).toBeNull()
  })

  it('picks the chapter at a fraction by cumulative word counts', () => {
    const items = [{ chapterKey: 'a', wordCount: 10 }, { chapterKey: 'b', wordCount: 30 }, { chapterKey: 'c', wordCount: null }]
    expect(chapterAtFraction(items, 0)).toBe('a')
    expect(chapterAtFraction(items, 0.5)).toBe('b')
    expect(chapterAtFraction(items, 1)).toBe('c')
    expect(chapterAtFraction([], 0.5)).toBeNull()
  })
})

describe('a highlight anchor on V2', () => {
  it('is textstack-anchor-v1 naming the chapter key it was made in, and reads back as the same anchor', () => {
    const locator = anchorToV2Locator(text)
    expect(locator).toEqual({
      version: 1,
      scheme: 'textstack-anchor-v1',
      value: { chapterKey: '2-the-woods', prefix: 'before ', exact: 'the quote', suffix: ' after', startOffset: 7, endOffset: 16 },
    })
    expect(v2LocatorToAnchor(locator)).toEqual(text)
  })

  it('round-trips a PdfAnchor through pdf-page', () => {
    const locator = anchorToV2Locator(pdf)
    expect(locator).toEqual({ version: 1, scheme: 'pdf-page', value: pdf })
    expect(v2LocatorToAnchor(locator)).toEqual(pdf)
  })

  it('is nothing for an epub-cfi or no locator', () => {
    expect(v2LocatorToAnchor({ version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)' })).toBeNull()
    expect(v2LocatorToAnchor(null)).toBeNull()
  })

  it('cuts its quote to the selection cap, the end offset following', () => {
    const exact = 'a'.repeat(4001)
    const value = anchorToV2Locator({ ...text, exact }).value as { exact: string; endOffset: number }
    expect([value.exact.length, value.endOffset]).toEqual([4000, 7 + 4000])
  })
})

describe('clip', () => {
  it('cuts to the cap, never between the halves of a surrogate pair', () => {
    expect(clip('abc', 5)).toBe('abc')
    expect(clip('ab😀c', 3)).toBe('ab')
    expect(clip('ab😀c', 4)).toBe('ab😀')
  })
})
