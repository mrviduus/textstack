import { useState, useEffect, useCallback } from 'react'
import { getGoals, createGoal, deleteGoal, type GoalDto, type CreateGoalRequest } from '../api/readingTracking'
import { useAuth } from '../context/AuthContext'

export function useReadingGoals() {
  const { isAuthenticated } = useAuth()
  const [goals, setGoals] = useState<GoalDto[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const data = await getGoals()
      setGoals(data)
    } catch {
      // ignore
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    refresh().finally(() => setLoading(false))
  }, [isAuthenticated, refresh])

  const upsert = useCallback(async (data: CreateGoalRequest) => {
    const result = await createGoal(data)
    await refresh()
    return result
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    await deleteGoal(id)
    setGoals(prev => prev.filter(g => g.id !== id))
  }, [])

  return { goals, loading, upsert, remove, refresh }
}
