import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// Count real request paths: mock only the transport, keep api modules + hooks real.
const authFetch = vi.fn(async (path: string) => {
  if (path === '/me/reading/pace') return { wpm: 250, sessionCount: 5, isUserSpecific: true }
  if (path === '/me/vocabulary/stats') return { dueNow: 3, reviewedToday: 2, streak: 1 }
  return { todaySeconds: 0, todayVocabReviews: 0, dailyGoal: null, currentStreak: 0 }
})
vi.mock('../api/client', () => ({ authFetch: (p: string) => authFetch(p) }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }))

import { useReadingPace } from './useReadingPace'
import { useQuickStats } from './useQuickStats'

const calls = (prefix: string) => authFetch.mock.calls.filter(([p]) => p.startsWith(prefix)).length

beforeEach(() => {
  authFetch.mockClear()
  localStorage.clear()
})

describe('fewer requests', () => {
  it('useReadingPace: many cards on a cold cache send one /me/reading/pace', async () => {
    const hooks = Array.from({ length: 6 }, () => renderHook(() => useReadingPace()))
    await waitFor(() => hooks.forEach(h => expect(h.result.current.wpm).toBe(250)))
    expect(calls('/me/reading/pace')).toBe(1)
  })

  it('Header quick stats fetch vocab only, keeping cached reading fields', async () => {
    localStorage.setItem('reading.quickStats', JSON.stringify({ todaySeconds: 600, currentStreak: 4 }))
    const header = renderHook(() => useQuickStats({ includeReading: false }))
    await waitFor(() => expect(header.result.current?.vocabDueNow).toBe(3))
    expect(header.result.current?.todaySeconds).toBe(600)
    expect(calls('/me/reading/stats')).toBe(0)
    expect(calls('/me/vocabulary/stats')).toBe(1)
  })

  it('reader quick stats still fetch both', async () => {
    renderHook(() => useQuickStats())
    await waitFor(() => expect(calls('/me/reading/stats')).toBe(1))
    expect(calls('/me/vocabulary/stats')).toBe(1)
  })
})
