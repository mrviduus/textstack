import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api/readingTracking', () => ({ submitSession: vi.fn(async () => ({})) }))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }))
vi.mock('../../lib/analytics', () => ({ trackReadingSessionEnd: vi.fn() }))

import { useReadingSession } from '../useReadingSession'

// ReaderPage passes `startPercent: overallProgress` — the LIVE progress. Copying it into the
// start ref on every render made start == current at submit, so web sessions read ~0 words.
describe('useReadingSession — start percent is fixed once per session', () => {
  afterEach(() => { vi.useRealTimers(); localStorage.clear() })

  it('wordsRead counts what was read since the session started, not since the last render', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(() => true), configurable: true })
    const opts = { editionId: 'e1', totalWords: 1000, isAuthenticated: true }

    const { result, rerender, unmount } = renderHook((p: { startPercent: number }) =>
      useReadingSession({ ...opts, ...p }), { initialProps: { startPercent: 0.1 } })
    act(() => {
      result.current.updatePercent(0.1)
      result.current.recordActivity()
    })
    // The reader reads 30% of the book; ReaderPage re-renders with the live progress.
    act(() => { vi.advanceTimersByTime(20_000) })
    rerender({ startPercent: 0.4 })
    act(() => {
      result.current.updatePercent(0.4)
      result.current.recordActivity()
    })
    unmount()

    const sent = JSON.parse(localStorage.getItem('reading.pendingSessions') || '[]')
    expect(sent).toHaveLength(1)
    expect(sent[0].startPercent).toBeCloseTo(0.1)
    expect(sent[0].endPercent).toBeCloseTo(0.4)
    expect(sent[0].wordsRead).toBe(300)
  })
})
