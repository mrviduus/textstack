import { resumeChapterSlug, type ContinueReadingPick } from '@textstack/shared'
import { userBookChapterSlug } from './userBookChapters'

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
export function resumeRoute(pick: ContinueReadingPick): string {
  if (pick.type === 'edition') {
    return pick.chapterSlug ? `/reader/${pick.slug}/${pick.chapterSlug}` : `/book/${pick.slug}`
  }
  return pick.chapterSlug ? `/my-books/read/${pick.id}/${pick.chapterSlug}` : `/my-books/${pick.id}`
}

/**
 * Where Continue goes for an upload whose pick carries no chapter — a PDF read in Original layout
 * saves `page:<N>` with no chapter, so `resumeRoute` alone could only offer the detail screen
 * (QA-007). With the chapter list the page resolves to its chapter, the same answer the detail
 * screen's own Continue Reading gives; the reader then resumes the saved page.
 */
export function userBookReadRoute(
  id: string,
  progress: { chapterSlug: string | null; locator: string | null } | null,
  chapters: readonly { slug?: string | null; chapterNumber: number; sourceStartPage?: number | null }[],
): string {
  const first = chapters[0]
  const slug = resumeChapterSlug(
    progress?.chapterSlug,
    progress?.locator,
    chapters.map(c => ({ slug: userBookChapterSlug(c), sourceStartPage: c.sourceStartPage })),
  ) ?? (first ? userBookChapterSlug(first) : null)
  return slug ? `/my-books/read/${id}/${slug}` : `/my-books/${id}`
}

/** Continue on a catalog book with no saved place: its first chapter, or the book screen without a list. */
export function editionStartRoute(slug: string, chapters: readonly { slug: string }[]): string {
  return chapters[0] ? `/reader/${slug}/${chapters[0].slug}` : `/book/${slug}`
}
