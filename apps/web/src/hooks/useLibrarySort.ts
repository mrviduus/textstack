import { useCallback, useEffect, useState } from 'react'

export type LibrarySortKey = 'recent' | 'added' | 'title' | 'author' | 'progress'
export type LibraryTab = 'saved' | 'uploads'

const VALID_KEYS: LibrarySortKey[] = ['recent', 'added', 'title', 'author', 'progress']
const STORAGE_PREFIX = 'textstack_library_sort_'

function readStored(tab: LibraryTab): LibrarySortKey {
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + tab)
    if (v && (VALID_KEYS as string[]).includes(v)) return v as LibrarySortKey
  } catch { /* SSR / locked storage */ }
  return 'recent'
}

export function useLibrarySort(tab: LibraryTab) {
  const [sort, setSortState] = useState<LibrarySortKey>(() => readStored(tab))

  // Re-read when tab swaps so each tab keeps its own remembered choice.
  useEffect(() => { setSortState(readStored(tab)) }, [tab])

  const setSort = useCallback((next: LibrarySortKey) => {
    setSortState(next)
    try { localStorage.setItem(STORAGE_PREFIX + tab, next) } catch { /* ignore */ }
  }, [tab])

  return { sort, setSort }
}
