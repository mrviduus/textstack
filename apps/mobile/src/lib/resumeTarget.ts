import { parseTextPosition, resumeChapterSlug } from '@textstack/shared'
import { resumeRoute, type ResumePick, type SavedPlace } from './bookRoutes'
import { userBookChapterSlug } from './userBookChapters'

export type { SavedPlace }

type ChapterRow = { slug?: string | null; chapterNumber: number; sourceStartPage?: number | null }

/**
 * The chapter a saved place belongs to. The text position (ADR-015) names its chapter and is the
 * truest field on the row, so it outranks `chapterSlug` — a server projection that lags (#496).
 * `resumeChapterSlug` then prefers a scroll locator's slug and resolves a PDF `page:<N>`.
 */
export function resumeSlugFor(place: SavedPlace, chapters: readonly ChapterRow[]): string | null {
  const fromText = parseTextPosition(place?.positionJson)?.chapterSlug
  const list = chapters.map(c => ({ slug: userBookChapterSlug(c), sourceStartPage: c.sourceStartPage }))
  // No list to check against (Library rows): the text position is the best answer there is.
  if (list.length === 0) return fromText ?? resumeChapterSlug(place?.chapterSlug, place?.locator, null)
  // A text position naming a chapter the book no longer has (re-ingest renamed it) must not cost
  // a valid chapterSlug or the page locator: fall through to them (code review #781).
  if (fromText && list.some(c => c.slug === fromText)) return fromText
  return resumeChapterSlug(place?.chapterSlug, place?.locator, list)
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
      // The caller usually knows the edition (Library rows, the hero): ask for both at once, or
      // reuse the progress row it already holds. Only a bare slug costs two round-trips.
      const progressFor = (id: string) => pick.place !== undefined
        ? Promise.resolve(pick.place)
        : deps.getEditionProgress(id).catch(() => null)
      const [book, place] = pick.editionId
        ? await Promise.all([deps.getEdition(pick.slug), progressFor(pick.editionId)])
        : await deps.getEdition(pick.slug).then(async b => [b, await progressFor(b.id)] as const)
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
