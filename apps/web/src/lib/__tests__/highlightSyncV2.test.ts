import { describe, it, expect } from 'vitest'
import type { V2Annotation } from '@textstack/shared'
import { toV2Locator, fromV2Annotation, toV2Write } from '../highlightSync'
import type { StoredHighlight, TextAnchor } from '../offlineDb'

const text: TextAnchor = { prefix: 'before ', exact: 'the quote', suffix: ' after', startOffset: 7, endOffset: 16, chapterId: '2-the-woods' }
const pdf = { v: 1 as const, kind: 'pdf' as const, page: 3, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }], exact: 'on page three' }

const annotation = (locator: V2Annotation['locator']): V2Annotation => ({
  id: 'a1', bookId: 'b1', fileId: 'f1', selectedText: 'the quote', noteText: null, locator, color: 'pink',
  createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:01Z', deletedAt: null, revision: 3,
})

describe('the V2 highlight mapping', () => {
  it('sends a reflow TextAnchor as textstack-anchor-v1 naming the chapter key it was made in', () => {
    expect(toV2Locator(text)).toEqual({
      version: 1,
      scheme: 'textstack-anchor-v1',
      value: { chapterKey: '2-the-woods', prefix: 'before ', exact: 'the quote', suffix: ' after', startOffset: 7, endOffset: 16 },
    })
  })

  it('reads textstack-anchor-v1 back as the same TextAnchor, on the chapter key', () => {
    const row = fromV2Annotation(annotation(toV2Locator(text)))
    expect(row).toMatchObject({ id: 'a1', userBookId: 'b1', chapterId: '2-the-woods', anchor: text, version: 3, syncStatus: 'synced' })
  })

  it('round-trips a PdfAnchor through pdf-page', () => {
    const locator = toV2Locator(pdf)
    expect(locator).toEqual({ version: 1, scheme: 'pdf-page', value: pdf })
    expect(fromV2Annotation(annotation(locator))?.anchor).toEqual(pdf)
  })

  it('leaves out an annotation this reader cannot draw (an epub-cfi from the V2 reader)', () => {
    expect(fromV2Annotation(annotation({ version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)' }))).toBeNull()
  })

  it('cuts the selection and its quote to one cap, never inside a surrogate pair', () => {
    const long = 'a'.repeat(3999) + '😀' + 'tail'
    const h = { id: 'h1', editionId: '', chapterId: 'k', userBookId: 'b1', anchor: { ...text, exact: long, endOffset: 7 + long.length },
      color: 'yellow', selectedText: long, syncStatus: 'pending', version: 1, createdAt: 0, updatedAt: 0 } as StoredHighlight
    const body = toV2Write(h, 'f1', null)
    const exact = (body.locator!.value as { exact: string; endOffset: number })
    expect(body.selectedText).toBe('a'.repeat(3999))
    expect(exact.exact).toBe('a'.repeat(3999))
    expect(exact.endOffset).toBe(7 + 3999)
    expect(body).toMatchObject({ expectedRevision: null, bookId: 'b1', fileId: 'f1', color: 'yellow', noteText: null })
  })
})
