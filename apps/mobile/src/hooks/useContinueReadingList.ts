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
import { getAllLocalProgress, getAllUserBookLocalProgress } from '../lib/progressStorage'

/**
 * In-progress books, most recently active first.
 *
 * Takes the server data the Library screen has already loaded and only fetches
 * what it cannot: the two AsyncStorage maps holding progress written while
 * offline. `ContinueReadingCard` (the old home-screen card) re-fetched library,
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
  const [local, setLocal] = useState<{
    catalog: Map<string, LocalProgressLite>
    userBook: Map<string, UserBookProgressLite>
  }>({ catalog: new Map(), userBook: new Map() })

  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      ;(async () => {
        // Each map is read independently — a corrupt entry in one store must
        // not blank the other half of the list.
        const [catalog, userBook] = await Promise.all([
          getAllLocalProgress().catch(() => new Map<string, LocalProgressLite>()),
          getAllUserBookLocalProgress().catch(() => new Map<string, UserBookProgressLite>()),
        ])
        if (!cancelled) setLocal({ catalog, userBook })
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
      localCatalogMap: local.catalog,
      localUserBookMap: local.userBook,
    }),
    [library, progressMap, userBooks, local],
  )
}
