import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import {
  appendPendingSession,
  drainPendingSessions,
  isPermanentSessionRejection,
  MAX_PENDING_SESSIONS,
  MAX_PENDING_SESSION_AGE_MS,
  type PendingSession,
} from './pendingSessions'

const NOW = Date.parse('2026-10-04T12:00:00Z')

function session(startMsAgo: number, overrides: Partial<PendingSession> = {}): PendingSession {
  const start = NOW - startMsAgo
  return {
    editionId: 'e1',
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 120_000).toISOString(),
    durationSeconds: 60,
    wordsRead: 10,
    startPercent: 0.1,
    endPercent: 0.2,
    ...overrides,
  }
}

describe('appendPendingSession', () => {
  it('appendPendingSession_BeyondCap_DropsOldest', () => {
    let q: PendingSession[] = []
    for (let i = 0; i < MAX_PENDING_SESSIONS + 3; i++) q = appendPendingSession(q, session(0, { wordsRead: i }))
    expect(q).toHaveLength(MAX_PENDING_SESSIONS)
    expect(q[0].wordsRead).toBe(3)
    expect(q[q.length - 1].wordsRead).toBe(MAX_PENDING_SESSIONS + 2)
  })

  it('appendPendingSession_DoesNotMutateInput', () => {
    const q: PendingSession[] = []
    appendPendingSession(q, session(0))
    expect(q).toHaveLength(0)
  })
})

describe('isPermanentSessionRejection', () => {
  it.each([
    [400, true], [404, true], [403, true],
    [401, false], [408, false], [429, false], [500, false], [503, false], [0, false],
  ])('status %i → %s', (status, expected) => {
    expect(isPermanentSessionRejection(new ApiError(status, 'x'))).toBe(expected)
  })

  it('isPermanentSessionRejection_PlainError_IsTransient', () => {
    expect(isPermanentSessionRejection(new TypeError('Network request failed'))).toBe(false)
  })
})

describe('drainPendingSessions', () => {
  it('drainPendingSessions_AllSucceed_ReturnsEmpty', async () => {
    const sent: PendingSession[] = []
    const kept = await drainPendingSessions([session(1000), session(2000)], async (s) => { sent.push(s) }, NOW)
    expect(kept).toEqual([])
    expect(sent).toHaveLength(2)
  })

  it('drainPendingSessions_NetworkFailure_KeepsSession', async () => {
    const s = session(1000)
    const kept = await drainPendingSessions([s], async () => { throw new ApiError(0, 'offline') }, NOW)
    expect(kept).toEqual([s])
  })

  it('drainPendingSessions_PermanentRejection_DropsOnlyThatSession', async () => {
    const bad = session(1000, { editionId: 'gone' })
    const ok = session(2000)
    const flaky = session(3000, { editionId: 'flaky' })
    const kept = await drainPendingSessions([bad, ok, flaky], async (s) => {
      if (s.editionId === 'gone') throw new ApiError(404, 'gone')
      if (s.editionId === 'flaky') throw new ApiError(503, 'down')
    }, NOW)
    expect(kept).toEqual([flaky])
  })

  it('drainPendingSessions_ExpiredSession_DroppedUnsent', async () => {
    const sent: PendingSession[] = []
    const kept = await drainPendingSessions([session(MAX_PENDING_SESSION_AGE_MS)], async (s) => { sent.push(s) }, NOW)
    expect(kept).toEqual([])
    expect(sent).toEqual([])
  })

  it('drainPendingSessions_UnparseableStart_DroppedUnsent', async () => {
    const sent: PendingSession[] = []
    const kept = await drainPendingSessions([session(0, { startedAt: 'nope' })], async (s) => { sent.push(s) }, NOW)
    expect(kept).toEqual([])
    expect(sent).toEqual([])
  })

  it('drainPendingSessions_DurationLongerThanSpan_ClampedOnSend', async () => {
    const sent: PendingSession[] = []
    await drainPendingSessions([session(1000, { durationSeconds: 500 })], async (s) => { sent.push(s) }, NOW)
    expect(sent[0].durationSeconds).toBe(120)
  })
})
