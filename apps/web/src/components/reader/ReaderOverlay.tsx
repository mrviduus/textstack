import { useEffect, useMemo, useRef } from 'react'
import { Overlayer } from '@textstack/reader-overlay'
import { useOverlayReflow } from '../../hooks/useOverlayReflow'
import { count } from '../../lib/vocabHighlightTelemetry'

// Mounts the SVG overlayer inside the given container. Exposes the Overlayer
// instance via ref so annotation layers can register ranges.

interface Props {
  /** Scrolling container that owns this overlay. */
  containerRef: React.RefObject<HTMLElement | null>
  /** Receives the Overlayer instance; nulls on unmount. */
  overlayerRef: React.MutableRefObject<Overlayer | null>
  /** Killswitch — when false, overlay is unmounted entirely. */
  enabled?: boolean
}

export function ReaderOverlay({ containerRef, overlayerRef, enabled = true }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  const overlayer = useMemo(
    () =>
      enabled
        ? new Overlayer({
            onMiss: (key, reason) => count('reader.overlay.miss', { key, reason }),
            onRedraw: ({ size, missCount }) => {
              count('reader.overlay.redraw', { size, missCount })
            },
          })
        : null,
    [enabled],
  )

  useEffect(() => {
    overlayerRef.current = overlayer
    return () => {
      overlayerRef.current = null
    }
  }, [overlayer, overlayerRef])

  useEffect(() => {
    if (!overlayer) return
    const host = hostRef.current
    if (!host) return
    host.appendChild(overlayer.element)
    count('reader.overlay.mount')
    return () => {
      if (overlayer.element.parentNode === host) {
        host.removeChild(overlayer.element)
      }
      overlayer.clear()
    }
  }, [overlayer])

  useOverlayReflow(overlayer, containerRef, { enabled })

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  )
}
