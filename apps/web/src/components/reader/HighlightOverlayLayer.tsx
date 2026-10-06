import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Overlayer, type DrawFn } from '@textstack/reader-overlay'
import { useOverlayAnnotations, type AnnotationSpec } from '../../hooks/useOverlayAnnotations'
import { useOverlayReflow } from '../../hooks/useOverlayReflow'
import { findTextByAnchor, highlightChapterKey } from '../../lib/textAnchor'
import type { HighlightColor, StoredHighlight } from '../../lib/offlineDb'
import { isReviewed, useReviewedMarks } from './ReviewedMarks'

// Highlights via the shared SVG Overlayer. Positions the overlayer SVG as a
// viewport-fixed sibling so raw range.getClientRects() coords land 1:1 on
// screen. Reflow hook drives redraw on resize / font-ready / theme change.

// CSS-var-driven so theme switches re-render the SVG fill without a redraw
// pass (`style.fill` follows custom-property changes natively). Light-theme
// fallbacks match the legacy hardcoded palette; dark/sepia overrides live in
// reader.css.
const COLOR_MAP: Record<HighlightColor, string> = {
  yellow: 'var(--reader-overlay-hl-yellow, rgba(254, 240, 138, 0.5))',
  green: 'var(--reader-overlay-hl-green, rgba(187, 247, 208, 0.5))',
  pink: 'var(--reader-overlay-hl-pink, rgba(251, 207, 232, 0.5))',
  blue: 'var(--reader-overlay-hl-blue, rgba(191, 219, 254, 0.5))',
}

/**
 * "Reviewed" badge: a small dot just after the highlight's last rect (chapter-review.md §12). A
 * custom DrawFn on its own namespace — no engine change. The entry's hit rects are the highlight's,
 * so a tap on the text still resolves (see the click handler).
 */
export const reviewedDot: DrawFn = (rects) => {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  g.setAttribute('class', 'reviewed-mark')
  g.style.fill = 'var(--reader-reviewed-dot, #16a34a)'
  const last = rects[rects.length - 1]
  if (!last) return g
  const r = Math.max(2.5, Math.min(4, last.height * 0.15))
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  dot.setAttribute('cx', String(last.right + r + 1))
  dot.setAttribute('cy', String(last.top + r + 1))
  dot.setAttribute('r', String(r))
  g.append(dot)
  return g
}

const HL_PREFIXES = ['user-hl:', 'reviewed-mark:']

interface Props {
  highlights: StoredHighlight[]
  containerRef: React.RefObject<HTMLElement | null>
  /** The rendered chapter. A chapter change swaps the DOM under unchanged
   *  highlights, so it must re-map them — without it the new chapter's own
   *  highlights never painted after Next/Prev or a drawer jump. */
  chapterId?: string
  onHighlightClick?: (highlight: StoredHighlight, rect: DOMRect) => void
}

export function HighlightOverlayLayer({ highlights, containerRef, chapterId, onHighlightClick }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const overlayer = useMemo(() => new Overlayer(), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.appendChild(overlayer.element)
    return () => {
      if (overlayer.element.parentNode === host) host.removeChild(overlayer.element)
      overlayer.clear()
    }
  }, [overlayer])

  const map = useCallback(
    (h: StoredHighlight): AnnotationSpec<StoredHighlight> | null => {
      const container = containerRef.current
      if (!container) return null
      const range = findTextByAnchor(h.anchor, container, highlightChapterKey(h))
      if (!range) return null
      return {
        item: h,
        key: h.id,
        range,
        options: { color: COLOR_MAP[h.color], opacity: 1, blendMode: 'normal' },
      }
    },
    // chapterId is not read: it forces a re-map when the chapter DOM is swapped.
    [containerRef, chapterId],
  )

  useOverlayAnnotations<StoredHighlight>(overlayer, {
    namespace: 'user-hl',
    items: highlights,
    draw: Overlayer.highlight,
    map,
  })

  const reviewed = useReviewedMarks()
  const reviewedHighlights = useMemo(
    () => (reviewed ? highlights.filter((h) => isReviewed(reviewed, h.id)) : []),
    [highlights, reviewed],
  )
  useOverlayAnnotations<StoredHighlight>(overlayer, {
    namespace: 'reviewed-mark',
    items: reviewedHighlights,
    draw: reviewedDot,
    map,
  })

  useOverlayReflow(overlayer, containerRef)

  useEffect(() => {
    if (!onHighlightClick) return
    const container = containerRef.current
    if (!container) return
    const handler = (e: MouseEvent): void => {
      const [key, range] = overlayer.hitTest({ x: e.clientX, y: e.clientY })
      const prefix = key && HL_PREFIXES.find((p) => key.startsWith(p))
      if (!key || !range || !prefix) return
      const id = key.slice(prefix.length)
      const h = highlights.find((hh) => hh.id === id)
      if (!h) return
      onHighlightClick(h, range.getBoundingClientRect())
    }
    container.addEventListener('click', handler)
    return () => container.removeEventListener('click', handler)
  }, [overlayer, containerRef, highlights, onHighlightClick])

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-highlight-overlay="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  )
}
