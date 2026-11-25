import { useEffect, useState } from 'react'
import {
  syncApi, READING_STATS_PERIODS, formatReadingMinutes, formatStreakDays, readingStatsBarLabels,
  type ReadingStatsDto, type ReadingStatsPeriod,
} from '@textstack/shared'
import { useTranslation } from '../../hooks/useTranslation'

/**
 * Profile "Reading" block (#1366): streaks, a period switch, its totals and bars. Hidden when the first
 * request fails; once something loaded, a failed period says so in a line.
 */
export function ReadingStatsSection() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<ReadingStatsPeriod>('week')
  /** The shown period's answer; cleared on a switch so old bars never sit under the new button. */
  const [stats, setStats] = useState<ReadingStatsDto | null>(null)
  /** The last answer of any period: the streaks, and whether the section has ever loaded. */
  const [last, setLast] = useState<ReadingStatsDto | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    syncApi.readingStats(period).then(
      s => { if (live) { setStats(s); setLast(s); setFailed(false) } },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [period])

  const choose = (p: ReadingStatsPeriod) => {
    if (p === period) return
    setStats(null)
    setFailed(false)
    setPeriod(p)
  }

  if (!last) {
    if (failed) return null
    return (
      <section className="reading-stats reading-stats--loading" aria-busy="true" data-testid="reading-stats-skeleton">
        <div className="reading-stats__skeleton" />
        <div className="reading-stats__skeleton reading-stats__skeleton--chart" />
      </section>
    )
  }

  let body
  if (stats) {
    const labels = readingStatsBarLabels(stats, t)
    const max = Math.max(1, ...stats.bars.map(b => b.minutes))
    body = (
      <>
        <div className="reading-stats__figures">
          <div><span className="reading-stats__value">{formatReadingMinutes(stats.minutes, t)}</span><span className="reading-stats__caption">{t('profile.stats.timeRead')}</span></div>
          <div><span className="reading-stats__value">{stats.daysRead}</span><span className="reading-stats__caption">{t('profile.stats.daysRead')}</span></div>
        </div>
        <div className="reading-stats__chart" role="img" aria-label={t('profile.stats.chartLabel')}>
          {stats.bars.map((b, i) => (
            <div key={b.start} className="reading-stats__col" title={`${b.start}: ${formatReadingMinutes(b.minutes, t)}`} data-testid="reading-stats-bar">
              <div className="reading-stats__track">
                {b.minutes > 0 && <div className="reading-stats__bar" style={{ height: `${(b.minutes / max) * 100}%` }} />}
              </div>
              <span className="reading-stats__label">{labels[i]}</span>
            </div>
          ))}
        </div>
      </>
    )
  } else if (failed) {
    body = <p className="reading-stats__caption">{t('profile.stats.loadFailed')}</p>
  } else {
    body = <div className="reading-stats__skeleton reading-stats__skeleton--chart" data-testid="reading-stats-skeleton" />
  }

  return (
    <section className="reading-stats" aria-labelledby="reading-stats-title" aria-busy={!stats && !failed}>
      <h3 id="reading-stats-title" className="reading-stats__title">{t('profile.stats.title')}</h3>
      <div className="reading-stats__figures">
        <div><span className="reading-stats__value">{formatStreakDays(last.currentStreak, t)}</span><span className="reading-stats__caption">{t('profile.stats.currentStreak')}</span></div>
        <div><span className="reading-stats__value">{formatStreakDays(last.bestStreak, t)}</span><span className="reading-stats__caption">{t('profile.stats.bestStreak')}</span></div>
      </div>
      <div className="reading-stats__switch" role="group" aria-label={t('profile.stats.periodLabel')}>
        {READING_STATS_PERIODS.map(p => (
          <button
            key={p.period}
            type="button"
            className="reading-stats__segment"
            aria-pressed={p.period === period}
            onClick={() => choose(p.period)}
          >
            {t(p.key)}
          </button>
        ))}
      </div>
      {body}
    </section>
  )
}
