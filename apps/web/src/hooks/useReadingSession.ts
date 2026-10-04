import { useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { submitSession, type SubmitSessionResponse } from '../api/readingTracking'
import { appendPendingSession, drainPendingSessions, type PendingSession } from '@textstack/shared'
import { trackReadingSessionEnd } from '../lib/analytics'

const PENDING_SESSIONS_KEY = 'reading.pendingSessions'
const HEARTBEAT_INTERVAL = 30_000 // 30s
const IDLE_THRESHOLD = 180_000 // 3min
const MAX_IDLE_BEFORE_END = 300_000 // 5min

interface UseReadingSessionOptions {
  editionId?: string
  userBookId?: string
  totalWords?: number
  startPercent: number
  isAuthenticated: boolean
}

export function useReadingSession(options: UseReadingSessionOptions) {
  const { isAuthenticated } = useAuth()
  const { editionId, userBookId, totalWords, startPercent } = options

  const startedAtRef = useRef<number>(0)
  const activeSecondsRef = useRef<number>(0)
  const lastActivityRef = useRef<number>(0)
  const heartbeatRef = useRef<number | null>(null)
  const startPercentRef = useRef(startPercent)
  const currentPercentRef = useRef(startPercent)
  const sessionActiveRef = useRef(false)
  const lastSubmitResponseRef = useRef<SubmitSessionResponse | null>(null)

  // Update refs when props change
  startPercentRef.current = startPercent

  const recordActivity = useCallback(() => {
    lastActivityRef.current = Date.now()

    // Start session on first activity if not started
    if (!sessionActiveRef.current && (editionId || userBookId)) {
      sessionActiveRef.current = true
      startedAtRef.current = Date.now()
      activeSecondsRef.current = 0
      startPercentRef.current = currentPercentRef.current
    }
  }, [editionId, userBookId])

  const updatePercent = useCallback((percent: number) => {
    currentPercentRef.current = percent
  }, [])

  const endAndSubmit = useCallback(() => {
    if (!sessionActiveRef.current) return

    // Wall-clock fallback: if heartbeat hasn't fired yet (< 30s session),
    // estimate active time from elapsed wall clock
    if (activeSecondsRef.current < 10 && startedAtRef.current > 0) {
      const elapsed = (Date.now() - startedAtRef.current) / 1000
      const sinceLastActivity = (Date.now() - lastActivityRef.current) / 1000
      if (sinceLastActivity < IDLE_THRESHOLD / 1000) {
        activeSecondsRef.current = Math.min(elapsed, 30)
      }
    }

    if (activeSecondsRef.current < 10) {
      sessionActiveRef.current = false
      return
    }
    if (!isAuthenticated) {
      sessionActiveRef.current = false
      return
    }

    const now = Date.now()
    const session: PendingSession = {
      editionId: editionId || null,
      userBookId: userBookId || null,
      startedAt: new Date(startedAtRef.current).toISOString(),
      endedAt: new Date(now).toISOString(),
      // Never more than the wall clock between start and end: the heartbeat ticks on a timer that
      // began at mount, so its first +30s can land before the session is 30s old, and the server
      // rejects duration > endedAt − startedAt with a 400 (found on prod 2026-10-02).
      durationSeconds: Math.min(Math.round(activeSecondsRef.current), 14400, Math.floor((now - startedAtRef.current) / 1000)),
      wordsRead: totalWords
        ? Math.round(Math.abs(currentPercentRef.current - startPercentRef.current) * totalWords)
        : 0,
      startPercent: startPercentRef.current,
      endPercent: currentPercentRef.current,
    }

    sessionActiveRef.current = false
    activeSecondsRef.current = 0

    // Always save to localStorage first (beacon is best-effort, can't detect server errors)
    savePendingSession(session)

    // Try sendBeacon as fast path (fire-and-forget)
    if (navigator.sendBeacon) {
      const payload = JSON.stringify(session)
      navigator.sendBeacon('/api/me/reading/sessions', new Blob([payload], { type: 'application/json' }))
    }

    // GA4: session end = core engagement Key Event. Fires only for authenticated
    // sessions (matches server-side tracking). Guest engagement is measured via
    // book_opened + GuestLimitsContext pageviews, not session duration.
    trackReadingSessionEnd({
      durationSeconds: session.durationSeconds,
      wordsRead: session.wordsRead,
      startPercent: session.startPercent,
      endPercent: session.endPercent,
      editionId: session.editionId,
      userBookId: session.userBookId,
    })
  }, [isAuthenticated, editionId, userBookId, totalWords])

  // Heartbeat: track active time
  useEffect(() => {
    if (!editionId && !userBookId) return

    heartbeatRef.current = window.setInterval(() => {
      if (!sessionActiveRef.current) return

      const now = Date.now()
      const timeSinceActivity = now - lastActivityRef.current

      if (timeSinceActivity < IDLE_THRESHOLD) {
        // User active — increment
        activeSecondsRef.current += HEARTBEAT_INTERVAL / 1000
      } else if (timeSinceActivity >= MAX_IDLE_BEFORE_END) {
        // Idle too long — end session
        endAndSubmit()
      }
      // Between IDLE_THRESHOLD and MAX_IDLE_BEFORE_END: just skip increment (idle)
    }, HEARTBEAT_INTERVAL)

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    }
  }, [editionId, userBookId, endAndSubmit])

  // Lifecycle: visibilitychange, beforeunload, unmount
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        endAndSubmit()
      }
    }
    const handleBeforeUnload = () => {
      endAndSubmit()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      endAndSubmit() // unmount
    }
  }, [endAndSubmit])

  // Flush pending sessions from localStorage on mount
  useEffect(() => {
    if (!isAuthenticated) return
    flushPendingSessions()
  }, [isAuthenticated])

  return {
    recordActivity,
    updatePercent,
    lastSubmitResponse: lastSubmitResponseRef.current,
    sessionStartedAt: sessionActiveRef.current ? startedAtRef.current : null,
  }
}

function savePendingSession(session: PendingSession) {
  try {
    const existing = JSON.parse(localStorage.getItem(PENDING_SESSIONS_KEY) || '[]') as PendingSession[]
    localStorage.setItem(PENDING_SESSIONS_KEY, JSON.stringify(appendPendingSession(existing, session)))
  } catch {
    // localStorage might be full
  }
}

// Cap, expiry, duration clamp and which errors are permanent: shared with mobile
// (packages/shared/src/reader/pendingSessions.ts).
async function flushPendingSessions() {
  try {
    const raw = localStorage.getItem(PENDING_SESSIONS_KEY)
    if (!raw) return
    const all = JSON.parse(raw) as PendingSession[]
    if (all.length === 0) return

    localStorage.removeItem(PENDING_SESSIONS_KEY)

    // Re-save only genuinely failed ones
    const failed = await drainPendingSessions(all, submitSession)
    if (failed.length > 0) {
      localStorage.setItem(PENDING_SESSIONS_KEY, JSON.stringify(failed))
    }
  } catch {
    // ignore
  }
}
