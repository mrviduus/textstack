import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Manages immersive mode for mobile reading.
 * Auto-hides UI after 3 seconds, shows on tap.
 */
export function useImmersiveMode(isMobile: boolean, isLoading: boolean) {
  const [immersiveMode, setImmersiveMode] = useState(false)
  const timerRef = useRef<number | null>(null)

  const startTimer = useCallback(() => {
    if (!isMobile) return

    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = window.setTimeout(() => {
      setImmersiveMode(true)
    }, 3000)
  }, [isMobile])

  const showBars = useCallback(() => {
    setImmersiveMode(false)
    startTimer()
  }, [startTimer])

  // Start timer when mobile and not loading
  useEffect(() => {
    if (isMobile && !isLoading) {
      startTimer()
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [isMobile, isLoading, startTimer])

  return {
    immersiveMode,
    showBars,
    startTimer,
  }
}
