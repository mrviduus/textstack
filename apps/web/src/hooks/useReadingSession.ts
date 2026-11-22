import { ApiError } from '../api/client'
import { syncApi, toSyncSession, type PendingSession } from '@textstack/shared'

const PENDING_SESSIONS_KEY = 'reading.pendingSessions'

/**
 * The V2 reader's ended session (#1313): queued with this reader's sessions, then sent. Retried as theirs are
 * (every flush, at the next reader's mount); a 404 or 400 drops it. Never awaited by the reading path.
 */
export function queueReadingSession(session: PendingSession) {
  savePendingSession(session)
  void flushPendingSessions()
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

export async function flushPendingSessions() {
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
        const sent = span >= 0 ? { ...session, durationSeconds: Math.min(session.durationSeconds, span) } : session
        // A legacy session (queued by the retired reader) has no route: dropped.
        if (sent.clientSessionId) {
          // A replay of the same id answers 200: first write wins.
          const { clientSessionId } = sent
          try {
            await syncApi.putSession(clientSessionId, toSyncSession(sent))
          } catch (err) {
            // 404: the book is gone. The session never counted; never retried.
            if (!(err instanceof ApiError && err.status === 404)) throw err
            console.warn('[session] V2 session dropped (404)', clientSessionId)
          }
        }
        // Success or duplicate — either way, done
        done.push(session)
      } catch (err) {
        // 404 = the referenced book was deleted/re-uploaded (old id gone). The
        // session can never succeed, so prune it permanently instead of re-queuing
        // — otherwise it retries forever and floods the endpoint.
        // 400 = the server rejected the payload itself; retrying the same bytes can never succeed.
        // Transient errors (network / 5xx) stay queued and are retried next flush.
        if (err instanceof ApiError && [400, 404].includes(err.status)) done.push(session)
      }
    }

    removePendingSessions(done)
  } catch {
    // ignore
  }
}
