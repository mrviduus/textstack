import { useState, useEffect, useRef } from 'react'
import { useInBookSearch } from './useInBookSearch'
import { useReaderKeyboard } from './useReaderKeyboard'

/**
 * ReaderPage's drawers (TOC, settings, in-chapter search): open state, the
 * search over the chapter's html, the `?find=` seed and the keyboard shortcuts.
 * `canSearch` false (the PDF Original layout, #850): the search drawer closes and Cmd/Ctrl+F is the browser's.
 */
export function useReaderDrawers(chapterHtml: string, engineHref: string | null, canSearch = true) {
  const [tocOpen, setTocOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  if (searchOpen && !canSearch) setSearchOpen(false)

  const searchApi = useInBookSearch(chapterHtml, engineHref)
  const { search, clear: clearSearch } = searchApi

  // Seed search from `?find=` (slice 16 deep-link from library content search).
  // Runs once when chapter HTML first arrives to avoid clobbering the user's manual search.
  const findSeededRef = useRef(false)
  useEffect(() => {
    if (findSeededRef.current) return
    if (!chapterHtml) return
    const findParam = new URLSearchParams(window.location.search).get('find')
    if (!findParam) { findSeededRef.current = true; return }
    findSeededRef.current = true
    search(findParam)
    setSearchOpen(true)
  }, [chapterHtml, search])

  useReaderKeyboard({
    tocOpen,
    settingsOpen,
    searchOpen,
    canSearch,
    setTocOpen,
    setSettingsOpen,
    setSearchOpen,
    clearSearch,
  })

  return { tocOpen, setTocOpen, settingsOpen, setSettingsOpen, searchOpen, setSearchOpen, search: searchApi }
}
