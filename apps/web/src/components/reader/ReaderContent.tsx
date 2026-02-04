import { useCallback, forwardRef, useRef } from 'react'
import type { ReaderSettings } from '../../hooks/useReaderSettings'

interface Props {
  html: string
  settings: ReaderSettings
  onTap: () => void
  onDoubleTap?: () => void
  onLeftTap?: () => void
  onRightTap?: () => void
  containerRef?: React.RefObject<HTMLDivElement | null>
}

const DOUBLE_TAP_DELAY = 300 // ms

function getFontFamily(family: ReaderSettings['fontFamily']): string {
  switch (family) {
    case 'serif': return 'Georgia, "Times New Roman", serif'
    case 'sans': return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    case 'dyslexic': return '"OpenDyslexic", sans-serif'
  }
}

export const ReaderContent = forwardRef<HTMLElement, Props>(
  function ReaderContent({ html, settings, onTap, onDoubleTap, onLeftTap, onRightTap, containerRef }, ref) {
    const fontFamily = getFontFamily(settings.fontFamily)
    const lastTapRef = useRef<number>(0)
    const tapTimeoutRef = useRef<number | null>(null)

    const handleClick = useCallback((e: React.MouseEvent) => {
      // Don't toggle bar when clicking links (footnotes, etc.)
      const target = e.target as HTMLElement
      if (target.tagName === 'A' || target.closest('a')) {
        return
      }

      const now = Date.now()
      const timeSinceLastTap = now - lastTapRef.current

      // Double-tap detected
      if (timeSinceLastTap < DOUBLE_TAP_DELAY) {
        // Clear pending single-tap
        if (tapTimeoutRef.current) {
          clearTimeout(tapTimeoutRef.current)
          tapTimeoutRef.current = null
        }
        lastTapRef.current = 0
        // Only call onDoubleTap if it exists, otherwise just ignore (let browser select word)
        if (onDoubleTap) {
          onDoubleTap()
        }
        return
      }

      // First tap - wait to see if it's a double-tap
      lastTapRef.current = now

      // Clear any existing timeout
      if (tapTimeoutRef.current) {
        clearTimeout(tapTimeoutRef.current)
      }

      // Determine tap zone (left 25%, center 50%, right 25%)
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const x = e.clientX - rect.left
      const width = rect.width
      const leftZone = width * 0.25
      const rightZone = width * 0.75

      // Delay single-tap action to distinguish from double-tap
      tapTimeoutRef.current = window.setTimeout(() => {
        tapTimeoutRef.current = null
        if (onLeftTap && x < leftZone) {
          onLeftTap()
        } else if (onRightTap && x > rightZone) {
          onRightTap()
        } else {
          onTap()
        }
      }, DOUBLE_TAP_DELAY)
    }, [onTap, onDoubleTap, onLeftTap, onRightTap])

    return (
      <div className="reader-content-wrapper" ref={containerRef as React.RefObject<HTMLDivElement>} onClick={handleClick}>
        <article
          ref={ref as React.RefObject<HTMLElement>}
          className="reader-content"
          style={{
            fontSize: `${settings.fontSize}px`,
            lineHeight: settings.lineHeight,
            fontFamily,
            textAlign: settings.textAlign,
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    )
  }
)
