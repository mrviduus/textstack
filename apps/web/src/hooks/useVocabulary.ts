import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import {
  getWords,
  deleteWord as deleteWordApi,
  deleteAllWords as deleteAllWordsApi,
  updateWord as updateWordApi,
  getVocabStats,
  type VocabWordDto,
  type VocabStatsDto,
} from '../api/vocabulary'
import { emitDataChange, useDataChange } from '../lib/dataEvents'

interface VocabFilters {
  stage?: string
  search?: string
  sort?: string
  limit?: number
  offset?: number
}

export function useVocabulary() {
  const { isAuthenticated } = useAuth()
  const [words, setWords] = useState<VocabWordDto[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<VocabStatsDto | null>(null)
  const [filters, setFilters] = useState<VocabFilters>({ sort: 'recent', limit: 50 })

  const fetchWords = useCallback(async (f?: VocabFilters) => {
    if (!isAuthenticated) return
    const active = f || filters
    setLoading(true)
    setError(null)
    try {
      const result = await getWords(active)
      setWords(result.items)
      setTotal(result.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated, filters])

  const fetchStats = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const s = await getVocabStats()
      setStats(s)
    } catch {
      // ignore stats errors
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    fetchWords()
    fetchStats()
  }, [isAuthenticated]) // eslint-disable-line react-hooks/exhaustive-deps

  // Word saved/deleted/edited from anywhere else (reader bubble, review
  // session, etc) → refetch list + stats so this page stays current.
  useDataChange('vocabulary', () => {
    fetchWords()
    fetchStats()
  })

  const removeWord = useCallback(async (id: string) => {
    try {
      await deleteWordApi(id)
      setWords(prev => prev.filter(w => w.id !== id))
      setTotal(prev => prev - 1)
      emitDataChange('vocabulary')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }, [])

  const removeAll = useCallback(async () => {
    try {
      await deleteAllWordsApi()
      setWords([])
      setTotal(0)
      fetchStats()
      emitDataChange('vocabulary')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete all')
    }
  }, [fetchStats])

  const editWord = useCallback(async (id: string, data: { translation?: string; definition?: string }) => {
    try {
      const updated = await updateWordApi(id, data)
      setWords(prev => prev.map(w => w.id === id ? updated : w))
      emitDataChange('vocabulary')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    }
  }, [])

  const applyFilters = useCallback((newFilters: Partial<VocabFilters>) => {
    const updated = { ...filters, ...newFilters, offset: 0 }
    setFilters(updated)
    fetchWords(updated)
  }, [filters, fetchWords])

  const loadMore = useCallback(() => {
    const next = { ...filters, offset: (filters.offset || 0) + (filters.limit || 50) }
    setFilters(next)
    fetchWords(next)
  }, [filters, fetchWords])

  return {
    words, total, loading, error, stats,
    filters, applyFilters, loadMore,
    removeWord, removeAll, editWord,
    refresh: () => { fetchWords(); fetchStats() },
  }
}
