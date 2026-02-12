import { useState, useEffect } from 'react'
import { getStats, getDailyStats, type ReadingStats, type DailyStatDto } from '../api/readingTracking'
import { useAuth } from '../context/AuthContext'

export function useReadingStats() {
  const { isAuthenticated } = useAuth()
  const [stats, setStats] = useState<ReadingStats | null>(null)
  const [dailyStats, setDailyStats] = useState<DailyStatDto[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }

    const tz = -new Date().getTimezoneOffset()

    Promise.all([
      getStats(tz),
      getDailyStats(undefined, undefined, tz),
    ])
      .then(([s, d]) => {
        setStats(s)
        setDailyStats(d)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [isAuthenticated])

  return { stats, dailyStats, loading }
}
