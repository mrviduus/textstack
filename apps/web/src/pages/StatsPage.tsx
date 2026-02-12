import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from '../hooks/useTranslation'
import { useReadingStats } from '../hooks/useReadingStats'
import { useReadingGoals } from '../hooks/useReadingGoals'
import { useAchievements } from '../hooks/useAchievements'
import { AchievementDefinitions } from '../lib/achievementDefinitions'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import type { DailyStatDto } from '../api/readingTracking'

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function GoalRing({ current, target }: { current: number; target: number }) {
  const pct = Math.min(1, current / Math.max(target, 1))
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - pct)

  return (
    <svg width="100" height="100" viewBox="0 0 100 100" className="stats-goal-ring">
      <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--color-border)" strokeWidth="8" />
      <circle
        cx="50" cy="50" r={radius} fill="none"
        stroke={pct >= 1 ? 'var(--color-success, #22c55e)' : 'var(--color-primary)'}
        strokeWidth="8" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={offset}
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central"
        fontSize="16" fontWeight="600" fill="var(--color-text)">
        {Math.round(pct * 100)}%
      </text>
    </svg>
  )
}

function WeeklyChart({ dailyStats }: { dailyStats: DailyStatDto[] }) {
  const last7 = getLast7Days(dailyStats)
  const maxSeconds = Math.max(...last7.map(d => d.totalSeconds), 1)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <div className="stats-weekly-chart">
      {last7.map((day, i) => {
        const height = Math.max(4, (day.totalSeconds / maxSeconds) * 100)
        const date = new Date(day.date)
        return (
          <div key={i} className="stats-weekly-chart__bar-container">
            <div className="stats-weekly-chart__bar-wrapper">
              <div
                className="stats-weekly-chart__bar"
                style={{ height: `${height}%` }}
                title={`${formatTime(day.totalSeconds)}`}
              />
            </div>
            <span className="stats-weekly-chart__label">{days[date.getDay()]}</span>
          </div>
        )
      })}
    </div>
  )
}

function StreakCalendar({ dailyStats }: { dailyStats: DailyStatDto[] }) {
  const statsMap = new Map(dailyStats.map(d => [d.date.split('T')[0], d.totalSeconds]))
  const today = new Date()
  const cells: { date: string; seconds: number }[] = []

  for (let i = 89; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().split('T')[0]
    cells.push({ date: key, seconds: statsMap.get(key) || 0 })
  }

  const getColor = (seconds: number): string => {
    if (seconds === 0) return 'var(--color-bg-secondary, #f3f4f6)'
    if (seconds < 600) return '#d4a574'
    if (seconds < 1800) return 'var(--color-brand, #C4704B)'
    return '#8b4513'
  }

  return (
    <div className="stats-streak-calendar">
      {cells.map((cell) => (
        <div
          key={cell.date}
          className="stats-streak-calendar__cell"
          style={{ backgroundColor: getColor(cell.seconds) }}
          title={`${cell.date}: ${formatTime(cell.seconds)}`}
        />
      ))}
    </div>
  )
}

function getLast7Days(dailyStats: DailyStatDto[]): DailyStatDto[] {
  const today = new Date()
  const result: DailyStatDto[] = []
  const statsMap = new Map(dailyStats.map(d => [d.date.split('T')[0], d]))

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().split('T')[0]
    result.push(statsMap.get(key) || { date: key, totalSeconds: 0, totalWords: 0, sessionCount: 0 })
  }
  return result
}

