import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { getStats } from '../api/readingTracking'
import { getVocabStats } from '../api/vocabulary'

const CACHE_KEY = 'reading.quickStats'

export interface QuickStats {
  todaySeconds: number
  todayVocabReviews: number
  dailyGoal: { target: number; today: number; met: boolean } | null
  currentStreak: number
  vocabDueNow: number
  vocabReviewedToday: number
  vocabStreak: number
}

function getCached(): QuickStats | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return null
}

const EMPTY: QuickStats = {
  todaySeconds: 0, todayVocabReviews: 0, dailyGoal: null, currentStreak: 0,
  vocabDueNow: 0, vocabReviewedToday: 0, vocabStreak: 0,
}

/**
 * `includeReading: false` skips `/me/reading/stats` (the Header shows only the
 * vocab fields) and keeps the last-known reading fields from the shared cache.
 */
export function useQuickStats({ includeReading = true }: { includeReading?: boolean } = {}): QuickStats | null {
  const { isAuthenticated } = useAuth()
  const [data, setData] = useState<QuickStats | null>(getCached)

  useEffect(() => {
    if (!isAuthenticated) return

    if (!includeReading) {
      let cancelled = false
      getVocabStats()
        .then(v => {
          if (cancelled) return
          setData(prev => {
            const qs: QuickStats = {
              ...(prev ?? EMPTY),
              vocabDueNow: v.dueNow,
              vocabReviewedToday: v.reviewedToday,
              vocabStreak: v.streak,
            }
            try { localStorage.setItem(CACHE_KEY, JSON.stringify(qs)) } catch {}
            return qs
          })
        })
        .catch(() => {})
      return () => { cancelled = true }
    }

    const tz = -new Date().getTimezoneOffset()
    Promise.all([
      getStats(tz),
      getVocabStats().catch(() => null),
    ]).then(([s, v]) => {
        const qs: QuickStats = {
          todaySeconds: s.todaySeconds,
          todayVocabReviews: s.todayVocabReviews,
          dailyGoal: s.dailyGoal,
          currentStreak: s.currentStreak,
          vocabDueNow: v?.dueNow ?? 0,
          vocabReviewedToday: v?.reviewedToday ?? 0,
          vocabStreak: v?.streak ?? 0,
        }
        setData(qs)
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(qs)) } catch {}
      })
      .catch(() => {})
  }, [isAuthenticated, includeReading])

  // Optimistically update when a review is submitted
  useEffect(() => {
    const handler = () => {
      setData(prev => {
        if (!prev) return prev
        const updated = {
          ...prev,
          vocabReviewedToday: prev.vocabReviewedToday + 1,
          vocabDueNow: Math.max(0, prev.vocabDueNow - 1),
        }
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(updated)) } catch {}
        return updated
      })
    }
    window.addEventListener('vocab-review-submitted', handler)
    return () => window.removeEventListener('vocab-review-submitted', handler)
  }, [])

  return data
}
