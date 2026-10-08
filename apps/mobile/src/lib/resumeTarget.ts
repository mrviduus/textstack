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
export function resumeSlugFor(
  place: SavedPlace,
  chapters: readonly ChapterRow[],
  /** Uploads only: a chapter with no slug is addressed as `chapter-N` (userBookChapters.ts). A
   *  catalog chapter always has its real slug, so nothing is invented for it. */
  opts: { synthesize?: boolean } = {},
): string | null {
  const fromText = parseTextPosition(place?.positionJson)?.chapterSlug
  const list = chapters.flatMap(c => {
    const slug = opts.synthesize ? userBookChapterSlug(c) : c.slug
    return slug ? [{ slug, sourceStartPage: c.sourceStartPage }] : []
  })
  // No list to check against (Library rows): the text position is the best answer there is.
  if (list.length === 0) return fromText ?? resumeChapterSlug(place?.chapterSlug, place?.locator, null)
  // A text position naming a chapter the book no longer has (re-ingest renamed it) must not cost
  // a valid chapterSlug or the page locator: fall through to them (code review #781).
  if (fromText && list.some(c => c.slug === fromText)) return fromText
  return resumeChapterSlug(place?.chapterSlug, place?.locator, list)
}

/**
 * The Library list's catalog pick. A slug the server derived (or a scroll locator) opens directly;
 * a chapter only the text position names is unverified without the chapter list, so the pick goes
 * through `resolveResumeRoute`, which checks it — the same path as the hero (code review #781).
 */
export function editionListPick(
  slug: string,
  editionId: string,
  place: NonNullable<SavedPlace>,
): Extract<ResumePick, { type: 'edition' }> {
  const verified = parseTextPosition(place.positionJson) ? null : resumeChapterSlug(place.chapterSlug, place.locator, null)
  return { type: 'edition', slug, editionId, place, chapterSlug: verified }
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
 * - no place at all (a 404) → the first chapter (nothing to lose);
 * - a place nobody can resolve → the book screen. Never chapter 1: the reader would save there and
 *   overwrite the real position (code review #781).
 * Any failure (offline, 5xx, a progress read that did not answer) → the book screen, which works
 * from the device.
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
        : deps.getEditionProgress(id).catch(noPlaceOnlyOn404)
      const [book, place] = pick.editionId
        ? await Promise.all([deps.getEdition(pick.slug), progressFor(pick.editionId)])
        : await deps.getEdition(pick.slug).then(async b => [b, await progressFor(b.id)] as const)
      const slug = pickSlug(place, book.chapters, false)
      return slug ? `/reader/${pick.slug}/${slug}` : fallback
    }
    const [book, place] = await Promise.all([
      deps.getUserBook(pick.id),
      deps.getUserBookProgress(pick.id).catch(noPlaceOnlyOn404),
    ])
    const slug = pickSlug(place, book.chapters, true)
    return slug ? `/my-books/read/${pick.id}/${slug}` : fallback
  } catch {
    return fallback
  }
}

/**
 * Only a 404 means "never read" (both progress endpoints answer it for no row). Anything else — a
 * 5xx, a timeout, no network — is "unknown", and unknown must not start chapter 1, where the reader
 * would save over the real place: it rethrows, and the caller falls back to the book screen.
 */
function noPlaceOnlyOn404(e: unknown): SavedPlace {
  if ((e as { status?: number } | null)?.status === 404) return null
  throw e
}

function pickSlug(place: SavedPlace, chapters: readonly ChapterRow[], synthesize: boolean): string | null {
  const resolved = resumeSlugFor(place, chapters, { synthesize })
  if (resolved) return resolved
  const hasPlace = !!place && ((place.percent ?? 0) > 0 || !!place.locator || !!place.positionJson)
  const first = chapters[0]
  if (hasPlace || !first) return null
  return synthesize ? userBookChapterSlug(first) : (first.slug ?? null)
}
