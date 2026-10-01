import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useDownload } from '../context/DownloadContext'
import { useLanguage } from '../context/LanguageContext'
import { getLibrary, addToLibrary, removeFromLibrary, LibraryItem } from '../api/auth'
import { deleteAllCachedData } from '../lib/offlineDb'
import { emitDataChanges, useDataChange } from '../lib/dataEvents'

/** `enabled: false` skips loading /me/library (e.g. reader on an upload, which is never a library item). */
export function useLibrary({ enabled = true }: { enabled?: boolean } = {}) {
  const { isAuthenticated: authed } = useAuth()
  const isAuthenticated = authed && enabled
  const { startDownload, cancelDownload } = useDownload()
  const { language } = useLanguage()
  const [items, setItems] = useState<LibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchLibrary = useCallback(async () => {
    if (!isAuthenticated) return
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
  }, [isAuthenticated])

  // Fetch library on mount + on auth changes.
  useEffect(() => {
    if (!isAuthenticated) {
      setItems([])
      setLoading(false)
      return
    }
    fetchLibrary()
  }, [isAuthenticated, fetchLibrary])

  // Cross-component refresh: any other component that adds/removes a saved
  // book broadcasts `library`. Re-pull so this hook stays in sync.
  useDataChange('library', fetchLibrary)

  const add = useCallback(async (editionId: string) => {
    if (!isAuthenticated) return
    try {
      const item = await addToLibrary(editionId)
      setItems(prev => [item, ...prev])
      emitDataChanges(['library', 'shelves'])
      // Start background download for offline use
      startDownload(editionId, item.slug, item.title, language)
      return item
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add to library')
      throw err
    }
  }, [isAuthenticated, startDownload, language])

  const remove = useCallback(async (editionId: string) => {
    if (!isAuthenticated) return
    try {
      // Cancel any ongoing download
      cancelDownload(editionId)
      await removeFromLibrary(editionId)
      setItems(prev => prev.filter(item => item.editionId !== editionId))
      emitDataChanges(['library', 'shelves'])
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
