import { useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { submitSession, type SubmitSessionResponse } from '../api/readingTracking'
import { ApiError } from '../api/client'
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

interface PendingSession {
  editionId?: string | null
  userBookId?: string | null
  startedAt: string
  endedAt: string
  durationSeconds: number
  wordsRead: number
  startPercent: number
  endPercent: number
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
      navigator.sendBeacon(`/api/me/reading/sessions?tz=${-new Date().getTimezoneOffset()}`, new Blob([payload], { type: 'application/json' }))
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
    existing.push(session)
    // Keep max 50 pending
    if (existing.length > 50) existing.splice(0, existing.length - 50)
    localStorage.setItem(PENDING_SESSIONS_KEY, JSON.stringify(existing))
  } catch {
    // localStorage might be full
  }
}

/** Remove `done` from the queue as it is NOW (re-read), matched by value, one entry each. */
function removePendingSessions(done: PendingSession[]) {
  if (done.length === 0) return
  const keys = done.map(s => JSON.stringify(s))
  const queue = JSON.parse(localStorage.getItem(PENDING_SESSIONS_KEY) || '[]') as PendingSession[]
  const left = queue.filter(s => {
    const i = keys.indexOf(JSON.stringify(s))
    if (i < 0) return true
    keys.splice(i, 1)
    return false
  })
  if (left.length > 0) localStorage.setItem(PENDING_SESSIONS_KEY, JSON.stringify(left))
  else localStorage.removeItem(PENDING_SESSIONS_KEY)
}

// Server rejects sessions older than 7 days — drop at 6 to give a safety margin.
const MAX_SESSION_AGE_MS = 6 * 24 * 60 * 60 * 1000

async function flushPendingSessions() {
  try {
    const raw = localStorage.getItem(PENDING_SESSIONS_KEY)
    if (!raw) return
    const all = JSON.parse(raw) as PendingSession[]
    if (all.length === 0) return

    // Never clear the queue up front: a session enqueued while we await the
    // network would be clobbered by the write-back. Remove only what this flush
    // settled, from a fresh read, at the end. Failed ones simply stay queued.
    const now = Date.now()
    const done: PendingSession[] = []
    for (const session of all) {
      const startedAt = Date.parse(session.startedAt)
      if (!Number.isFinite(startedAt) || now - startedAt >= MAX_SESSION_AGE_MS) {
        done.push(session)
        continue
      }
      try {
        // Sessions queued before the clamp above can carry a duration longer than their own span.
        const span = Math.floor((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000)
        await submitSession(span >= 0 ? { ...session, durationSeconds: Math.min(session.durationSeconds, span) } : session)
        // Success or duplicate — either way, done
        done.push(session)
      } catch (err) {
        // 404 = the referenced book was deleted/re-uploaded (old id gone). The
        // session can never succeed, so prune it permanently instead of re-queuing
        // — otherwise it retries forever and floods the endpoint.
        // 400 = the server rejected the payload itself; retrying the same bytes can never succeed.
        // Transient errors (network / 5xx) stay queued and are retried next flush.
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) done.push(session)
      }
    }

    removePendingSessions(done)
  } catch {
    // ignore
  }
}
