import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// submitSession is driven per-test; keep a stable spy the mock delegates to.
const submitSession = vi.fn()
vi.mock('../../api/readingTracking', () => ({
  submitSession: (...args: unknown[]) => submitSession(...args),
}))

// Flush only runs when authenticated.
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}))

vi.mock('../../lib/analytics', () => ({
  trackReadingSessionEnd: vi.fn(),
}))

import { useReadingSession } from '../useReadingSession'
import { ApiError } from '../../api/client'

const KEY = 'reading.pendingSessions'

function makePendingSession() {
  const now = new Date()
  return {
    editionId: 'dead-book-id',
    userBookId: null,
    startedAt: now.toISOString(),
    endedAt: now.toISOString(),
    durationSeconds: 60,
    wordsRead: 100,
    startPercent: 0,
    endPercent: 0.1,
  }
}

const opts = { editionId: 'e1', totalWords: 100, startPercent: 0, isAuthenticated: true }

describe('useReadingSession — flushPendingSessions pruning', () => {
  beforeEach(() => {
    localStorage.clear()
    submitSession.mockReset()
  })

  it('prunes the pending session on a 404 (deleted book) — not re-queued', async () => {
    localStorage.setItem(KEY, JSON.stringify([makePendingSession()]))
    submitSession.mockRejectedValue(new ApiError(404, 'Not Found'))

    renderHook(() => useReadingSession(opts))

    await waitFor(() => expect(submitSession).toHaveBeenCalledTimes(1))
    // 404 => dropped permanently, nothing re-saved.
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
  })

  it('re-queues the pending session on a 5xx (transient) for retry', async () => {
    localStorage.setItem(KEY, JSON.stringify([makePendingSession()]))
    submitSession.mockRejectedValue(new ApiError(500, 'Server Error'))

    renderHook(() => useReadingSession(opts))

    await waitFor(() => expect(submitSession).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const raw = localStorage.getItem(KEY)
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw!)).toHaveLength(1)
    })
  })

  it('re-queues the pending session on a network error for retry', async () => {
    localStorage.setItem(KEY, JSON.stringify([makePendingSession()]))
    submitSession.mockRejectedValue(new Error('network down'))

    renderHook(() => useReadingSession(opts))

    await waitFor(() => expect(submitSession).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const raw = localStorage.getItem(KEY)
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw!)).toHaveLength(1)
    })
  })

  it('clamps a queued duration to its own span and drops a 400 instead of re-queuing it', async () => {
    const started = new Date(Date.now() - 27_600)
    const session = { ...makePendingSession(), startedAt: started.toISOString(), endedAt: new Date(started.getTime() + 27_600).toISOString(), durationSeconds: 30 }
    localStorage.setItem(KEY, JSON.stringify([session]))
    submitSession.mockRejectedValue(new ApiError(400, 'EndedAt - StartedAt must be >= DurationSeconds'))

    renderHook(() => useReadingSession(opts))

    await waitFor(() => expect(submitSession).toHaveBeenCalledTimes(1))
    expect(submitSession.mock.calls[0][0].durationSeconds).toBe(27)
    await waitFor(() => expect(localStorage.getItem(KEY) ?? '[]').toBe('[]'))
  })

  it('keeps a session enqueued while the flush is in flight (no clobber on write-back)', async () => {
    const old = makePendingSession()
    localStorage.setItem(KEY, JSON.stringify([old]))
    let resolveSubmit!: () => void
    submitSession.mockReturnValue(new Promise<void>(r => { resolveSubmit = r }))

    renderHook(() => useReadingSession(opts))
    await waitFor(() => expect(submitSession).toHaveBeenCalledTimes(1))

    // Another tab / the unload path enqueues while the request is outstanding.
    const fresh = { ...makePendingSession(), editionId: 'fresh-book' }
    localStorage.setItem(KEY, JSON.stringify([...JSON.parse(localStorage.getItem(KEY) ?? '[]'), fresh]))
    resolveSubmit()

    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual([fresh]))
  })

  it('keeps a failed session and one enqueued during the flush', async () => {
    localStorage.setItem(KEY, JSON.stringify([makePendingSession()]))
    let rejectSubmit!: (e: Error) => void
    submitSession.mockReturnValue(new Promise<void>((_, r) => { rejectSubmit = r }))

    renderHook(() => useReadingSession(opts))
    await waitFor(() => expect(submitSession).toHaveBeenCalledTimes(1))

    const fresh = { ...makePendingSession(), editionId: 'fresh-book' }
    localStorage.setItem(KEY, JSON.stringify([...JSON.parse(localStorage.getItem(KEY) ?? '[]'), fresh]))
    rejectSubmit(new Error('network down'))

    await waitFor(() => {
      const q = JSON.parse(localStorage.getItem(KEY) ?? '[]')
      expect(q.map((s: { editionId: string }) => s.editionId)).toEqual(['dead-book-id', 'fresh-book'])
    })
  })
})
