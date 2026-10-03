import { useEffect, useRef, useCallback } from 'react'
import { AppState } from 'react-native'
import { readingTrackingApi } from '@textstack/shared'
import type { SessionSnapshot } from '../lib/readerVisit'

const HEARTBEAT_MS = 30_000
const MIN_SECONDS = 10
const IDLE_THRESHOLD_MS = 3 * 60 * 1000 // 3 min — stop counting
const AUTO_END_MS = 5 * 60 * 1000 // 5 min — auto-end session

interface SessionConfig {
  editionId: string | null
  userBookId?: string | null
  /** Words the progress percent is a fraction of (the whole book — progress is book-wide). */
  wordCount: number
  isAuthenticated: boolean
  /** A session handed over by the previous chapter of this visit (`readerVisit.ts`). Read once, at mount. */
  carried?: SessionSnapshot | null
}

/**
 * Tracks reading session duration with idle detection.
 * Session starts on mount, ends on unmount, app background, or 5min idle.
 * Stops counting after 3min without activity (scroll/progress update).
 *
 * A chapter change remounts the reader; `handOff()` + `carried` keep one
 * session across it instead of ending it per chapter (`readerVisit.ts`).
 */
export function useReadingSession(config: SessionConfig) {
  const carried = config.carried ?? null
  const startTimeRef = useRef(carried?.startedAt ?? Date.now())
  const activeSecondsRef = useRef(carried?.activeSeconds ?? 0)
  const lastTickRef = useRef(Date.now())
  const lastActivityRef = useRef(Date.now())
  const startPercentRef = useRef(carried?.startPercent ?? 0)
  const currentPercentRef = useRef(carried?.currentPercent ?? 0)
  const submittedRef = useRef(carried?.submitted ?? false)
  // Adopted, not reset, the first time a book key arrives.
  const adoptRef = useRef(carried !== null)
  // Handed to the next chapter: the unmount must not submit what it now owns.
  const handedOffRef = useRef(false)
  const autoEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const submit = useCallback(() => {
    if (submittedRef.current) return
    if (!config.isAuthenticated) return
    if (!config.editionId && !config.userBookId) return

    const duration = activeSecondsRef.current
    if (duration < MIN_SECONDS) return

    submittedRef.current = true
    const wordsRead = Math.round(
      Math.abs(currentPercentRef.current - startPercentRef.current) * config.wordCount
    )

    const now = new Date()
    const data: Parameters<typeof readingTrackingApi.submitSession>[0] = {
      durationSeconds: Math.min(duration, 14400),
      wordsRead,
      startPercent: startPercentRef.current,
      endPercent: currentPercentRef.current,
      startedAt: new Date(startTimeRef.current).toISOString(),
      endedAt: now.toISOString(),
    }
    if (config.editionId) data.editionId = config.editionId
    if (config.userBookId) data.userBookId = config.userBookId

    readingTrackingApi.submitSession(data).catch(() => {})
  }, [config.isAuthenticated, config.editionId, config.userBookId, config.wordCount])

  const clearAutoEndTimer = useCallback(() => {
    if (autoEndTimerRef.current) {
      clearTimeout(autoEndTimerRef.current)
      autoEndTimerRef.current = null
    }
  }, [])

  const resetAutoEndTimer = useCallback(() => {
    clearAutoEndTimer()
    autoEndTimerRef.current = setTimeout(() => {
      submit() // auto-end after 5min idle
    }, AUTO_END_MS)
  }, [submit, clearAutoEndTimer])

  /**
   * Reset every piece of session state so a switch between books
   * (editionId/userBookId change) doesn't leak old counters or the
   * `submittedRef=true` latch. Keeps behaviour symmetric with the
   * AppState 'active' resume branch.
   */
  const resetSessionState = useCallback(() => {
    const now = Date.now()
    submittedRef.current = false
    startTimeRef.current = now
    lastTickRef.current = now
    lastActivityRef.current = now
    activeSecondsRef.current = 0
    startPercentRef.current = currentPercentRef.current
  }, [])

  // Heartbeat: increment active seconds only while a session is live
  // and the user has been active recently.
  useEffect(() => {
    const interval = setInterval(() => {
      if (submittedRef.current) {
        // Session already submitted — no-op until AppState or a
        // sessionKey change resets state.
        lastTickRef.current = Date.now()
        return
      }
      const now = Date.now()
      const sinceActivity = now - lastActivityRef.current
      if (sinceActivity < IDLE_THRESHOLD_MS) {
        const elapsed = Math.round((now - lastTickRef.current) / 1000)
        activeSecondsRef.current += Math.min(elapsed, 60)
      }
      lastTickRef.current = now
    }, HEARTBEAT_MS)
    return () => clearInterval(interval)
  }, [])

  // AppState: submit on background, resume on foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        submit()
        clearAutoEndTimer()
      } else if (state === 'active' && submittedRef.current) {
        // Resuming — start new session
        resetSessionState()
        resetAutoEndTimer()
      }
    })
    return () => sub.remove()
  }, [submit, resetAutoEndTimer, clearAutoEndTimer, resetSessionState])

  // Per-book lifecycle: start a fresh session when the tracked book
  // changes, submit + stop timers when the hook unmounts or switches
  // books. Keyed off (editionId, userBookId) so a navigation between
  // public/user books inside one hook instance still starts a clean
  // session (R-2).
  const sessionKey = config.editionId ?? config.userBookId ?? null
  useEffect(() => {
    if (!sessionKey) return
    if (adoptRef.current) adoptRef.current = false
    else resetSessionState()
    if (!submittedRef.current) resetAutoEndTimer()
    return () => {
      if (!handedOffRef.current) submit()
      clearAutoEndTimer()
    }
  }, [sessionKey, submit, resetAutoEndTimer, clearAutoEndTimer, resetSessionState])

  // Always the newest closure — the carry's fallback flush runs after unmount.
  const submitRef = useRef(submit)
  submitRef.current = submit

  /**
   * Stop owning the session and return it, for the next chapter of this visit.
   * The partial heartbeat since the last tick is counted in. `flush` submits it
   * from here if the next chapter never claims it.
   */
  const handOff = useCallback((): { snapshot: SessionSnapshot; flush: () => void } => {
    handedOffRef.current = true
    clearAutoEndTimer()
    const now = Date.now()
    const partial = now - lastActivityRef.current < IDLE_THRESHOLD_MS
      ? Math.min(Math.round((now - lastTickRef.current) / 1000), 60) : 0
    activeSecondsRef.current += partial
    lastTickRef.current = now
    return {
      snapshot: {
        startedAt: startTimeRef.current,
        activeSeconds: activeSecondsRef.current,
        startPercent: startPercentRef.current,
        currentPercent: currentPercentRef.current,
        submitted: submittedRef.current,
      },
      flush: () => submitRef.current(),
    }
  }, [clearAutoEndTimer])

  const updateProgress = useCallback((progress: number) => {
    lastActivityRef.current = Date.now() // user is active (scrolling)
    if (startPercentRef.current === 0 && currentPercentRef.current === 0) {
      startPercentRef.current = progress
    }
    currentPercentRef.current = progress

    // No point arming the auto-end after the session is closed —
    // otherwise we'd resurrect a dead session and resubmit it.
    if (submittedRef.current) return
    resetAutoEndTimer()
  }, [resetAutoEndTimer])

  // Time-only activity ping for the Original-layout PDF reader (ADR-012 S4c).
  // The PDF position is a PAGE fraction that must NOT feed into the word-based
  // `wordsRead` computation, so it keeps the session/streak alive (activity +
  // auto-end re-arm) WITHOUT touching startPercent/currentPercent. Mirrors web's
  // `readingSession.recordActivity()`.
  const recordActivity = useCallback(() => {
    lastActivityRef.current = Date.now()
    if (submittedRef.current) return
    resetAutoEndTimer()
  }, [resetAutoEndTimer])

  return { updateProgress, recordActivity, handOff, sessionStartedAt: startTimeRef.current }
}
