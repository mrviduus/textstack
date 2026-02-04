import { useEffect, useState, useCallback, useRef } from 'react'
import type { StoredHighlight, HighlightColor } from '../../lib/offlineDb'
import { findTextByAnchor } from '../../lib/textAnchor'

interface HighlightRect {
  id: string
  color: HighlightColor
  hasNote: boolean
  rects: DOMRect[]
}

interface HighlightLayerProps {
  highlights: StoredHighlight[]
  containerRef: React.RefObject<HTMLElement | null>
  onHighlightClick?: (highlight: StoredHighlight, rect: DOMRect) => void
}

const COLOR_MAP: Record<HighlightColor, string> = {
  yellow: 'rgba(254, 240, 138, 0.5)',
  green: 'rgba(187, 247, 208, 0.5)',
  pink: 'rgba(251, 207, 232, 0.5)',
  blue: 'rgba(191, 219, 254, 0.5)',
}

export function HighlightLayer({
  highlights,
  containerRef,
  onHighlightClick,
}: HighlightLayerProps) {
  const [highlightRects, setHighlightRects] = useState<HighlightRect[]>([])
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null)
  const rafRef = useRef<number | null>(null)

  const calculateRects = useCallback(() => {
    const container = containerRef.current
    if (!container || highlights.length === 0) {
      setHighlightRects([])
      setContainerRect(null)
      return
    }

    const newContainerRect = container.getBoundingClientRect()
    setContainerRect(newContainerRect)

    const rects: HighlightRect[] = []

    for (const highlight of highlights) {
      const range = findTextByAnchor(highlight.anchor, container)
      if (range) {
        const clientRects = Array.from(range.getClientRects())
        if (clientRects.length > 0) {
          rects.push({
            id: highlight.id,
            color: highlight.color,
            hasNote: !!highlight.noteText,
            rects: clientRects,
          })
        }
      }
    }

    setHighlightRects(rects)
  }, [highlights, containerRef])

  // Recalculate on highlights change
  useEffect(() => {
    calculateRects()
  }, [calculateRects])

  // Recalculate on scroll/resize
  useEffect(() => {
    const handleUpdate = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      rafRef.current = requestAnimationFrame(calculateRects)
    }

    window.addEventListener('scroll', handleUpdate, { passive: true })
    window.addEventListener('resize', handleUpdate, { passive: true })

    // Also observe container mutations (column changes, etc)
    const container = containerRef.current
    let observer: MutationObserver | null = null
    if (container) {
      observer = new MutationObserver(handleUpdate)
      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }

    return () => {
      window.removeEventListener('scroll', handleUpdate)
      window.removeEventListener('resize', handleUpdate)
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      observer?.disconnect()
    }
  }, [containerRef, calculateRects])

  if (highlightRects.length === 0 || !containerRect) {
    return null
  }

  const handleClick = (id: string, rect: DOMRect) => {
    const highlight = highlights.find((h) => h.id === id)
    if (highlight && onHighlightClick) {
      // Create a DOMRect in viewport coordinates
      const viewportRect = new DOMRect(
        rect.left,
        rect.top,
        rect.width,
        rect.height
      )
      onHighlightClick(highlight, viewportRect)
    }
  }

  return (
    <svg
      className="highlight-layer"
      style={{
        position: 'fixed',
        top: containerRect.top,
        left: containerRect.left,
        width: containerRect.width,
        height: containerRect.height,
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      {highlightRects.map(({ id, color, hasNote, rects }) =>
        rects.map((rect, i) => (
          <rect
            key={`${id}-${i}`}
            className={hasNote ? 'has-note' : undefined}
            x={rect.left - containerRect.left}
            y={rect.top - containerRect.top}
            width={rect.width}
            height={rect.height}
            fill={COLOR_MAP[color]}
            rx={2}
            style={{ pointerEvents: 'auto', cursor: 'pointer' }}
            onClick={() => handleClick(id, rect)}
          />
        ))
      )}
    </svg>
  )
}

// CSS styles - add to reader.css
export const highlightLayerStyles = `
.highlight-layer {
  overflow: visible;
}

.highlight-layer rect {
  transition: opacity 0.15s;
}

.highlight-layer rect:hover {
  opacity: 0.8;
}
`
