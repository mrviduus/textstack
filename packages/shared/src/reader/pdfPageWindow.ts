// Pure virtualization math for the Original-layout PDF view.
//
// A 100-page / 21MB PDF cannot keep every page canvas in memory — off-screen
// pages MUST be unmounted or the tab OOMs. Given the set of currently-visible
// page numbers (reported by an IntersectionObserver), we derive two rings:
//   - render ring (±1): pages whose canvas + text layer should be drawn now.
//   - keep ring   (±2): pages whose already-drawn canvas may be retained to
//     avoid flicker on small scrolls. Anything outside the keep ring is freed.
//
// Kept intentionally free of DOM/pdfjs so it can be unit-tested in isolation.

/** Pages within `radius` of any visible page, clamped to [1, numPages]. */
export function pagesInRange(
  visible: Iterable<number>,
  radius: number,
  numPages: number,
): Set<number> {
  const out = new Set<number>()
  for (const v of visible) {
    const start = Math.max(1, v - radius)
    const end = Math.min(numPages, v + radius)
    for (let p = start; p <= end; p++) out.add(p)
  }
  return out
}

export interface PageRings {
  /** ±1 — draw canvas + text layer. */
  render: Set<number>
  /** ±2 — retain an already-drawn canvas (don't free yet). */
  keep: Set<number>
}

export function computePageRings(
  visible: Iterable<number>,
  numPages: number,
  renderRadius = 1,
  keepRadius = 2,
): PageRings {
  const visArr = [...visible]
  return {
    render: pagesInRange(visArr, renderRadius, numPages),
    keep: pagesInRange(visArr, keepRadius, numPages),
  }
}

/** Topmost visible page (for resume persistence + toolbar readout). */
export function topVisiblePage(visible: Iterable<number>, fallback: number): number {
  let min = Infinity
  for (const v of visible) if (v < min) min = v
  return min === Infinity ? fallback : min
}

/**
 * Clamp a (possibly stale / overflow) page request into [1, numPages]. When the
 * page count isn't known yet (numPages < 1) we only floor to >= 1 so an early
 * jump still targets a sensible page.
 */
export function clampPage(page: number, numPages: number): number {
  if (!Number.isFinite(page)) return 1
  const floored = Math.max(1, Math.floor(page))
  if (numPages < 1) return floored
  return Math.min(numPages, floored)
}

/**
 * First candidate page that is a real 1-based page (>= 1) wins; anything
 * null/undefined/<1 is skipped. Callers pass candidates in PRECEDENCE order —
 * for the PDF reader that is: chapter start page (user chose this chapter) >
 * server resume page > localStorage resume page. Defaults to page 1.
 */
export function resolveOpenPage(
  ...candidates: (number | null | undefined)[]
): number {
  for (const c of candidates) {
    if (c != null && c >= 1) return Math.floor(c)
  }
  return 1
}

/**
 * True once the placeholder heights of every page ABOVE the target have
 * streamed in — i.e. the target's scroll offset has stopped shifting, so a
 * correction re-scroll will land precisely. Any jump (initial open, TOC, or
 * page-input) gates its one-shot correction on this.
 */
export function dimsReadyUpTo(
  dims: readonly (unknown | undefined)[],
  targetPage: number,
): boolean {
  // A missing entry and a missing tail mean the same thing: not measured yet. The mobile viewer
  // fills its array as sizes arrive, and clamping to its length made "page 1 measured" read as
  // "ready" for every target — the jump was settled on estimated heights, and each reopen drifted.
  const upto = Math.max(1, Math.floor(targetPage))
  if (dims.length < upto) return false
  for (let i = 0; i < upto; i++) {
    if (!dims[i]) return false
  }
  return true
}

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
 * reopen jumps back to. `topVisiblePage` over the render observer's set is NOT
 * that: its 300px margin keeps the previous page "visible" while its bottom sits
 * just above the viewport, so each open saved one page earlier (C3). Used by
 * both the web view and the mobile WebView bundle.
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

/** Where the reader is in a PDF, independent of scale: the page under the top line and how far into it. */
export interface PageAnchor {
  page: number
  fraction: number
}

/** Web zoom (H4) and the mobile viewer's re-fit / streaming sizes: every rescale keeps this anchor. */
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
