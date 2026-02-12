import { useState, useEffect } from 'react'
import { getAchievements, type AchievementDto } from '../api/readingTracking'
import { useAuth } from '../context/AuthContext'

export function useAchievements() {
  const { isAuthenticated } = useAuth()
  const [achievements, setAchievements] = useState<AchievementDto[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    getAchievements()
      .then(setAchievements)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [isAuthenticated])

  return { achievements, loading }
}
