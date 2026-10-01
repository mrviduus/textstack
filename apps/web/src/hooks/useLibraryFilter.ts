import type { LibraryItem, ReadingProgressDto } from '../api/auth'
import type { UserBook } from '../api/userBooks'

export type LibraryFilterKey = 'all' | 'reading' | 'finished' | 'notStarted' | 'failed'

const FINISHED_THRESHOLD = 0.95

function progressOf(item: LibraryItem, progressMap: Record<string, ReadingProgressDto>): number {
  return progressMap[item.editionId]?.percent ?? 0
}

/** The recorded completion, falling back to the threshold for rows written
 *  before editions had a `completedAt`. Uploads already answer it this way. */
function isFinishedItem(item: LibraryItem, progressMap: Record<string, ReadingProgressDto>): boolean {
  const p = progressMap[item.editionId]
  return p?.completedAt != null || (p?.percent ?? 0) >= FINISHED_THRESHOLD
}

export function filterLibraryItems(
  items: LibraryItem[],
  filter: LibraryFilterKey,
  progressMap: Record<string, ReadingProgressDto>,
): LibraryItem[] {
  switch (filter) {
    case 'reading':
      return items.filter(i => !isFinishedItem(i, progressMap) && progressOf(i, progressMap) > 0)
    case 'finished':
      return items.filter(i => isFinishedItem(i, progressMap))
    case 'notStarted':
      return items.filter(i => !isFinishedItem(i, progressMap) && progressOf(i, progressMap) === 0)
    case 'failed':
      return []
    case 'all':
    default:
      return items
  }
}

export function filterUserBooks(books: UserBook[], filter: LibraryFilterKey): UserBook[] {
  switch (filter) {
    case 'reading':
      return books.filter(b => {
        if (b.status !== 'Ready' || b.completedAt) return false
        const p = b.progressPercent ?? 0
        return p > 0 && p < FINISHED_THRESHOLD
      })
    case 'finished':
      return books.filter(b => b.status === 'Ready' && (b.completedAt != null || (b.progressPercent ?? 0) >= FINISHED_THRESHOLD))
    case 'notStarted':
      return books.filter(b => b.status === 'Ready' && !b.completedAt && (b.progressPercent ?? 0) === 0)
    case 'failed':
      return books.filter(b => b.status === 'Failed')
    case 'all':
    default:
      return books
  }
}

export function countsForLibrary(
  items: LibraryItem[],
  progressMap: Record<string, ReadingProgressDto>,
): Record<LibraryFilterKey, number> {
  return {
    all: items.length,
    reading: filterLibraryItems(items, 'reading', progressMap).length,
    finished: filterLibraryItems(items, 'finished', progressMap).length,
    notStarted: filterLibraryItems(items, 'notStarted', progressMap).length,
    failed: 0,
  }
}

export function countsForUploads(books: UserBook[]): Record<LibraryFilterKey, number> {
  return {
    all: books.length,
    reading: filterUserBooks(books, 'reading').length,
    finished: filterUserBooks(books, 'finished').length,
    notStarted: filterUserBooks(books, 'notStarted').length,
    failed: filterUserBooks(books, 'failed').length,
  }
}
