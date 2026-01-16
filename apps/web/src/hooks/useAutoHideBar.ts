import { useState, useCallback } from 'react'

/**
 * Hook for toggling bar visibility.
 * Desktop: bars always visible (no auto-hide)
 * Mobile: use show() to reveal bars temporarily
 */
export function useAutoHideBar() {
  const [visible, setVisible] = useState(true)

  const show = useCallback(() => {
    setVisible(true)
  }, [])

  const toggle = useCallback(() => {
    setVisible((v) => !v)
  }, [])

  return { visible, show, toggle }
}
