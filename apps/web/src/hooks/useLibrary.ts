import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { getLibrary, addToLibrary, removeFromLibrary, LibraryItem } from '../api/auth'
import { useOfflineDownload } from './useOfflineDownload'
import { deleteAllCachedData } from '../lib/offlineDb'

export function useLibrary() {
  const { isAuthenticated } = useAuth()
  const [items, setItems] = useState<LibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { downloadBook, cancelDownload } = useOfflineDownload()

  // Fetch library on mount (if authenticated)
  useEffect(() => {
    if (!isAuthenticated) {
      setItems([])
      return
    }

    const fetchLibrary = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await getLibrary()
        setItems(response.items)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load library')
      } finally {
        setLoading(false)
      }
    }

    fetchLibrary()
  }, [isAuthenticated])

  const add = useCallback(async (editionId: string) => {
    if (!isAuthenticated) return
    try {
      const item = await addToLibrary(editionId)
      setItems(prev => [item, ...prev])
      // Start background download for offline use
      downloadBook(editionId, item.slug).catch(() => {})
      return item
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add to library')
      throw err
    }
  }, [isAuthenticated, downloadBook])

  const remove = useCallback(async (editionId: string) => {
    if (!isAuthenticated) return
    try {
      // Cancel any ongoing download
      cancelDownload(editionId)
      await removeFromLibrary(editionId)
      setItems(prev => prev.filter(item => item.editionId !== editionId))
      // Clean up cached data
      deleteAllCachedData(editionId).catch(() => {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove from library')
      throw err
    }
  }, [isAuthenticated, cancelDownload])

  const isInLibrary = useCallback((editionId: string) => {
    return items.some(item => item.editionId === editionId)
  }, [items])

  const toggle = useCallback(async (editionId: string) => {
    if (isInLibrary(editionId)) {
      await remove(editionId)
    } else {
      await add(editionId)
    }
  }, [isInLibrary, add, remove])

  return {
    items,
    loading,
    error,
    add,
    remove,
    toggle,
    isInLibrary,
  }
}
