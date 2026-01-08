import { useState, useEffect, useRef, useCallback } from 'react'

interface Options {
  hideDelay?: number // ms before auto-hide after scroll stops
  scrollThreshold?: number // px of scroll to trigger hide
}

export function useAutoHideBar(options: Options = {}) {
  const { hideDelay = 3000, scrollThreshold = 50 } = options
  const [visible, setVisible] = useState(true)
  const lastScrollY = useRef(0)
  const hideTimer = useRef<number | null>(null)

  const show = useCallback(() => {
    setVisible(true)
    // Reset hide timer
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setVisible(false), hideDelay)
  }, [hideDelay])

  const toggle = useCallback(() => {
    setVisible((v) => !v)
  }, [])

  useEffect(() => {
    let ticking = false

    const handleScroll = () => {
      if (ticking) return
      ticking = true

      requestAnimationFrame(() => {
        const currentY = window.scrollY
        const delta = currentY - lastScrollY.current

        // Always show bar when near top of page
        if (currentY < 100) {
          setVisible(true)
          if (hideTimer.current) clearTimeout(hideTimer.current)
        } else if (delta < -scrollThreshold) {
          // Scrolling up → show
          show()
        } else if (delta > scrollThreshold) {
          // Scrolling down → hide
          setVisible(false)
          if (hideTimer.current) clearTimeout(hideTimer.current)
        }

        lastScrollY.current = currentY
        ticking = false
      })
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [show, scrollThreshold])

  return { visible, show, toggle }
}
