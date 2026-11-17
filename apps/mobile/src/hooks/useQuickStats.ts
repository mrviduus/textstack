import { useState, useEffect } from 'react'
import { readingTrackingApi } from '../lib/readingTrackingApi'
import { vocabularyApi } from '../lib/vocabularyApi'

interface QuickStats {
  todaySeconds: number
  dailyGoalMinutes: number | null
  currentStreak: number
  vocabDueNow: number
  vocabReviewedToday: number
  vocabStreak: number
}

export function useQuickStats(isAuthenticated: boolean) {
  const [stats, setStats] = useState<QuickStats | null>(null)

  useEffect(() => {
    // On sign-out (or if the hook is called unauthenticated) clear any
    // previous-user stats so the next sign-in doesn't render their
    // counters while the new fetch is in flight.
    if (!isAuthenticated) {
      setStats(null)
      return
    }
    let cancelled = false
    // M5 (#1031): on V2 each read is refused before any request (lib wrappers): no figures shown.
    Promise.all([
      readingTrackingApi.getStats(),
      readingTrackingApi.getGoals(),
      vocabularyApi.getVocabularyStats().catch(() => null),
    ])
      .then(([s, goals, v]) => {
        if (cancelled) return
        const dailyGoal = goals.find(g => g.goalType === 'daily_minutes')
        setStats({
          todaySeconds: s.todaySeconds,
          dailyGoalMinutes: dailyGoal ? dailyGoal.targetValue : null,
          currentStreak: s.currentStreak,
          vocabDueNow: v?.dueNow ?? 0,
          vocabReviewedToday: v?.reviewedToday ?? 0,
          vocabStreak: v?.streak ?? 0,
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isAuthenticated])

  return stats
}
