import { useMemo } from 'react'
import { rankContinueReading } from '@textstack/shared'
import type {
  ContinueReadingPick,
  LocalProgressLite,
  UserBookProgressLite,
  UserLibraryItem,
  UserBookDto,
  ReadingProgressDto,
} from '@textstack/shared'

const NO_LOCAL_USER_BOOKS = new Map<string, UserBookProgressLite>()
const NO_LOCAL_CATALOG = new Map<string, LocalProgressLite>()

/**
 * In-progress books, most recently active first.
 *
 * Ranks only the data the Library screen has already loaded; it fetches nothing.
 * No local maps: the catalog is gone (M6), and offline the Library builds the
 * upload rows from the V2 local library with its places (#1532).
 */
export function useContinueReadingList(
  library: UserLibraryItem[],
  progressMap: Record<string, ReadingProgressDto>,
  userBooks: UserBookDto[],
  openedAt: Record<string, number>,
): ContinueReadingPick[] {
  // Memoised because the Library screen re-renders every 5s while an upload is
  // processing, and a fresh array identity would re-render every row and the
  // whole rail each time for nothing.
  return useMemo(
    () => rankContinueReading({
      library,
      serverProgress: Object.values(progressMap),
      userBooks,
      localCatalogMap: NO_LOCAL_CATALOG,
      localUserBookMap: NO_LOCAL_USER_BOOKS,
      openedAt,
    }),
    [library, progressMap, userBooks, openedAt],
  )
}
