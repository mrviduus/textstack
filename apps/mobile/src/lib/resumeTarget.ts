import { parseTextPosition, resumeChapterSlug } from '@textstack/shared'
import { resumeRoute, type ResumePick } from './bookRoutes'
import { userBookChapterSlug } from './userBookChapters'

/** What a progress row says about the place, in the fields every client stores. */
export type SavedPlace = {
  chapterSlug: string | null
  locator: string | null
  positionJson?: string | null
  percent?: number | null
} | null

type ChapterRow = { slug?: string | null; chapterNumber: number; sourceStartPage?: number | null }

/**
 * The chapter a saved place belongs to. The text position (ADR-015) names its chapter and is the
 * truest field on the row, so it outranks `chapterSlug` — a server projection that lags (#496).
 * `resumeChapterSlug` then prefers a scroll locator's slug and resolves a PDF `page:<N>`.
 */
export function resumeSlugFor(place: SavedPlace, chapters: readonly ChapterRow[]): string | null {
  const fromText = parseTextPosition(place?.positionJson)?.chapterSlug
  return resumeChapterSlug(
    fromText ?? place?.chapterSlug,
    place?.locator,
    chapters.map(c => ({ slug: userBookChapterSlug(c), sourceStartPage: c.sourceStartPage })),
  )
}

export type { ResumePick }

export type ResumeDeps = {
  getEdition: (slug: string) => Promise<{ id: string; chapters: readonly ChapterRow[] }>
  getEditionProgress: (editionId: string) => Promise<SavedPlace>
  getUserBook: (id: string) => Promise<{ chapters: readonly ChapterRow[] }>
  getUserBookProgress: (id: string) => Promise<SavedPlace>
}

/**
 * Where "Continue" goes — one answer for the Library hero, the Library list and the detail screens.
 *
 * A pick that names its chapter opens it. One that does not (a PDF read as pages, a row written
 * before the slug was kept) asks for the chapter list and the saved place:
 * - a place that resolves → that chapter;
 * - no place at all → the first chapter (nothing to lose);
 * - a place nobody can resolve → the book screen. Never chapter 1: the reader would save there and
 *   overwrite the real position (code review #781).
 * Any failure (offline) → the book screen, which works from the device.
 */
export async function resolveResumeRoute(pick: ResumePick, deps: ResumeDeps): Promise<string> {
  const fallback = resumeRoute(pick)
  if (pick.chapterSlug) return fallback
  try {
    if (pick.type === 'edition') {
      const book = await deps.getEdition(pick.slug)
      const place = await deps.getEditionProgress(book.id).catch(() => null)
      const slug = pickSlug(place, book.chapters)
      return slug ? `/reader/${pick.slug}/${slug}` : fallback
    }
    const [book, place] = await Promise.all([
      deps.getUserBook(pick.id),
      deps.getUserBookProgress(pick.id).catch(() => null),
    ])
    const slug = pickSlug(place, book.chapters)
    return slug ? `/my-books/read/${pick.id}/${slug}` : fallback
  } catch {
    return fallback
  }
}

function pickSlug(place: SavedPlace, chapters: readonly ChapterRow[]): string | null {
  const resolved = resumeSlugFor(place, chapters)
  if (resolved) return resolved
  const hasPlace = !!place && ((place.percent ?? 0) > 0 || !!place.locator || !!place.positionJson)
  if (hasPlace || !chapters[0]) return null
  return userBookChapterSlug(chapters[0])
}
