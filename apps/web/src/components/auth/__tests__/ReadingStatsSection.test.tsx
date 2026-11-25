import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { ReadingStatsDto, ReadingStatsPeriod } from '@textstack/shared'

const { api } = vi.hoisted(() => ({ api: { readingStats: vi.fn() } }))

vi.mock('@textstack/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@textstack/shared')>()
  return { ...real, syncApi: { ...real.syncApi, readingStats: api.readingStats } }
})

import { ReadingStatsSection } from '../ReadingStatsSection'

const bars = (n: number, month = false) =>
  Array.from({ length: n }, (_, i) => ({ start: month ? `2026-${String(i + 1).padStart(2, '0')}-01` : `2026-11-${String(i + 1).padStart(2, '0')}`, minutes: i * 5 }))

const stats = (period: ReadingStatsPeriod, n: number): ReadingStatsDto => ({
  period, from: '2026-11-23', to: '2026-11-29', minutes: 135, daysRead: 4, currentStreak: 3, bestStreak: 12, bars: bars(n, period === 'year' || period === 'halfyear'),
})

beforeEach(() => { api.readingStats.mockReset() })
afterEach(cleanup)

describe('Profile reading stats', () => {
  it('a reader sees their streaks and this week, a bar per day', async () => {
    api.readingStats.mockResolvedValue(stats('week', 7))
    render(<ReadingStatsSection />)

    expect(screen.getByTestId('reading-stats-skeleton')).toBeTruthy()
    expect(await screen.findByText('3 days')).toBeTruthy()
    expect(screen.getByText('12 days')).toBeTruthy()
    expect(screen.getByText('2 h 15 min')).toBeTruthy()
    expect(screen.getAllByTestId('reading-stats-bar')).toHaveLength(7)
    expect(api.readingStats).toHaveBeenCalledWith('week')
  })

  it('switching to Year asks again for the year and draws twelve months', async () => {
    api.readingStats.mockResolvedValueOnce(stats('week', 7)).mockResolvedValueOnce(stats('year', 12))
    render(<ReadingStatsSection />)
    await screen.findByText('3 days')

    fireEvent.click(screen.getByRole('button', { name: 'Year' }))

    // The week's bars go at once; the new period loads under a skeleton.
    expect(screen.queryAllByTestId('reading-stats-bar')).toHaveLength(0)
    expect(screen.getByTestId('reading-stats-skeleton')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByTestId('reading-stats-bar')).toHaveLength(12))
    expect(api.readingStats).toHaveBeenLastCalledWith('year')
    expect(screen.getByRole('button', { name: 'Year' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Dec')).toBeTruthy()
  })

  it('a failed switch keeps the section and says the period could not load', async () => {
    api.readingStats.mockResolvedValueOnce(stats('week', 7)).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<ReadingStatsSection />)
    await screen.findByText('3 days')

    fireEvent.click(screen.getByRole('button', { name: 'Month' }))

    expect(await screen.findByText("Couldn't load this period.")).toBeTruthy()
    expect(screen.getByText('3 days')).toBeTruthy()
    expect(screen.queryAllByTestId('reading-stats-bar')).toHaveLength(0)
  })

  it('a day without reading draws no bar', async () => {
    api.readingStats.mockResolvedValue(stats('week', 7)) // day 1 has 0 minutes
    render(<ReadingStatsSection />)
    await screen.findByText('3 days')

    const cols = screen.getAllByTestId('reading-stats-bar')
    expect(cols[0].querySelector('.reading-stats__bar')).toBeNull()
    expect(cols[1].querySelector('.reading-stats__bar')).not.toBeNull()
  })

  it('a failed first request hides the section without an error', async () => {
    api.readingStats.mockRejectedValue(new TypeError('Failed to fetch'))
    const { container } = render(<ReadingStatsSection />)

    await waitFor(() => expect(container.innerHTML).toBe(''))
  })
})
