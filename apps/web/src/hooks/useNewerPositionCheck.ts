import { useCallback, useEffect, useRef } from 'react'
import { PROGRESS_GET_TIMEOUT_MS, PROGRESS_LATE_CHECK_TIMEOUT_MS } from '../lib/progressSync'

/**
 * When to ask the server whether another device recorded a newer position (web reader R4).
 * The reflow reader and the PDF view share it; each supplies its own `check`.
 *
 * - The open had no server answer (`unanswered`): ask in the background, at once and then on a
 *   bounded backoff, and again whenever the browser comes back online, until one answer arrives.
 * - The tab becomes visible again: always ask — another device may have read on meanwhile.
 *
 * Every check gets its own signal, aborted on its timeout, on `resetKey` change (another chapter
 * or document) and on unmount, so a late answer can never move a reader who is somewhere else.
 *
 * `check` resolves true when the server ANSWERED (whatever it said) and false when it did not.
 * The hook only reads `answeredRef`; what to do with an answer is the caller's business.
 */
const LATE_CHECK_DELAYS_MS = [0, 10_000, 30_000]

export function useNewerPositionCheck(
  check: ((signal: AbortSignal) => Promise<boolean>) | undefined,
  { ready, unanswered, resetKey }: { ready: boolean; unanswered: boolean; resetKey: string | null | undefined },
) {
  const checkRef = useRef(check)
  checkRef.current = check
  const readyRef = useRef(ready)
  readyRef.current = ready
  const unansweredRef = useRef(unanswered)
  unansweredRef.current = unanswered
  const answeredRef = useRef(false)
  const inFlightRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!unanswered) answeredRef.current = false
  }, [unanswered])

  const run = useCallback(async (timeoutMs: number) => {
    const fn = checkRef.current
    if (!fn || !readyRef.current) return
    inFlightRef.current?.abort()
    const c = new AbortController()
    inFlightRef.current = c
    const timer = setTimeout(() => c.abort(), timeoutMs)
    try {
      const answered = await fn(c.signal)
      if (answered && !c.signal.aborted) answeredRef.current = true
    } finally {
      clearTimeout(timer)
      if (inFlightRef.current === c) inFlightRef.current = null
    }
  }, [])

  // Another chapter / document, or unmount: whatever is in flight answers for a page that is gone.
  useEffect(() => () => { inFlightRef.current?.abort() }, [resetKey])

  // The open had no answer: bounded background retries.
  useEffect(() => {
    if (!ready || !unanswered || answeredRef.current) return
    const timers = LATE_CHECK_DELAYS_MS.map((d) => setTimeout(() => {
      if (!answeredRef.current) void run(PROGRESS_LATE_CHECK_TIMEOUT_MS)
    }, d))
    return () => timers.forEach(clearTimeout)
  }, [ready, unanswered, resetKey, run])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void run(PROGRESS_GET_TIMEOUT_MS)
    }
    const onOnline = () => {
      if (unansweredRef.current && !answeredRef.current) void run(PROGRESS_LATE_CHECK_TIMEOUT_MS)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [run])

  return { answeredRef }
}
