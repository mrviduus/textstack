/**
 * Resuming a PDF read in Original layout.
 *
 * A PDF has pages, not chapters, so its position is persisted as a `page:<N>`
 * locator with `chapterSlug: null` (see `pdfProgress.ts`). Every consumer then
 * looked for a chapter slug, found none, and concluded the book had never been
 * opened: the detail screen said "Start Reading" and routed to chapter one, and
 * the reader's own precedence rule — chapter start page beats server resume
 * page — meant chapter one's page 1 discarded the saved page. The locator was
 * written correctly and never read on any reachable path.
 *
 * These two functions close that gap using the page ranges the extractor
 * already records per chapter (`sourceStartPage`).
 */

export interface ChapterPageAnchor {
  slug: string | null
  /** 1-based page where this chapter begins. Null for EPUB / unmeasured. */
  sourceStartPage?: number | null
}

const isPage = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1

/**
 * The chapter containing a 1-based page — the last chapter that starts at or
 * before it. Front matter (pages before the first measured start) belongs to the
 * first chapter: it is the nearest one, and returning null there sent "Continue"
 * to chapter one's start page, which was then saved over the reader's page.
 *
 * Chapters are assumed to be in reading order, which is how both the detail
 * payload and the reader's chapter list are built. Returns null when nothing
 * can be determined, so callers fall back rather than guess.
 */
export function chapterSlugForPage(
  chapters: readonly ChapterPageAnchor[],
  page: number | null | undefined,
): string | null {
  if (!chapters || chapters.length === 0) return null
  if (page == null || !Number.isFinite(page) || page < 1) return null

  let found: string | null = null
  let bestStart = 0
  let first: string | null | undefined
  for (const c of chapters) {
    const start = c.sourceStartPage
    if (!isPage(start)) continue
    if (first === undefined) first = c.slug ?? null
    if (start <= page && start >= bestStart) {
      bestStart = start
      found = c.slug ?? null
    }
  }
  return bestStart > 0 ? found : (first ?? null)
}

/** True when no chapter before `index` has a measured start page — so this one owns the front matter. */
export function isFirstPagedChapter(chapters: readonly ChapterPageAnchor[], index: number): boolean {
  if (index < 0 || index >= chapters.length) return false
  return !chapters.slice(0, index).some(c => isPage(c.sourceStartPage))
}

/**
 * Which page to open the viewer at.
 *
 * The rule that matters: a saved page INSIDE the chapter being opened wins over
 * that chapter's first page. That distinguishes the two ways a reader arrives
 * without needing a flag —
 *   • tapped chapter 7 in the table of contents, saved page is in chapter 3
 *     → they asked for chapter 7, so open chapter 7's first page;
 *   • tapped Continue, which routes to the chapter their saved page lives in
 *     → open the exact page, not the top of the chapter.
 *
 * `chapterEndPage` is exclusive (the next chapter's start); omit it for the
 * last chapter. `firstChapter` extends the range down to page 1 — the front
 * matter is the first chapter's, so a saved page 1 is not clamped to its start
 * (and then saved as that start). `pageCount`, when known, is the only upper
 * clamp: a page past the last chapter is still the reader's page.
 */
export function resolvePdfResumePage(input: {
  chapterStartPage?: number | null
  chapterEndPage?: number | null
  firstChapter?: boolean
  resumePage?: number | null
  pageCount?: number | null
}): number {
  const page = resolveUnclamped(input)
  return isPage(input.pageCount) ? Math.min(page, Math.floor(input.pageCount)) : page
}

function resolveUnclamped(input: {
  chapterStartPage?: number | null
  chapterEndPage?: number | null
  firstChapter?: boolean
  resumePage?: number | null
}): number {
  const { chapterStartPage, chapterEndPage, firstChapter, resumePage } = input

  const validResume = typeof resumePage === 'number' && Number.isFinite(resumePage) && resumePage >= 1
    ? Math.floor(resumePage)
    : null
  const validStart = typeof chapterStartPage === 'number' && Number.isFinite(chapterStartPage) && chapterStartPage >= 1
    ? Math.floor(chapterStartPage)
    : null

  if (validStart == null) return validResume ?? 1

  if (validResume != null && (firstChapter || validResume >= validStart)) {
    const end = typeof chapterEndPage === 'number' && Number.isFinite(chapterEndPage) && chapterEndPage >= 1
      ? Math.floor(chapterEndPage)
      : null
    if (end == null || validResume < end) return validResume
  }

  return validStart
}

/** Exclusive end page of the chapter at `index` — the next measured start. */
export function chapterEndPage(
  chapters: readonly ChapterPageAnchor[],
  index: number,
): number | null {
  for (let i = index + 1; i < chapters.length; i++) {
    const start = chapters[i].sourceStartPage
    if (typeof start === 'number' && Number.isFinite(start) && start >= 1) return start
  }
  return null
}

// `resumeChapterSlug` used to live here. It moved to `resume.ts` when it learned to read a
// reflow locator: the rule is not about PDFs, and keeping it in a PDF-named file is how it came
// to consider only `page:<N>` locators in the first place.
