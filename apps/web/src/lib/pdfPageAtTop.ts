/** A rendered PDF page's vertical extent, in client coordinates. */
export interface PageRect {
  page: number
  top: number
  bottom: number
}

/**
 * Sub-pixel slack: a jump aligns a page's top with the viewport top, and
 * rounding can leave the page above ending a fraction past it.
 */
const EDGE_PX = 2

/**
 * The page under the top of the viewport — what the reader is on, and what a
 * reopen jumps back to. The lowest page in the render observer's set was NOT
 * that: its 300px margin keeps the previous page "visible" while its bottom sits
 * just above the viewport, so each open saved one page earlier (C3).
 *
 * A top line falling in the gap between pages reads as the next page.
 */
export function pageAtViewportTop(rects: Iterable<PageRect>, viewportTop: number): number | null {
  let best: number | null = null
  for (const r of rects) {
    if (r.bottom > viewportTop + EDGE_PX && (best === null || r.page < best)) best = r.page
  }
  return best
}
