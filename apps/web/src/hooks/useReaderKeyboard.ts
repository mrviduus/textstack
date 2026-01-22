import { useEffect, useCallback } from 'react'
import type { ReaderSettings } from './useReaderSettings'

interface UseReaderKeyboardOptions {
  // Navigation state
  currentPage: number
  totalPages: number
  prevPage: () => void
  nextPage: () => void
  prevChapterSlug?: string
  nextChapterSlug?: string
  navigateToChapter: (slug: string) => void

  // Drawer state
  tocOpen: boolean
  settingsOpen: boolean
  searchOpen: boolean
  shortcutsOpen: boolean
  setTocOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  setShortcutsOpen: (open: boolean | ((prev: boolean) => boolean)) => void
  clearSearch: () => void

  // Bookmark handlers
  activeChapterSlug: string
  toggleBookmark: () => void

  // Settings & fullscreen
  settings: ReaderSettings
  updateSettings: (updates: Partial<ReaderSettings>) => void
  toggleFullscreen: () => void
}

export function useReaderKeyboard({
  currentPage,
  totalPages,
  prevPage,
  nextPage,
  prevChapterSlug,
  nextChapterSlug,
  navigateToChapter,
  tocOpen,
  settingsOpen,
  searchOpen,
  shortcutsOpen,
  setTocOpen,
  setSettingsOpen,
  setSearchOpen,
  setShortcutsOpen,
  clearSearch,
  activeChapterSlug,
  toggleBookmark,
  settings,
  updateSettings,
  toggleFullscreen,
}: UseReaderKeyboardOptions) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Skip when typing in input
    if (e.target instanceof HTMLInputElement) return

    const key = e.key.toLowerCase()

    // Escape - close drawers
    if (e.key === 'Escape') {
      if (shortcutsOpen) setShortcutsOpen(false)
      if (tocOpen) setTocOpen(false)
      if (settingsOpen) setSettingsOpen(false)
      if (searchOpen) {
        setSearchOpen(false)
        clearSearch()
      }
      return
    }

    // Arrow navigation
    if (e.key === 'ArrowLeft') {
      if (currentPage > 0) {
        prevPage()
      } else if (prevChapterSlug) {
        navigateToChapter(prevChapterSlug)
      }
      return
    }
    if (e.key === 'ArrowRight') {
      if (currentPage < totalPages - 1) {
        nextPage()
      } else if (nextChapterSlug) {
        navigateToChapter(nextChapterSlug)
      }
      return
    }

    // Feature shortcuts
    switch (key) {
      case 'f':
        toggleFullscreen()
        break
      case 's':
      case '/':
        e.preventDefault()
        setSearchOpen(true)
        break
      case 't':
        setTocOpen(true)
        break
      case 'b':
        if (activeChapterSlug) {
          toggleBookmark()
        }
        break
      case ',':
        setSettingsOpen(true)
        break
      case '+':
      case '=':
        if (settings.fontSize < 28) updateSettings({ fontSize: settings.fontSize + 2 })
        break
      case '-':
        if (settings.fontSize > 14) updateSettings({ fontSize: settings.fontSize - 2 })
        break
      case '1':
        updateSettings({ theme: 'light' })
        break
      case '2':
        updateSettings({ theme: 'sepia' })
        break
      case '3':
        updateSettings({ theme: 'dark' })
        break
      case '?':
        setShortcutsOpen(o => !o)
        break
    }
  }, [
    currentPage,
    totalPages,
    prevPage,
    nextPage,
    prevChapterSlug,
    nextChapterSlug,
    navigateToChapter,
    tocOpen,
    settingsOpen,
    searchOpen,
    shortcutsOpen,
    setTocOpen,
    setSettingsOpen,
    setSearchOpen,
    setShortcutsOpen,
    clearSearch,
    activeChapterSlug,
    toggleBookmark,
    settings,
    updateSettings,
    toggleFullscreen,
  ])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
