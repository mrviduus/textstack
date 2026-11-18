/**
 * Chapter review — the chapter-row gate (PR 3, ADR-016). Kept out of `chapterReview.ts` (the brief builders) on purpose.
 */
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
