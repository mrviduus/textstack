import { useCallback, useEffect, useRef } from 'react'
import { PROGRESS_GET_TIMEOUT_MS, PROGRESS_LATE_CHECK_TIMEOUT_MS } from '../lib/progressSync'

/**
 * When to ask the server whether another device recorded a newer position (web reader R4).
 * The reflow reader and the PDF view share it; each supplies its own `check`.
 *
 * - The open had no server answer (`unanswered`): ask in the background, at once and then on a
 *   bounded backoff, and again whenever the browser comes back online, until one answer arrives.
 * - The tab becomes visible again: ask — another device may have read on meanwhile. At most
 *   once per VISIBLE_THROTTLE_MS, so flicking between tabs is not a request each time.
 *
 * One check at a time: while one is in flight, another trigger does nothing (it never aborts a
 * slower check to replace it with a shorter one).
 *
 * Every check gets its own signal, aborted on its timeout, on `resetKey` change (another chapter
 * or document) and on unmount, so a late answer can never move a reader who is somewhere else.
 *
 * `check` resolves true when the server ANSWERED (whatever it said) and false when it did not.
 * The hook only reads `answeredRef`; what to do with an answer is the caller's business.
 */
const LATE_CHECK_DELAYS_MS = [0, 10_000, 30_000]
const VISIBLE_THROTTLE_MS = 30_000

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

  /** Starts a check; false when none started (not ready, or one already in flight). */
  const run = useCallback((timeoutMs: number): boolean => {
    const fn = checkRef.current
    if (!fn || !readyRef.current || inFlightRef.current) return false
    const c = new AbortController()
    inFlightRef.current = c
    const timer = setTimeout(() => c.abort(), timeoutMs)
    void fn(c.signal)
      .then((answered) => { if (answered && !c.signal.aborted) answeredRef.current = true })
      .catch(() => { /* a failed check is an unanswered one */ })
      .finally(() => {
        clearTimeout(timer)
        if (inFlightRef.current === c) inFlightRef.current = null
      })
    return true
  }, [])

  // Another chapter / document, or unmount: whatever is in flight answers for a page that is gone.
  useEffect(() => () => {
    inFlightRef.current?.abort()
    inFlightRef.current = null
  }, [resetKey])

  // The open had no answer: bounded background retries.
  useEffect(() => {
    if (!ready || !unanswered || answeredRef.current) return
    const timers = LATE_CHECK_DELAYS_MS.map((d) => setTimeout(() => {
      if (!answeredRef.current) run(PROGRESS_LATE_CHECK_TIMEOUT_MS)
    }, d))
    return () => timers.forEach(clearTimeout)
  }, [ready, unanswered, resetKey, run])

  const lastVisibleCheckRef = useRef(-Infinity)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastVisibleCheckRef.current < VISIBLE_THROTTLE_MS) return
      // Stamped only when a check really started: an early exit is not a check.
      if (run(PROGRESS_GET_TIMEOUT_MS)) lastVisibleCheckRef.current = Date.now()
    }
    const onOnline = () => {
      if (unansweredRef.current && !answeredRef.current) run(PROGRESS_LATE_CHECK_TIMEOUT_MS)
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
