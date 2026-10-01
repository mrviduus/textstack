import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { libraryApi, type LibraryShelves } from '@textstack/shared'
import { useDataChange } from '../lib/dataEvents'

const CACHE_TTL_MS = 60_000

let cache: { value: LibraryShelves; at: number } | null = null

export interface UseLibraryShelves {
  shelves: LibraryShelves | null
  loading: boolean
  error: string | null
}

export function useLibraryShelves(): UseLibraryShelves {
  const { isAuthenticated } = useAuth()
  const [shelves, setShelves] = useState<LibraryShelves | null>(
    cache && Date.now() - cache.at < CACHE_TTL_MS ? cache.value : null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback((force = false) => {
    if (!isAuthenticated) {
      setShelves(null)
      return
    }
    if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
      setShelves(cache.value)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    libraryApi.getLibraryShelves()
      .then((value) => {
        if (cancelled) return
        cache = { value, at: Date.now() }
        setShelves(value)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e?.message ?? 'Failed to load shelves')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [isAuthenticated])

  useEffect(() => {
    refetch()
  }, [refetch])

  // Invalidate cache + refetch on shelves / user-books / library /
  // reading-progress changes. Keeps "Recently added", "Continue reading",
  // "Quick reads" live without waiting for the 60s TTL to expire.
  useDataChange(['shelves', 'user-books', 'library', 'reading-progress'], () => {
    cache = null
    refetch(true)
  })

  return { shelves, loading, error }
}

export function clearLibraryShelvesCache(): void {
  cache = null
}
