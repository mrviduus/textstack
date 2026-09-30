import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PdfHighlightLayer, hitTestHighlightRects, hasActiveSelection } from './PdfHighlightLayer'
import type { StoredHighlight } from '../../lib/offlineDb'
import type { PdfAnchor } from '@textstack/shared'
import { ReviewedMarksContext } from './ReviewedMarks'

function pdfHighlight(id: string, page: number, rects: PdfAnchor['rects']): StoredHighlight {
  return {
    id,
    editionId: '',
    chapterId: '',
    userBookId: 'bk-1',
    anchor: { v: 1, kind: 'pdf', page, rects, exact: 'x' },
    color: 'yellow',
    selectedText: 'x',
    syncStatus: 'synced',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function reflowHighlight(id: string): StoredHighlight {
  return {
    id,
    editionId: 'ed-1',
    chapterId: 'ch-1',
    anchor: { prefix: 'a', exact: 'b', suffix: 'c', startOffset: 0, endOffset: 1, chapterId: 'ch-1' },
    color: 'green',
    selectedText: 'b',
    syncStatus: 'synced',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('PdfHighlightLayer', () => {
  it('paints only highlights on this page, scaled', () => {
    const highlights = [
      pdfHighlight('a', 2, [{ x: 10, y: 20, w: 30, h: 8 }]),
      pdfHighlight('b', 3, [{ x: 0, y: 0, w: 5, h: 5 }]),
    ]
    const { container } = render(
      <PdfHighlightLayer page={2} highlights={highlights} scale={2} />,
    )
    const rects = container.querySelectorAll<HTMLElement>('.pdf-hl-rect')
    expect(rects).toHaveLength(1)
    // paintRect at scale 2: left 20, top 40, width 60, height 16
    expect(rects[0].style.left).toBe('20px')
    expect(rects[0].style.top).toBe('40px')
    expect(rects[0].style.width).toBe('60px')
    expect(rects[0].style.height).toBe('16px')
  })

  it('renders one rect per stored quad', () => {
    const highlights = [
      pdfHighlight('a', 1, [
        { x: 0, y: 0, w: 10, h: 5 },
        { x: 0, y: 6, w: 8, h: 5 },
      ]),
    ]
    const { container } = render(<PdfHighlightLayer page={1} highlights={highlights} scale={1} />)
    expect(container.querySelectorAll('.pdf-hl-rect')).toHaveLength(2)
  })

  it('ignores reflow (non-pdf) highlights', () => {
    const { container } = render(
      <PdfHighlightLayer page={1} highlights={[reflowHighlight('r')]} scale={1} />,
    )
    expect(container.querySelector('.pdf-hl-layer')).toBeNull()
  })

  it('paints rects as pointer-events:none so a selection can start over them (M2)', () => {
    const h = pdfHighlight('a', 1, [{ x: 1, y: 1, w: 10, h: 5 }])
    const { container } = render(<PdfHighlightLayer page={1} highlights={[h]} scale={1} />)
    const rect = container.querySelector<HTMLElement>('.pdf-hl-rect')!
    expect(rect.style.pointerEvents).toBe('none')
    expect(rect.dataset.highlightId).toBe('a')
  })

  it('applies the invert modifier class in dim mode', () => {
    const h = pdfHighlight('a', 1, [{ x: 1, y: 1, w: 10, h: 5 }])
    const { container } = render(
      <PdfHighlightLayer page={1} highlights={[h]} scale={1} invert />,
    )
    expect(container.querySelector('.pdf-hl-layer--invert')).not.toBeNull()
  })
})

describe('hitTestHighlightRects (M2 click-to-edit)', () => {
  const hits = [
    { id: 'a', box: { left: 0, top: 0, right: 100, bottom: 20 } },
    { id: 'b', box: { left: 0, top: 30, right: 100, bottom: 50 } },
  ]

  it('resolves a point inside a rect to the right highlight', () => {
    expect(hitTestHighlightRects(hits, 50, 10)?.id).toBe('a')
    expect(hitTestHighlightRects(hits, 50, 40)?.id).toBe('b')
  })

  it('returns null when the point is in no rect', () => {
    expect(hitTestHighlightRects(hits, 50, 25)).toBeNull()
    expect(hitTestHighlightRects(hits, 200, 10)).toBeNull()
  })

  it('includes the rect edges (>=/<=)', () => {
    expect(hitTestHighlightRects(hits, 0, 0)?.id).toBe('a')
    expect(hitTestHighlightRects(hits, 100, 20)?.id).toBe('a')
  })

  it('returns the topmost (last-painted) rect on overlap', () => {
    const overlap = [
      { id: 'under', box: { left: 0, top: 0, right: 100, bottom: 100 } },
      { id: 'over', box: { left: 0, top: 0, right: 100, bottom: 100 } },
    ]
    expect(hitTestHighlightRects(overlap, 50, 50)?.id).toBe('over')
  })
})

describe('hasActiveSelection (M2 selection guard)', () => {
  const sel = (isCollapsed: boolean, text: string) =>
    ({ isCollapsed, toString: () => text }) as unknown as Selection

  it('is false for null / collapsed / whitespace-only selections', () => {
    expect(hasActiveSelection(null)).toBe(false)
    expect(hasActiveSelection(sel(true, ''))).toBe(false)
    expect(hasActiveSelection(sel(false, '   '))).toBe(false)
  })

  it('is true for a live non-empty selection (so click-to-edit stands down)', () => {
    expect(hasActiveSelection(sel(false, 'picked text'))).toBe(true)
  })
})

describe('PdfHighlightLayer reviewed dot', () => {
  const marks = {
    marks: new Map([['b', { chapterSlug: 'ch', blockTitle: 'Chat templates', rule: 'Print the prompt' }]]),
    reviewPath: (s: string) => `/r/${s}`,
  }

  it('paints a dot only for reviewed ids, just after the LAST rect, scaled', () => {
    const highlights = [
      pdfHighlight('a', 1, [{ x: 0, y: 0, w: 10, h: 5 }]),
      pdfHighlight('B', 1, [{ x: 0, y: 0, w: 10, h: 5 }, { x: 5, y: 10, w: 20, h: 6 }]),
    ]
    const { container } = render(
      <ReviewedMarksContext.Provider value={marks}>
        <PdfHighlightLayer page={1} highlights={highlights} scale={2} />
      </ReviewedMarksContext.Provider>,
    )
    const dots = container.querySelectorAll<HTMLElement>('.pdf-hl-dot')
    expect(dots).toHaveLength(1)
    expect(dots[0].dataset.reviewedId).toBe('B')
    // last rect at scale 2: left 10, width 40 → dot at 10 + 40 + 1; top 20
    expect(dots[0].style.left).toBe('51px')
    expect(dots[0].style.top).toBe('20px')
    // the dot is not a hit target
    expect(container.querySelectorAll('.pdf-hl-rect')).toHaveLength(3)
  })

  it('no provider → no dots', () => {
    const { container } = render(
      <PdfHighlightLayer page={1} highlights={[pdfHighlight('b', 1, [{ x: 0, y: 0, w: 1, h: 1 }])]} scale={1} />,
    )
    expect(container.querySelector('.pdf-hl-dot')).toBeNull()
  })
})
