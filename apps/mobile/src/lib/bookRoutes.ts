/** What a progress row says about the place, in the fields every client stores. */
export type SavedPlace = {
  chapterSlug: string | null
  locator: string | null
  positionJson?: string | null
  percent?: number | null
} | null

/** The fields a resume needs; a `ContinueReadingPick` is one. */
export type ResumePick =
  | {
      type: 'edition'; slug: string; chapterSlug: string | null
      /** Known to the caller → progress is fetched alongside the book, not after it. */
      editionId?: string
      /** The progress row the caller already holds — not fetched again. */
      place?: SavedPlace
    }
  | { type: 'userbook'; id: string; chapterSlug: string | null }


/**
 * Deep link that resumes a book at the chapter the reader last had open.
 *
 * Expo-router resolves routes from the file tree, so a wrong path literal is not
 * a type error — it falls through to `app/+not-found.tsx` and the user just gets
 * "Page not found". `src/lib/routeLiterals.test.ts` greps for the two literals
 * that shipped that way.
 *
 * Falls back to the detail screen when there is no chapter to resume into — a
 * book saved but never opened. Note the user-book segment order:
 * `/my-books/read/{bookId}/{chapterSlug}`. Getting those two backwards once made
 * Continue Reading look broken for every uploaded book.
 */
export function resumeRoute(pick: ResumePick): string {
  if (pick.type === 'edition') {
    return pick.chapterSlug ? `/reader/${pick.slug}/${pick.chapterSlug}` : `/book/${pick.slug}`
  }
  return pick.chapterSlug ? `/my-books/read/${pick.id}/${pick.chapterSlug}` : `/my-books/${pick.id}`
}

