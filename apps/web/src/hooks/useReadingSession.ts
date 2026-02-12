import { useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { submitSession, type SubmitSessionResponse } from '../api/readingTracking'

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
    if (!sessionActiveRef.current || activeSecondsRef.current < 10) {
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
      durationSeconds: Math.min(activeSecondsRef.current, 14400),
      wordsRead: totalWords
        ? Math.round(Math.abs(currentPercentRef.current - startPercentRef.current) * totalWords)
        : 0,
      startPercent: startPercentRef.current,
      endPercent: currentPercentRef.current,
    }

    sessionActiveRef.current = false
    activeSecondsRef.current = 0

    // Try sendBeacon first (reliable during unload)
    const payload = JSON.stringify(session)
    const url = '/api/me/reading/sessions'

    if (navigator.sendBeacon) {
      const sent = navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }))
      if (!sent) {
        savePendingSession(session)
      }
    } else {
      // Fallback: save to localStorage for later
      savePendingSession(session)
    }
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

async function flushPendingSessions() {
  try {
    const raw = localStorage.getItem(PENDING_SESSIONS_KEY)
    if (!raw) return
    const sessions = JSON.parse(raw) as PendingSession[]
    if (sessions.length === 0) return

    localStorage.removeItem(PENDING_SESSIONS_KEY)

    for (const session of sessions) {
      try {
        await submitSession(session)
      } catch {
        // Re-save failed ones
        savePendingSession(session)
      }
    }
  } catch {
    // ignore
  }
}
