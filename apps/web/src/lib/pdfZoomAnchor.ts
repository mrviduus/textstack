import { pageAtViewportTop, type PageRect } from '@textstack/shared'

/** Where the reader is in a PDF, independent of scale: the page under the top line and how far into it. */
export interface PageAnchor {
  page: number
  fraction: number
}

export function capturePageAnchor(rects: PageRect[], viewportTop: number): PageAnchor | null {
  const page = pageAtViewportTop(rects, viewportTop)
  const r = page == null ? undefined : rects.find((x) => x.page === page)
  if (!r) return null
  const h = r.bottom - r.top
  return { page: r.page, fraction: h > 0 ? Math.min(1, Math.max(0, (viewportTop - r.top) / h)) : 0 }
}

/** How far to scroll so the anchor sits on the top line again in the current layout. Null if its page is not laid out. */
export function scrollDeltaForAnchor(anchor: PageAnchor, rects: PageRect[], viewportTop: number): number | null {
  const r = rects.find((x) => x.page === anchor.page)
  return r ? r.top + anchor.fraction * (r.bottom - r.top) - viewportTop : null
}
