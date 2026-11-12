import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated } from 'react-native'

type Options = {
  topBarHeight: number
  footerHeight: number
  /** When the chapter first loads we briefly show then auto-hide bars. */
  autoHideTrigger: boolean
  hideDelayMs?: number
}

export function useReaderBars({ topBarHeight, footerHeight, autoHideTrigger, hideDelayMs = 3000 }: Options) {
  const [barsVisible, setBarsVisible] = useState(true)
  const barsVisibleRef = useRef(true)
  const barsAnim = useRef(new Animated.Value(1)).current
  const topBarTranslateY = barsAnim.interpolate({ inputRange: [0, 1], outputRange: [-topBarHeight, 0] })
  const footerTranslateY = barsAnim.interpolate({ inputRange: [0, 1], outputRange: [footerHeight, 0] })
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Reduced motion: the bars appear and go at once, no slide or fade.
  const reduceMotionRef = useRef(false)
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(r => { reduceMotionRef.current = r }, () => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', r => { reduceMotionRef.current = r })
    return () => sub.remove()
  }, [])

  const hideBars = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    if (!barsVisibleRef.current) return
    barsVisibleRef.current = false
    setBarsVisible(false)
    Animated.timing(barsAnim, { toValue: 0, duration: reduceMotionRef.current ? 0 : 300, useNativeDriver: true }).start()
  }, [barsAnim])

  const showBars = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    if (barsVisibleRef.current) return
    barsVisibleRef.current = true
    setBarsVisible(true)
    Animated.timing(barsAnim, { toValue: 1, duration: reduceMotionRef.current ? 0 : 200, useNativeDriver: true }).start()
  }, [barsAnim])

  const startHideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      hideBars()
    }, hideDelayMs)
  }, [hideBars, hideDelayMs])

  const toggleBars = useCallback(() => {
    if (barsVisibleRef.current) hideBars()
    else showBars()
  }, [hideBars, showBars])

  useEffect(() => {
    if (autoHideTrigger) startHideTimer()
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current) }
  }, [autoHideTrigger, startHideTimer])

  return {
    barsVisible,
    barsAnim,
    topBarTranslateY,
    footerTranslateY,
    showBars,
    hideBars,
    toggleBars,
  }
}
