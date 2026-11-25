import { describe, it, expect } from 'vitest'
import { t } from '../i18n'
import { formatReadingMinutes, formatStreakDays, readingStatsBarLabels } from './readingStats'

const en = (key: string) => t('en', key)
const bars = (...starts: string[]) => starts.map(start => ({ start, minutes: 0 }))

describe('reading stats display', () => {
  it('a reader sees time read in hours and minutes', () => {
    expect(formatReadingMinutes(0, en)).toBe('0 min')
    expect(formatReadingMinutes(45, en)).toBe('45 min')
    expect(formatReadingMinutes(120, en)).toBe('2 h')
    expect(formatReadingMinutes(135, en)).toBe('2 h 15 min')
  })

  it('a streak of one day reads singular', () => {
    expect(formatStreakDays(1, en)).toBe('1 day')
    expect(formatStreakDays(12, en)).toBe('12 days')
  })

  it('a week is labelled Mon..Sun from the bar dates', () => {
    const week = bars('2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29')
    expect(readingStatsBarLabels({ period: 'week', bars: week }, en)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  })

  it('a month shows every seventh day number, a year the month names', () => {
    const month = bars(...Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`))
    const labels = readingStatsBarLabels({ period: 'month', bars: month }, en)
    expect(labels.filter(Boolean)).toEqual(['1', '8', '15', '22', '29'])
    expect(readingStatsBarLabels({ period: 'halfyear', bars: bars('2026-06-01', '2026-11-01') }, en)).toEqual(['Jun', 'Nov'])
  })
})
