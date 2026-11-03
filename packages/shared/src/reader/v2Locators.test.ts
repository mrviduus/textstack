import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { chapterAtFraction, clip, v2PositionLocator, v2AnchorLocator, anchorOfV2Locator, v2ResumeChapter } from './v2Locators'
import { createSha256 } from '../lib/sha256'

describe('v2 locators', () => {
  it('picks the chapter at a book fraction by word counts, missing counts at the average', () => {
    const items = [{ chapterKey: 'a', wordCount: 100 }, { chapterKey: 'b', wordCount: null }, { chapterKey: 'c', wordCount: 300 }]
    expect(chapterAtFraction(items, 0)).toBe('a')
    expect(chapterAtFraction(items, 0.3)).toBe('b') // 0.3 * 600 = 180: past a (100), inside b (100..300)
    expect(chapterAtFraction(items, 1)).toBe('c')
    expect(chapterAtFraction([], 0.5)).toBeNull()
  })

  it('writes a page as pdf-page, a position as itself, a slug alone as scroll-only at the chapter start', () => {
    expect(v2PositionLocator({ chapterSlug: null, locator: 'page:7' })).toEqual({ version: 1, scheme: 'pdf-page', value: { page: 7 } })
    const position = { v: 1, chapterSlug: 'k1', charOffset: 1, chapterFraction: 0.4, anchor: { prefix: 'a', exact: 'b', suffix: 'c', startOffset: 1, endOffset: 2 } }
    expect(v2PositionLocator({ chapterSlug: 'k1', positionJson: JSON.stringify(position) })?.value).toEqual(position)
    expect(v2PositionLocator({ chapterSlug: 'k2', positionJson: JSON.stringify(position) })?.value).toEqual({ v: 1, chapterSlug: 'k2', chapterFraction: 0 })
    expect(v2PositionLocator({ chapterSlug: null })).toBeNull()
  })

  it('resumes a position in its own chapter, a page nowhere, a cfi by fraction', () => {
    const toc = { items: [{ chapterKey: 'a', chapterNumber: 0, title: 'A', wordCount: 10 }, { chapterKey: 'b', chapterNumber: 1, title: 'B', wordCount: 10 }], ingestion: 'succeeded' as const }
    expect(v2ResumeChapter({ currentLocator: { version: 1, scheme: 'textstack-position-v1', value: { chapterSlug: 'a' } }, bookFraction: 0.9 }, toc)).toBe('a')
    expect(v2ResumeChapter({ currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 2 } }, bookFraction: 0.9 }, toc)).toBeNull()
    expect(v2ResumeChapter({ currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4)' }, bookFraction: 0.9 }, toc)).toBe('b')
  })

  it('round-trips a reflow anchor with the chapter key the reader is on, and a PDF anchor as stored', () => {
    const anchor = { prefix: 'p', exact: 'hello', suffix: 's', startOffset: 10, endOffset: 15 }
    const locator = v2AnchorLocator(anchor, 'key-3')
    expect(locator.scheme).toBe('textstack-anchor-v1')
    expect(anchorOfV2Locator(locator)).toEqual({ ...anchor, chapterId: 'key-3' })
    const pdf = { v: 1 as const, kind: 'pdf' as const, page: 2, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }], exact: 'x' }
    expect(anchorOfV2Locator(v2AnchorLocator(pdf, ''))).toEqual(pdf)
    expect(anchorOfV2Locator({ version: 1, scheme: 'epub-cfi', value: 'x' })).toBeNull()
  })

  it('cuts text never between the halves of a surrogate pair', () => {
    expect(clip('ab😀', 3)).toBe('ab')
    expect(clip('abc', 5)).toBe('abc')
  })
})

describe('createSha256', () => {
  const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

  it('matches the known digest of the empty input and of "abc"', () => {
    const empty = createSha256()
    expect(empty.hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    const abc = createSha256()
    abc.update(new TextEncoder().encode('abc'))
    expect(abc.hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('gives the same digest whatever the chunking, across block and padding boundaries', () => {
    for (const size of [55, 56, 63, 64, 65, 119, 120, 1000, 70_001]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff)
      for (const chunk of [1, 7, 64, 100, size]) {
        const h = createSha256()
        for (let at = 0; at < size; at += chunk) h.update(bytes.subarray(at, at + chunk))
        expect(h.hex(), `size ${size} chunk ${chunk}`).toBe(node(bytes))
      }
    }
  })
})
