import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Overlayer } from '@textstack/reader-overlay'
import { useOverlayAnnotations, type AnnotationSpec } from '../../hooks/useOverlayAnnotations'
import { useOverlayReflow } from '../../hooks/useOverlayReflow'
import { useContainerMutationObserver } from '../../hooks/useContainerMutationObserver'
import { findTextMatches } from '@textstack/reader-overlay'

// Visual in-article highlights for in-book search. Non-active matches get a
// soft fill, the active match gets a bolder outline + scrolls into view.

const INACTIVE_COLOR = 'var(--reader-overlay-search-inactive, rgba(250, 204, 21, 0.35))'
const ACTIVE_COLOR = 'var(--reader-overlay-search-active, rgb(249, 115, 22))'

interface Props {
  containerRef: React.RefObject<HTMLElement | null>
  query: string
  activeMatchIndex: number
  enabled?: boolean
}

interface Match {
  idx: number
  range: Range
}

export function SearchOverlayLayer({
  containerRef,
  query,
  activeMatchIndex,
  enabled = true,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const overlayer = useMemo(() => (enabled ? new Overlayer() : null), [enabled])
  const [ranges, setRanges] = useState<Match[]>([])

  useEffect(() => {
    if (!overlayer) return
    const host = hostRef.current
    if (!host) return
    host.appendChild(overlayer.element)
    return () => {
      if (overlayer.element.parentNode === host) host.removeChild(overlayer.element)
      overlayer.clear()
    }
  }, [overlayer])

  const recompute = useCallback(() => {
    const container = containerRef.current
    const q = query.trim()
    if (!container || q.length < 2) {
      setRanges([])
      return
    }
    const next: Match[] = []
    let i = 0
    try {
      // The chapter only: the nav bar and buttons below it hold text too (the
      // chapter title), which the drawer's list never counts.
      const root = container.querySelector('.reader-section__article') ?? container
      for (const r of findTextMatches(root, q)) {
        next.push({ idx: i++, range: r })
      }
    } catch {
      setRanges([])
      return
    }
    setRanges(next)
  }, [containerRef, query])

  useEffect(() => {
    recompute()
  }, [recompute])

  useContainerMutationObserver(containerRef, recompute)

  const map = useCallback(
    (m: Match): AnnotationSpec<Match> => ({
      item: m,
      key: `${m.idx}`,
      range: m.range,
      options:
        m.idx === activeMatchIndex
          ? { color: ACTIVE_COLOR, width: 2, radius: 3 }
          : { color: INACTIVE_COLOR, opacity: 1, blendMode: 'normal' },
    }),
    [activeMatchIndex],
  )

  const draw = useMemo<(r: DOMRectList | DOMRect[], o?: { color?: string; width?: number; radius?: number }) => SVGElement>(
    () => (rects, options) => {
      const isActive = options?.width !== undefined
      return isActive ? Overlayer.outline(rects, options) : Overlayer.highlight(rects, options)
    },
    [],
  )

  useOverlayAnnotations<Match>(overlayer, {
    namespace: 'search',
    items: ranges,
    draw,
    map,
    enabled,
  })

  useOverlayReflow(overlayer, containerRef, { enabled })

  // Scroll active match into view.
  useEffect(() => {
    if (!enabled) return
    const m = ranges[activeMatchIndex]
    if (!m) return
    const rect = m.range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    const targetY = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2
    window.scrollTo({ top: targetY, behavior: 'smooth' })
  }, [ranges, activeMatchIndex, enabled])

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-search-overlay="true"
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
