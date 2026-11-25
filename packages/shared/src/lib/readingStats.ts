/**
 * Display helpers for the Profile "Reading" block (#1366), one copy for web and mobile.
 *
 * `t` is either app's translate (key in, raw string out); `{{…}}` is filled here because mobile's
 * `t()` takes no parameters. Day and month names come from the catalogue, not the platform
 * formatter: Hermes ships without full ICU (see `apps/mobile/src/lib/buildInfo.ts`).
 */
import type { ReadingStatsDto, ReadingStatsPeriod } from '../types/api'

type T = (key: string) => string

/** Literal keys, so the unused-key tests see them. */
export const READING_STATS_PERIODS: { period: ReadingStatsPeriod; key: string }[] = [
  { period: 'week', key: 'profile.stats.week' },
  { period: 'month', key: 'profile.stats.month' },
  { period: 'halfyear', key: 'profile.stats.halfyear' },
  { period: 'year', key: 'profile.stats.year' },
]

/** 135 → "2 h 15 min", 120 → "2 h", 45 → "45 min". */
export function formatReadingMinutes(minutes: number, t: T): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return t('profile.stats.minutes').replace('{{m}}', String(m))
  if (m === 0) return t('profile.stats.hours').replace('{{h}}', String(h))
  return t('profile.stats.hoursMinutes').replace('{{h}}', String(h)).replace('{{m}}', String(m))
}

/** 1 → "1 day", 3 → "3 days". */
export function formatStreakDays(n: number, t: T): string {
  return t(n === 1 ? 'profile.stats.dayOne' : 'profile.stats.dayMany').replace('{{n}}', String(n))
}

/** One label per bar: weekday (week), sparse day numbers 1, 8, 15… (month), month name (halfyear, year). */
export function readingStatsBarLabels(stats: Pick<ReadingStatsDto, 'period' | 'bars'>, t: T): string[] {
  const weekdays = t('profile.stats.weekdays').split(' ') // Mon..Sun
  const months = t('profile.stats.months').split(' ')
  return stats.bars.map(({ start }) => {
    const month = Number(start.slice(5, 7))
    const day = Number(start.slice(8, 10))
    switch (stats.period) {
      case 'week': return weekdays[(new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7] ?? ''
      case 'month': return (day - 1) % 7 === 0 ? String(day) : ''
      default: return months[month - 1] ?? ''
    }
  })
}
