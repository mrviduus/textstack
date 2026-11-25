import { useEffect, useState } from 'react'
import {
  syncApi, READING_STATS_PERIODS, formatReadingMinutes, formatStreakDays, readingStatsBarLabels,
  type ReadingStatsDto, type ReadingStatsPeriod,
} from '@textstack/shared'
import { useTranslation } from '../../hooks/useTranslation'

/** Profile "Reading" block (#1366): streaks, a period switch, its totals and bars. Hidden on any failure. */
export function ReadingStatsSection() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<ReadingStatsPeriod>('week')
  const [stats, setStats] = useState<ReadingStatsDto | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    syncApi.readingStats(period).then(
      s => { if (live) setStats(s) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [period])

  if (failed) return null
  if (!stats) {
    return (
      <section className="reading-stats reading-stats--loading" aria-busy="true" data-testid="reading-stats-skeleton">
        <div className="reading-stats__skeleton" />
        <div className="reading-stats__skeleton reading-stats__skeleton--chart" />
      </section>
    )
  }

  const labels = readingStatsBarLabels(stats, t)
  const max = Math.max(1, ...stats.bars.map(b => b.minutes))

  return (
    <section className="reading-stats" aria-labelledby="reading-stats-title">
      <h3 id="reading-stats-title" className="reading-stats__title">{t('profile.stats.title')}</h3>
      <div className="reading-stats__figures">
        <div><span className="reading-stats__value">{formatStreakDays(stats.currentStreak, t)}</span><span className="reading-stats__caption">{t('profile.stats.currentStreak')}</span></div>
        <div><span className="reading-stats__value">{formatStreakDays(stats.bestStreak, t)}</span><span className="reading-stats__caption">{t('profile.stats.bestStreak')}</span></div>
      </div>
      <div className="reading-stats__switch" role="group" aria-label={t('profile.stats.periodLabel')}>
        {READING_STATS_PERIODS.map(p => (
          <button
            key={p.period}
            type="button"
            className="reading-stats__segment"
            aria-pressed={p.period === period}
            onClick={() => setPeriod(p.period)}
          >
            {t(p.key)}
          </button>
        ))}
      </div>
      <div className="reading-stats__figures">
        <div><span className="reading-stats__value">{formatReadingMinutes(stats.minutes, t)}</span><span className="reading-stats__caption">{t('profile.stats.timeRead')}</span></div>
        <div><span className="reading-stats__value">{stats.daysRead}</span><span className="reading-stats__caption">{t('profile.stats.daysRead')}</span></div>
      </div>
      <div className="reading-stats__chart" role="img" aria-label={t('profile.stats.chartLabel')}>
        {stats.bars.map((b, i) => (
          <div key={b.start} className="reading-stats__col" title={`${b.start}: ${formatReadingMinutes(b.minutes, t)}`} data-testid="reading-stats-bar">
            <div className="reading-stats__track">
              <div className="reading-stats__bar" style={{ height: `${(b.minutes / max) * 100}%` }} />
            </div>
            <span className="reading-stats__label">{labels[i]}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
