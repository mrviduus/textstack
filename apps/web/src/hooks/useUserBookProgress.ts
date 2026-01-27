import { useEffect, useCallback, useRef, useState } from 'react'

const STORAGE_KEY = 'userbook.progress.'

interface SavedProgress {
  chapterNumber: number
  page: number
  percent: number
  updatedAt: number
}

export function useUserBookProgress(bookId: string) {
  const [savedProgress, setSavedProgress] = useState<SavedProgress | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const lastSavedRef = useRef<{ chapter: number; page: number } | null>(null)

  // Load saved progress on mount
  useEffect(() => {
    if (!bookId) {
      setIsLoading(false)
      return
    }

    try {
      const stored = localStorage.getItem(`${STORAGE_KEY}${bookId}`)
      if (stored) {
        const data = JSON.parse(stored) as SavedProgress
        setSavedProgress(data)
      }
    } catch {
      // Invalid data, ignore
    }
    setIsLoading(false)
  }, [bookId])

  // Save progress
  const saveProgress = useCallback((chapterNumber: number, page: number, percent: number) => {
    if (!bookId) return

    // Skip if same position
    const last = lastSavedRef.current
    if (last && last.chapter === chapterNumber && last.page === page) return
    lastSavedRef.current = { chapter: chapterNumber, page }

    const data: SavedProgress = {
      chapterNumber,
      page,
      percent,
      updatedAt: Date.now(),
    }

    try {
      localStorage.setItem(`${STORAGE_KEY}${bookId}`, JSON.stringify(data))
    } catch {
      // localStorage full or disabled
    }
  }, [bookId])

  // Clear progress (e.g., when book is deleted)
  const clearProgress = useCallback(() => {
    if (!bookId) return
    try {
      localStorage.removeItem(`${STORAGE_KEY}${bookId}`)
    } catch {
      // Ignore
    }
    setSavedProgress(null)
  }, [bookId])

  return {
    savedProgress,
    isLoading,
    saveProgress,
    clearProgress,
  }
}
