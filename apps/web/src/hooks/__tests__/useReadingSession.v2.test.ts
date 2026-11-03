import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const submitSession = vi.fn(async () => ({}))
vi.mock('../../api/readingTracking', () => ({ submitSession: () => submitSession() }))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }))
vi.mock('../../lib/analytics', () => ({ trackReadingSessionEnd: vi.fn() }))
let v2On = true
vi.mock('../../api/v2', () => ({ v2Enabled: () => v2On }))
const putSession = vi.fn(async () => ({}))
vi.mock('@textstack/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@textstack/shared')>()),
  v2Api: { putSession: (...a: unknown[]) => putSession(...(a as [])) },
}))

import { useReadingSession } from '../useReadingSession'

/** Read 20 s and leave: the session ends (unmount) and is queued, then sent. */
function readAndLeave(opts: { editionId?: string; userBookId?: string }) {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(() => true), configurable: true })
  const { result, unmount } = renderHook(() => useReadingSession({ ...opts, totalWords: 1000, startPercent: 0.1, isAuthenticated: true }))
  act(() => { result.current.updatePercent(0.1); result.current.recordActivity() })
  act(() => { vi.advanceTimersByTime(20_000) })
  act(() => { result.current.updatePercent(0.3); result.current.recordActivity() })
  unmount()
}

describe('useReadingSession on V2', () => {
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); v2On = true; putSession.mockClear(); submitSession.mockClear() })

  it("sends a user book's session to the V2 route under a client session id, not the beacon", async () => {
    readAndLeave({ userBookId: 'b1' })
    await vi.waitFor(() => expect(putSession).toHaveBeenCalledTimes(1))
    const [id, body] = putSession.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(id).toMatch(/[0-9a-f-]{36}/)
    expect(body).toMatchObject({ bookId: 'b1', startPercent: 0.1, endPercent: 0.3 })
    expect(navigator.sendBeacon).not.toHaveBeenCalled()
    expect(submitSession).not.toHaveBeenCalled()
  })

  it('keeps a catalog session on the legacy route', () => {
    readAndLeave({ editionId: 'e1' })
    expect(JSON.parse(localStorage.getItem('reading.pendingSessions') || '[]')[0].clientSessionId).toBeUndefined()
    expect(navigator.sendBeacon).toHaveBeenCalled()
  })
})
