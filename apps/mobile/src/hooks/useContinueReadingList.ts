import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { rankContinueReading } from '@textstack/shared'
import type {
  ContinueReadingPick,
  LocalProgressLite,
  UserBookProgressLite,
  UserLibraryItem,
  UserBookDto,
  ReadingProgressDto,
} from '@textstack/shared'
import { getAllLocalProgress } from '../lib/progressStorage'

const NO_LOCAL_USER_BOOKS = new Map<string, UserBookProgressLite>()

/**
 * In-progress books, most recently active first.
 *
 * Takes the server data the Library screen has already loaded and only fetches
 * what it cannot: the catalog's AsyncStorage map of progress written while
 * offline. Uploads have no local map here: offline, the Library builds their
 * rows from the V2 local library with its places (#1532). `ContinueReadingCard` (the old home-screen card) re-fetched library,
 * progress and user-books itself on every focus — three network round-trips to
 * render one card, on a screen that had just made the same three calls.
 *
 * Recomputed on focus rather than on an interval: the only thing that changes
 * these values is the user leaving the reader, which is a focus event.
 */
export function useContinueReadingList(
  library: UserLibraryItem[],
  progressMap: Record<string, ReadingProgressDto>,
  userBooks: UserBookDto[],
): ContinueReadingPick[] {
  const [catalog, setCatalog] = useState<Map<string, LocalProgressLite>>(() => new Map())

  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      ;(async () => {
        const local = await getAllLocalProgress().catch(() => new Map<string, LocalProgressLite>())
        if (!cancelled) setCatalog(local)
      })()
      return () => { cancelled = true }
    }, []),
  )

  // Memoised because the Library screen re-renders every 5s while an upload is
  // processing, and a fresh array identity would re-render every row and the
  // whole rail each time for nothing.
  return useMemo(
    () => rankContinueReading({
      library,
      serverProgress: Object.values(progressMap),
      userBooks,
      localCatalogMap: catalog,
      localUserBookMap: NO_LOCAL_USER_BOOKS,
    }),
    [library, progressMap, userBooks, catalog],
  )
}
