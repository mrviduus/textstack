/**
 * What an insight is *about*, as a label — the one decision both clients were
 * making separately.
 *
 * Returns `null` for a book-level insight, because the words for that are a
 * translated string ("This book") and this package holds no strings. The caller
 * supplies them; what it must not do is re-derive the rest.
 *
 * Two things are easy to get wrong here, and both were, once:
 *
 * **Never the chapter number.** `chapterNumber` is what the server orders by, but
 * it is not a display ordinal and never was: on production every edition starts
 * at 0 while four uploaded books start at 2, and the two clients compensate
 * differently — a catalog screen renders `chapterNumber + 1`, an upload renders
 * it as-is. Printing it reads one off the table of contents on exactly one of
 * them. The title is what identifies a chapter to a reader anyway.
 *
 * **Fall back to the slug, do not drop the row.** A re-ingest can rename a
 * chapter, and then the slug this insight was keyed on resolves to nothing and
 * the server returns a null title. The conclusion is still worth reading; it just
 * cannot be placed. Showing the raw slug is worse than a title and much better
 * than silence.
 */
export interface InsightScopeInput {
  chapterSlug: string | null
  chapterTitle: string | null
}

export function insightChapterLabel(insight: InsightScopeInput): string | null {
  if (insight.chapterSlug === null) return null
  return insight.chapterTitle ?? insight.chapterSlug
}
