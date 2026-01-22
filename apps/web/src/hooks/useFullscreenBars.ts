import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Manages bar visibility in fullscreen mode.
 * Shows bars on mouse move, hides after 2 seconds of inactivity.
 */
export function useFullscreenBars(isFullscreen: boolean) {
  const [showBars, setShowBars] = useState(false)
  const hideTimeoutRef = useRef<number | null>(null)

  const handleMouseMove = useCallback(() => {
    if (!isFullscreen) return

    setShowBars(true)

    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
    }

    hideTimeoutRef.current = window.setTimeout(() => {
      setShowBars(false)
    }, 2000)
  }, [isFullscreen])

  useEffect(() => {
    if (isFullscreen) {
      window.addEventListener('mousemove', handleMouseMove)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
      }
    } else {
      setShowBars(false)
    }
  }, [isFullscreen, handleMouseMove])

  return showBars
}
