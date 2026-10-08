import { parsePdfPageLocator, resumeChapterSlug, type ChapterPageAnchor, type ContinueReadingPick } from '@textstack/shared'
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

type ChapterRow = ChapterPageAnchor & { chapterNumber: number }

/**
 * The Library hero's Continue (RES-1). An upload read as PDF pages saves `page:<N>` and no chapter,
 * so `resumeRoute` sent it to the detail screen. Here the chapter list names the chapter holding
 * that page, and the PDF reader then restores the page itself. The device's chapters first (the
 * reading path waits for no network); the server only when none are cached. Lookup fails → detail.
 */
export async function heroResumeRoute(
  pick: ContinueReadingPick,
  loaders: {
    device: (bookId: string) => Promise<readonly ChapterPageAnchor[]>
    server: (bookId: string) => Promise<readonly ChapterRow[]>
  },
): Promise<string> {
  if (pick.type !== 'userbook' || pick.chapterSlug || parsePdfPageLocator(pick.locator) == null) return resumeRoute(pick)
  try {
    const cached = await loaders.device(pick.id).catch(() => [])
    const chapters = cached.length
      ? cached
      : (await loaders.server(pick.id)).map(c => ({ ...c, slug: userBookChapterSlug(c) }))
    const slug = resumeChapterSlug(null, pick.locator, chapters)
    return slug ? `/my-books/read/${pick.id}/${slug}` : resumeRoute(pick)
  } catch {
    return resumeRoute(pick)
  }
}
