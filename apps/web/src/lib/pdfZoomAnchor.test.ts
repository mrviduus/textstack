import { describe, it, expect } from 'vitest'
import { pageAtViewportTop, type PageRect } from '@textstack/shared'
import { capturePageAnchor, scrollDeltaForAnchor } from './pdfZoomAnchor'

// H4: zoom / width change rescales every page. Keeping scrollTop puts a
// different page under the top line (and the view then saves it). The anchor
// is the page under the top line plus how far into it the line sits.

const GAP = 12
function layout(pages: number, pageH: number, scrollTop: number): PageRect[] {
  return Array.from({ length: pages }, (_, i) => {
    const top = i * (pageH + GAP) - scrollTop
    return { page: i + 1, top, bottom: top + pageH }
  })
}

describe('pdfZoomAnchor', () => {
  it('zoom-in at p.40 stays on p.40, same fraction into the page', () => {
    const before = layout(60, 800, 39 * 812 + 240) // 30% into page 40
    const anchor = capturePageAnchor(before, 0)!
    expect(anchor.page).toBe(40)
    expect(anchor.fraction).toBeCloseTo(0.3)

    // Scale ×1.2 with the old scrollTop: lands elsewhere (the bug).
    const scaledSameTop = layout(60, 960, 39 * 812 + 240)
    expect(pageAtViewportTop(scaledSameTop, 0)).not.toBe(40)

    const scrollTop = 39 * 812 + 240 + scrollDeltaForAnchor(anchor, scaledSameTop, 0)!
    const after = layout(60, 960, scrollTop)
    expect(pageAtViewportTop(after, 0)).toBe(40)
    expect(capturePageAnchor(after, 0)!.fraction).toBeCloseTo(0.3)
  })

  it('returns null when the anchored page is not laid out', () => {
    expect(capturePageAnchor([], 0)).toBeNull()
    expect(scrollDeltaForAnchor({ page: 9, fraction: 0 }, layout(3, 100, 0), 0)).toBeNull()
  })
})
