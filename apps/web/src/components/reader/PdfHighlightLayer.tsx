import { paintRect, isPdfAnchor } from '@textstack/shared'
import type { HighlightColor, StoredHighlight } from '../../lib/offlineDb'
import { isReviewed, useReviewedMarks } from './ReviewedMarks'

// Persistent PDF highlights for ONE rendered page. Absolutely-positioned tinted
// <div>s painted from the stored quad-rects (page-relative, unscaled) scaled by
// the live render scale — mounted inside `.pdf-page`, over the text layer.
//
// Blend choice:
//  - Light mode: `mix-blend-mode: multiply` — the pastel tint darkens the
//    paper-white scan like a real marker, keeping the underlying glyphs legible.
//  - Dim/invert mode: the canvas is CSS-inverted (dark scan). Multiply over dark
//    would crush the tint to near-black, so we drop the blend to plain
//    source-over (`.pdf-hl-layer--invert`) — the translucent pastel then sits
//    visibly on the darkened page. See pdfOriginal.css.

// Same palette as the reflow overlay (HighlightOverlayLayer COLOR_MAP), as rgba
// so `multiply` reads the alpha. CSS-var-driven so themes can override.
const COLOR_MAP: Record<HighlightColor, string> = {
  yellow: 'var(--reader-overlay-hl-yellow, rgba(254, 240, 138, 0.5))',
  green: 'var(--reader-overlay-hl-green, rgba(187, 247, 208, 0.5))',
  pink: 'var(--reader-overlay-hl-pink, rgba(251, 207, 232, 0.5))',
  blue: 'var(--reader-overlay-hl-blue, rgba(191, 219, 254, 0.5))',
}

interface Props {
  page: number
  highlights: StoredHighlight[]
  scale: number
  invert?: boolean
}

/** Minimal client box for hit-testing (DOMRect is a superset, so it passes). */
export interface HlHitBox {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Point-in-rect hit-test for the click-to-edit path (M2). The rects are
 * `pointer-events: none` so text selection works over a highlight; on a plain
 * click PdfOriginalView collects the painted `.pdf-hl-rect` boxes and asks this
 * which highlight sits under the point. Iterates last→first so the topmost
 * (last-painted) rect wins on overlap. Returns the matched hit (carrying its
 * DOMRect) or null.
 */
export function hitTestHighlightRects<T extends { box: HlHitBox }>(
  hits: T[],
  x: number,
  y: number,
): T | null {
  for (let i = hits.length - 1; i >= 0; i--) {
    const b = hits[i].box
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return hits[i]
  }
  return null
}

/**
 * True when a live, non-empty text selection exists — the SelectionToolbar owns
 * that gesture, so click-to-edit must stand down (a drag-select ends with a
 * `click` too). Collapsed / whitespace-only selections are treated as "no
 * selection" so a plain click on a highlight still opens the editor.
 */
export function hasActiveSelection(sel: Selection | null): boolean {
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0
}

export function PdfHighlightLayer({ page, highlights, scale, invert }: Props) {
  const reviewed = useReviewedMarks()
  const pageHls = highlights.filter((h) => isPdfAnchor(h.anchor) && h.anchor.page === page)
  if (pageHls.length === 0) return null

  return (
    <div className={`pdf-hl-layer${invert ? ' pdf-hl-layer--invert' : ''}`} aria-hidden="true">
      {pageHls.map((h) => {
        // Guarded by the filter above — narrow for the rects.
        const anchor = h.anchor
        if (!isPdfAnchor(anchor)) return null
        // "Reviewed" dot just after the last rect (chapter-review.md §12). Not a `.pdf-hl-rect`, so
        // hit-testing ignores it; a tap on the highlight opens the popup with the review row.
        const last = anchor.rects[anchor.rects.length - 1]
        const dotBox = last && isReviewed(reviewed, h.id) ? paintRect(last, scale) : null
        const dot = dotBox && (
          <div
            key={`${h.id}:dot`}
            className="pdf-hl-dot"
            data-reviewed-id={h.id}
            style={{ left: dotBox.left + dotBox.width + 1, top: dotBox.top, pointerEvents: 'none' }}
          />
        )
        return [...anchor.rects.map((r, i) => {
          const box = paintRect(r, scale)
          return (
            <div
              key={`${h.id}:${i}`}
              className="pdf-hl-rect"
              data-highlight-id={h.id}
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                background: COLOR_MAP[h.color],
                // Explicit (belt-and-suspenders over the CSS) so a selection can
                // always start/drag over a highlight — edit is via hit-testing.
                pointerEvents: 'none',
              }}
            />
          )
        }), dot]
      })}
    </div>
  )
}
