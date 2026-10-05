import { useState, useEffect, useCallback, useRef } from 'react'

const SCROLL_UP_THRESHOLD = 6
const SCROLL_DOWN_THRESHOLD = 48
const AUTO_HIDE_DELAY = 3000

/**
 * Auto-hides reader chrome (top bar + footer) to mirror the mobile reader.
 * - 3s after load → hide
 * - Scroll down ≥48px → hide immediately
 * - Scroll up ≥6px (or any up while bars hidden) → show immediately
 * - Tap handler calls showBars() to reveal; bars then stay until the user scrolls down
 */
export function useImmersiveMode(_enabled: boolean, isLoading: boolean) {
  const [immersiveMode, setImmersiveMode] = useState(false)
  const timerRef = useRef<number | null>(null)
  const baselineRef = useRef<number>(0)
  const lastDirRef = useRef<'up' | 'down' | null>(null)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const startTimer = useCallback(() => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      setImmersiveMode(true)
      lastDirRef.current = 'down'
    }, AUTO_HIDE_DELAY)
  }, [])

  const showBars = useCallback(() => {
    setImmersiveMode(false)
    lastDirRef.current = 'up'
    baselineRef.current = window.scrollY
    clearTimer()
  }, [])

  useEffect(() => {
    if (isLoading) return
    baselineRef.current = window.scrollY
    startTimer()
    return clearTimer
  }, [isLoading, startTimer])

  useEffect(() => {
    if (isLoading) return

    const onScroll = () => {
      const y = window.scrollY
      const delta = y - baselineRef.current

      if (delta < 0) {
        if (lastDirRef.current !== 'up' || delta <= -SCROLL_UP_THRESHOLD) {
          baselineRef.current = y
          if (lastDirRef.current !== 'up') {
            lastDirRef.current = 'up'
            setImmersiveMode(false)
            clearTimer()
          }
        }
      } else if (delta >= SCROLL_DOWN_THRESHOLD) {
        baselineRef.current = y
        if (lastDirRef.current !== 'down') {
          lastDirRef.current = 'down'
          setImmersiveMode(true)
          clearTimer()
        }
      }
      // Small downward motion below the threshold leaves the baseline alone:
      // the 48px threshold IS the wobble guard. Resetting it on every event
      // meant slow scrolling never accumulated 48px and never hid.
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [isLoading])

  return { immersiveMode, showBars, startTimer }
}
