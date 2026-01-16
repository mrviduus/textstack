import { useState, useEffect } from 'react'

const MOBILE_BREAKPOINT = 899

// SSR-safe initial value
const getInitialValue = () => {
  if (typeof window === 'undefined') return false
  return window.innerWidth <= MOBILE_BREAKPOINT
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(getInitialValue)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  return isMobile
}
