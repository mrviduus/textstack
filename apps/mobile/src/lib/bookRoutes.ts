import { parsePdfPageLocator, resumeChapterSlug, type ChapterPageAnchor, type ContinueReadingPick } from '@textstack/shared'
import { userBookChapterSlug } from './userBookChapters'
import { withDeadline } from './deadline'

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
 * reading path waits for no network), but only a complete download whose rows place the page; else the server, 3 s deadline. Lookup fails → detail.
 */
export async function heroResumeRoute(
  pick: ContinueReadingPick,
  loaders: {
    /** The cached chapters and the book meta's chapter count — a partial download can't place a page. */
    device: (bookId: string) => Promise<{ chapters: readonly ChapterPageAnchor[]; totalChapters: number }>
    server: (bookId: string) => Promise<readonly ChapterRow[]>
    /** Store the server's start pages on the device: a download made before they were cached gains them. */
    remember?: (bookId: string, chapters: { slug: string; sourceStartPage?: number | null }[]) => Promise<void>
  },
): Promise<string> {
  // A page beats chapterSlug, which may be stale from an earlier reflow read.
  if (pick.type !== 'userbook' || parsePdfPageLocator(pick.locator) == null) return resumeRoute(pick)
  try {
    const cached = await loaders.device(pick.id).catch(() => null)
    // The device answers when the download is complete and its rows place the page. Unpaged rows
    // are allowed only BEFORE the first paged one (unmeasured front matter); one in the middle may be
    // a row cached before start pages were stored, and could misplace the page.
    const rows = cached?.chapters ?? []
    const first = rows.findIndex(isPaged)
    const paged = first >= 0 && rows.slice(first).every(isPaged) ? rows.slice(first) : []
    let slug = cached && cached.totalChapters > 0 && rows.length >= cached.totalChapters && paged.length > 0
      ? resumeChapterSlug(null, pick.locator, paged)
      : null
    if (!slug) {
      const server = (await withDeadline(loaders.server(pick.id), SERVER_DEADLINE_MS)).map(c => ({ ...c, slug: userBookChapterSlug(c) }))
      // Fire-and-forget: the write never holds or fails the Continue.
      loaders.remember?.(pick.id, server.map(c => ({ slug: c.slug, sourceStartPage: c.sourceStartPage }))).catch(() => {})
      slug = resumeChapterSlug(null, pick.locator, server)
    }
    return slug ? `/my-books/read/${pick.id}/${slug}` : `/my-books/${pick.id}`
  } catch {
    // Not the stored chapterSlug: it may be stale, and opening it would save over the real page.
    return `/my-books/${pick.id}`
  }
}

const isPaged = (c: ChapterPageAnchor) => typeof c.sourceStartPage === 'number' && c.sourceStartPage >= 1

/** A captive portal must not hold the Continue tap. */
const SERVER_DEADLINE_MS = 3000
