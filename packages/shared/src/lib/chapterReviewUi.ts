/**
 * Chapter review — the pure halves of the reader badges and the chapter-row gate (PR 3,
 * chapter-review.md §12). Kept out of `chapterReview.ts` (the brief builders) on purpose.
 */
import type { ChapterReviewDto } from '../types/api'

/** What the reader shows on a highlight a review used. */
export interface ReviewedMark { chapterSlug: string; blockTitle: string; rule: string }

/**
 * Highlight id (lower-cased) → the review block that cited it, from the book's insights
 * (`GET /me/insights`). First block wins if two cite the same highlight.
 */
export function reviewedHighlightMarks(
  insights: readonly { chapterSlug: string | null; review?: ChapterReviewDto | null }[],
): Map<string, ReviewedMark> {
  const map = new Map<string, ReviewedMark>()
  for (const i of insights) {
    if (!i.chapterSlug || !i.review) continue
    for (const b of i.review.blocks) {
      for (const id of b.highlightIds) {
        const key = id.toLowerCase()
        if (!map.has(key)) map.set(key, { chapterSlug: i.chapterSlug, blockTitle: b.title, rule: b.rule })
      }
    }
  }
  return map
}

// Front/back matter. Anchored on the whole title after optional numbering ("1.", "IV -", "Chapter 3:").
// ponytail: English titles only; add other languages when a non-English book asks for it.
const SERVICE_TITLE = new RegExp(
  '^(?:(?:chapter|part)\\s+)?(?:(?:\\d+\\s*[.):\\-–—]?|[ivxlc]+\\s*[.):\\-–—])\\s+)?(?:' +
    [
      'cover', 'title page', 'copyright(?: page)?', 'contents', 'table of contents', 'index',
      'about the authors?', 'acknowledge?ments?', 'dedication', 'colophon', 'also by\\b.*',
      'glossary', 'bibliography', 'references', 'notes', 'endnotes',
    ].join('|') +
    ')\\s*[.:]?$',
  'i',
)

/** Chapters under this many words are too thin to review. Null = unknown → allowed. */
export const MIN_REVIEW_WORDS = 800

/**
 * Whether a chapter row offers "Review". False for front/back matter (by title) and for chapters
 * with fewer than {@link MIN_REVIEW_WORDS} words. A chapter that already HAS a review still shows
 * "✓ Reviewed →" — callers check that first.
 */
export function isReviewableChapter(chapter: { title: string; wordCount?: number | null }): boolean {
  if (SERVICE_TITLE.test(chapter.title.trim())) return false
  return chapter.wordCount == null || chapter.wordCount >= MIN_REVIEW_WORDS
}
