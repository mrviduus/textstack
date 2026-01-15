import { useEffect, useRef, useCallback } from 'react'

interface UseNetworkRecoveryOptions {
  onWake?: () => void
  onOnline?: () => void
}

export function useNetworkRecovery(options?: UseNetworkRecoveryOptions) {
  const abortControllerRef = useRef<AbortController | null>(null)
  const isStaleRef = useRef(false)

  // Mark current request as stale (call before fetch)
  const markFetchStart = useCallback(() => {
    abortControllerRef.current = new AbortController()
    isStaleRef.current = false
    return abortControllerRef.current.signal
  }, [])

  // Abort stale request if any
  const abortStaleFetch = useCallback(() => {
    if (abortControllerRef.current && !abortControllerRef.current.signal.aborted) {
      isStaleRef.current = true
      abortControllerRef.current.abort()
    }
  }, [])

  // Check if last abort was due to staleness (wake/recovery)
  const wasAbortedDueToWake = useCallback(() => {
    return isStaleRef.current
  }, [])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Phone woke up - abort any hanging requests
        abortStaleFetch()
        options?.onWake?.()
      }
    }

    const handleOnline = () => {
      options?.onOnline?.()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('online', handleOnline)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('online', handleOnline)
    }
  }, [abortStaleFetch, options])

  return {
    markFetchStart,
    abortStaleFetch,
    wasAbortedDueToWake,
  }
}