export function StatsPage() {
  const { isAuthenticated } = useAuth()
  const { t } = useTranslation()
  const { stats, dailyStats, loading } = useReadingStats()
  const { goals, upsert: upsertGoal } = useReadingGoals()
  const { achievements } = useAchievements()

  const [goalInput, setGoalInput] = useState('')
  const [streakInput, setStreakInput] = useState('')

  if (!isAuthenticated) {
    return (
      <div className="page-container">
        <SeoHead title={t('stats.title')} noindex />
        <div className="stats-page">
          <h1>{t('stats.title')}</h1>
          <p>{t('stats.signInPrompt')}</p>
        </div>
        <Footer />
      </div>
    )
  }

  if (loading) {
    return (
      <div className="page-container">
        <SeoHead title={t('stats.title')} noindex />
        <div className="stats-page">
          <h1>{t('stats.title')}</h1>
          <p>{t('common.loading')}</p>
        </div>
        <Footer />
      </div>
    )
  }

  const dailyGoal = goals.find(g => g.goalType === 'daily_minutes')
  const unlockedCodes = new Set(achievements.map(a => a.code))

  const handleSetGoal = async () => {
    const val = parseInt(goalInput)
    if (!val || val <= 0) return
    const smm = parseInt(streakInput)
    await upsertGoal({
      goalType: 'daily_minutes',
      targetValue: val,
      year: 0,
      streakMinMinutes: smm > 0 ? smm : undefined,
    })
    setGoalInput('')
    setStreakInput('')
  }

  return (
    <div className="page-container">
      <SeoHead title={t('stats.title')} noindex />
      <div className="stats-page">
        <h1>{t('stats.title')}</h1>

        {/* Summary cards */}
        <div className="stats-cards">
          <div className="stats-card">
            <div className="stats-card__value">{formatTime(stats?.totalSeconds || 0)}</div>
            <div className="stats-card__label">{t('stats.totalTime')}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card__value">{stats?.booksFinished || 0}</div>
            <div className="stats-card__label">{t('stats.booksFinished')}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card__value">{stats?.currentStreak || 0}</div>
            <div className="stats-card__label">{t('stats.currentStreak')}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card__value">{stats?.avgDailyMinutes || 0}m</div>
            <div className="stats-card__label">{t('stats.avgDaily')}</div>
          </div>
        </div>

        {/* Daily goal ring */}
        {stats?.dailyGoal && (
          <section className="stats-section">
            <h2>{t('stats.dailyGoal')}</h2>
            <div className="stats-goal-section">
              <GoalRing current={stats.dailyGoal.today} target={stats.dailyGoal.target} />
              <div className="stats-goal-text">
                <p>{Math.round(stats.dailyGoal.today)}m / {stats.dailyGoal.target}m</p>
                {stats.dailyGoal.met && <p className="stats-goal-met">{t('stats.goalMet')}</p>}
              </div>
            </div>
          </section>
        )}

        {/* Streak calendar */}
        <section className="stats-section">
          <h2>{t('stats.streakCalendar')}</h2>
          <StreakCalendar dailyStats={dailyStats} />
        </section>

        {/* Weekly chart */}
        <section className="stats-section">
          <h2>{t('stats.weeklyChart')}</h2>
          <WeeklyChart dailyStats={dailyStats} />
        </section>

        {/* Achievements */}
        <section className="stats-section">
          <h2>{t('stats.achievements')}</h2>
          <div className="stats-achievements">
            {Object.entries(AchievementDefinitions).map(([code, def]) => {
              const unlocked = unlockedCodes.has(code)
              const achievement = achievements.find(a => a.code === code)
              return (
                <div key={code} className={`stats-achievement ${unlocked ? 'stats-achievement--unlocked' : ''}`}>
                  <div className="stats-achievement__icon">{def.emoji}</div>
                  <div className="stats-achievement__info">
                    <div className="stats-achievement__name">{def.name}</div>
                    <div className="stats-achievement__desc">{def.description}</div>
                    {unlocked && achievement && (
                      <div className="stats-achievement__date">
                        {new Date(achievement.unlockedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* Goal settings */}
        <section className="stats-section">
          <h2>{t('stats.goalSettings')}</h2>
          <div className="stats-goal-form">
            <div className="stats-goal-form__row">
              <label>{t('stats.dailyMinutesTarget')}</label>
              <input
                type="number"
                value={goalInput || dailyGoal?.targetValue || ''}
                onChange={e => setGoalInput(e.target.value)}
                placeholder="30"
                min="1"
                className="stats-input"
              />
            </div>
            <div className="stats-goal-form__row">
              <label>{t('stats.streakThreshold')}</label>
              <input
                type="number"
                value={streakInput || dailyGoal?.streakMinMinutes || ''}
                onChange={e => setStreakInput(e.target.value)}
                placeholder="5"
                min="1"
                className="stats-input"
              />
            </div>
            <button onClick={handleSetGoal} className="stats-btn">{t('stats.saveGoal')}</button>
          </div>
        </section>

        {/* Extra stats */}
        <section className="stats-section">
          <h2>{t('stats.details')}</h2>
          <div className="stats-details">
            <div className="stats-detail-row">
              <span>{t('stats.longestStreak')}</span>
              <span>{stats?.longestStreak || 0} {t('stats.days')}</span>
            </div>
            <div className="stats-detail-row">
              <span>{t('stats.avgWpm')}</span>
              <span>{stats?.avgWordsPerMinute || 0}</span>
            </div>
            <div className="stats-detail-row">
              <span>{t('stats.thisWeek')}</span>
              <span>{formatTime(stats?.weekSeconds || 0)}</span>
            </div>
            <div className="stats-detail-row">
              <span>{t('stats.thisMonth')}</span>
              <span>{formatTime(stats?.monthSeconds || 0)}</span>
            </div>
          </div>
        </section>
      </div>
      <Footer />
    </div>
  )
}
