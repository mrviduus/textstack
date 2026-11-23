import type { ContinueReadingPick } from '@textstack/shared'

/**
 * Deep link that resumes a book at the chapter the reader last had open.
 *
 * Expo-router resolves routes from the file tree, so a wrong path literal is not
 * a type error — it falls through to `app/+not-found.tsx` and the user just gets
 * "Page not found". `src/lib/routeLiterals.test.ts` greps for the two literals
 * that shipped that way.
 *
 * Every upload goes straight to the reader: it opens the book at its synced place and ignores the
 * slug (`start` when there is none), so Continue needs no network (#1522). Note the user-book segment order:
 * `/my-books/read/{bookId}/{chapterSlug}`. Getting those two backwards once made
 * Continue Reading look broken for every uploaded book. A catalog pick (none since
 * the catalog retired at M6) goes to the front door.
 */
export function resumeRoute(pick: ContinueReadingPick): string {
  if (pick.type === 'edition') return '/'
  return `/my-books/read/${pick.id}/${pick.chapterSlug ?? 'start'}`
}
